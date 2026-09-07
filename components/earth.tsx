'use client';
/* oxlint-disable react/react-compiler -- The React Compiler transform is not installed; mutable refs intentionally own Cesium objects outside React. */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type * as Cesium from 'cesium';
import { useCampingMarkers } from '@/hooks/use-camping-markers';
import type { CampMarker } from '@/lib/camping-model';
import { RADIO_COLORS, type RadioMarker } from '@/lib/radio-model';
import {
  boundedCoverageBytes,
  coverageTileStatus,
  type CoverageSelection,
} from '@/lib/coverage-model';
import { parkMayPick, parkTileAddress, type ParkKind } from '@/lib/park-model';
import { paintParkTile } from '@/lib/park-render';
import type { ParkSelection } from '@/hooks/use-parks';
import { installOrbitControls } from '@/lib/camera-controls';
import type { AddressPoint } from '@/lib/land-model';
import {
  makeSatellite,
  orbitPosition,
  predictedTrack,
  epochTime,
} from '@/lib/orbits';
import { LAYERS, MAP_FALLBACK, type LayerId } from '@/lib/map-layers';
import type {
  CameraView,
  Bounds,
  OMM,
  Track,
  ParcelSnapshot,
} from '@/lib/model';
export type { CameraView } from '@/lib/model';
export type Pick = {
  kind:
    | 'satellite'
    | 'aircraft'
    | 'ships'
    | 'parcel'
    | 'address'
    | 'radio'
    | 'cells'
    | 'camping'
    | 'search';
  id: string;
  location?: { lat: number; lon: number };
};
export type EarthHandle = {
  flyTo: (p: CameraView) => void;
  zoom: (direction: number) => void;
  north: () => void;
  home: () => void;
  bounds: () => Bounds | null;
  focus: (id: string) => void;
};
type Props = {
  campingMarkers?: CampMarker[];
  campingVisible?: boolean;
  onCampingError?: (message: string) => void;
  searchLocation?: { name: string; lat: number; lon: number } | null;
  onView: (v: CameraView) => void;
  onPick?: (p: Pick) => void;
  orbits?: OMM[];
  spaceVisible?: boolean;
  tracks?: Track[];
  parcels?: ParcelSnapshot | null;
  parcelsVisible?: boolean;
  addresses?: AddressPoint[];
  addressesVisible?: boolean;
  selectedAddress?: AddressPoint | null;
  onAnchor?: (position: { x: number; y: number } | null) => void;
  selected?: Pick | null;
  layer?: LayerId;
  labels?: boolean;
  scrollSensitivity?: number;
  offsetMinutes?: number;
  orbitPaths?: boolean;
  radioMarkers?: RadioMarker[];
  radioVisible?: boolean;
  cellMarkers?: RadioMarker[];
  cellVisible?: boolean;
  coverage?: CoverageSelection | null;
  coverageOpacity?: number;
  onCoverageStatus?: (message: string) => void;
  nationalParks?: ParkSelection | null;
  stateParks?: ParkSelection | null;
  onParkStatus?: (kind: ParkKind, message: string, failed?: boolean) => void;
  onParkPick?: (location: { lat: number; lon: number }) => void;
};
function useParkImagery(
  kind: ParkKind,
  selection: ParkSelection | null,
  ready: number,
  api: RefObject<typeof Cesium | null>,
  viewer: RefObject<Cesium.Viewer | null>,
  labels: RefObject<Cesium.ImageryLayer | null>,
  report: RefObject<Props['onParkStatus']>,
) {
  useEffect(() => {
    const C = api.current,
      v = viewer.current;
    if (!selection || !ready || !C || !v) return;
    let disposed = false,
      active = 0,
      failed = false;
    const { archive, layer } = selection;
    const provider = new C.UrlTemplateImageryProvider({
      url: '/parks/prepared/{z}/{x}/{y}',
      minimumLevel: 0,
      maximumLevel: 18,
      tilingScheme: new C.WebMercatorTilingScheme(),
      credit: layer.source.attribution,
      enablePickFeatures: false,
    });
    report.current?.(kind, 'Loading park boundaries for this view…');
    provider.requestImage = (x, y, z) => {
      if (disposed || archive.controller.signal.aborted || active >= 4)
        return undefined;
      active++;
      const source = parkTileAddress(z, x, y, layer.maxZoom);
      return archive
        .tile(source.z, source.x, source.y)
        .then((tile) => {
          if (disposed) throw new DOMException('Cancelled', 'AbortError');
          for (const f of tile.polygons)
            if (!selection.records.has(f.id))
              throw new Error('Park tile refers to an unknown source record.');
          const canvas = paintParkTile(
            document.createElement('canvas'),
            tile,
            kind,
            z,
            x,
            y,
            layer.maxZoom,
          );
          if (!failed)
            report.current?.(
              kind,
              'Prepared park boundaries enabled. Zoom closer for small parks.',
            );
          return canvas;
        })
        .catch((e) => {
          if (!disposed && !archive.controller.signal.aborted) {
            failed = true;
            report.current?.(
              kind,
              `${e instanceof Error ? e.message : 'Park tiles could not load.'} Reload park layers to retry.`,
              true,
            );
          }
          throw e;
        })
        .finally(() => {
          active--;
          if (!v.isDestroyed()) v.scene.requestRender();
        });
    };
    const labelIndex =
      labels.current && v.imageryLayers.contains(labels.current)
        ? v.imageryLayers.indexOf(labels.current)
        : v.imageryLayers.length;
    const imagery = v.imageryLayers.addImageryProvider(provider, labelIndex);
    v.scene.requestRender();
    return () => {
      disposed = true;
      if (!v.isDestroyed() && v.imageryLayers.contains(imagery)) {
        v.imageryLayers.remove(imagery, true);
        v.scene.requestRender();
      }
    };
  }, [kind, selection, ready, api, viewer, labels, report]);
}
function useSourceMarkers(
  kind: 'radio' | 'cells',
  markers: RadioMarker[],
  enabled: boolean,
  ready: number,
  api: RefObject<typeof Cesium | null>,
  viewer: RefObject<Cesium.Viewer | null>,
  report: (message: string) => void,
) {
  useEffect(() => {
    const C = api.current,
      v = viewer.current;
    if (!enabled || !ready || !C || !v) return;
    const source = new C.CustomDataSource(
      kind === 'cells' ? 'Estimated cell locations' : 'Radio source records',
    );
    source.show = enabled;
    const credit =
      kind === 'cells'
        ? new C.Credit(
            '<a href="https://opencellid.org/">OpenCellID</a> contributors · <a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a>',
            true,
          )
        : null;
    if (credit) v.creditDisplay.addStaticCredit(credit);
    let disposed = false;
    void v.dataSources
      .add(source)
      .then(() => {
        if (disposed && !v.isDestroyed() && v.dataSources.contains(source))
          v.dataSources.remove(source, true);
      })
      .catch(() => {
        if (!disposed)
          report(
            `${kind === 'cells' ? 'Cell' : 'Radio'} map symbols could not be initialized. Reload to retry.`,
          );
      });
    for (const p of markers) {
      const color = kind === 'cells' ? '#f596bf' : RADIO_COLORS[p.category];
      const shift =
        kind === 'cells'
          ? 8
          : p.category === 'transmitters'
            ? -10
            : p.category === 'receivers'
              ? 10
              : 0;
      source.entities.add({
        id: `${kind}:${p.id}`,
        properties: { openviewKind: kind, openviewId: p.id },
        position: C.Cartesian3.fromDegrees(p.lon, p.lat),
        billboard: {
          image: sourceMarkerImage(kind, p.category),
          width: p.count > 1 ? 24 : 18,
          height: p.count > 1 ? 24 : 18,
          heightReference: C.HeightReference.CLAMP_TO_GROUND,
          verticalOrigin: C.VerticalOrigin.BOTTOM,
          pixelOffset: new C.Cartesian2(shift, -2),
          disableDepthTestDistance: 1000,
        },
        label: {
          text: p.count > 1 ? p.count.toLocaleString() : '',
          font: 'bold 13px Arial',
          fillColor: C.Color.fromCssColorString(color),
          outlineColor: C.Color.fromCssColorString('#071e2b'),
          outlineWidth: 3,
          style: C.LabelStyle.FILL_AND_OUTLINE,
          heightReference: C.HeightReference.CLAMP_TO_GROUND,
          pixelOffset: new C.Cartesian2(shift, -35),
          disableDepthTestDistance: 1000,
        },
      });
    }
    v.scene.requestRender();
    return () => {
      disposed = true;
      if (!v.isDestroyed() && credit)
        v.creditDisplay.removeStaticCredit(credit);
      if (!v.isDestroyed() && v.dataSources.contains(source))
        v.dataSources.remove(source, true);
    };
  }, [kind, ready, markers, enabled, api, viewer, report]);
}
const SOURCE_MARKER_IMAGES = new Map<string, string>();
function sourceMarkerImage(
  kind: 'radio' | 'cells',
  category: RadioMarker['category'],
) {
  const key = `${kind}:${category}`;
  const cached = SOURCE_MARKER_IMAGES.get(key);
  if (cached) return cached;
  const color = kind === 'cells' ? '#f596bf' : RADIO_COLORS[category];
  const shape =
    kind === 'cells'
      ? '<circle cx="14" cy="14" r="10"/>'
      : category === 'transmitters'
        ? '<path d="M14 3 25 25H3Z"/>'
        : category === 'candidates'
          ? '<path d="M14 2 26 14 14 26 2 14Z"/>'
          : '<rect x="4" y="4" width="20" height="20" rx="3"/>';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><g fill="${color}" stroke="#071e2b" stroke-width="2">${shape}</g></svg>`;
  const image = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  SOURCE_MARKER_IMAGES.set(key, image);
  return image;
}
const HOME = { lat: 20, lon: -25, height: 19000000 };
const EMPTY_CAMPING: CampMarker[] = [];
const EMPTY_ORBITS: OMM[] = [],
  EMPTY_TRACKS: Track[] = [],
  EMPTY_ADDRESSES: AddressPoint[] = [],
  EMPTY_RADIO: RadioMarker[] = [];
const Earth = forwardRef<EarthHandle, Props>(function Earth(
  {
    searchLocation = null,
    onView,
    onPick,
    orbits = EMPTY_ORBITS,
    spaceVisible = true,
    tracks = EMPTY_TRACKS,
    parcels = null,
    parcelsVisible = true,
    addresses = EMPTY_ADDRESSES,
    addressesVisible = false,
    selectedAddress = null,
    onAnchor,
    selected,
    layer = 'satellite',
    labels = false,
    scrollSensitivity = 1,
    offsetMinutes = 0,
    orbitPaths = true,
    radioMarkers = EMPTY_RADIO,
    radioVisible = false,
    cellMarkers = EMPTY_RADIO,
    cellVisible = false,
    campingMarkers = EMPTY_CAMPING,
    campingVisible = false,
    onCampingError,
    coverage = null,
    coverageOpacity = 0.45,
    onCoverageStatus,
    nationalParks = null,
    stateParks = null,
    onParkStatus,
    onParkPick,
  },
  ref,
) {
  const container = useRef<HTMLDivElement>(null),
    api = useRef<typeof Cesium | null>(null),
    viewer = useRef<Cesium.Viewer | null>(null),
    viewCallback = useRef(onView),
    pickCallback = useRef(onPick),
    offset = useRef(offsetMinutes),
    spaceVisibility = useRef(spaceVisible),
    parcelVisibility = useRef(parcelsVisible),
    addressVisibility = useRef(addressesVisible),
    coverageAlpha = useRef(coverageOpacity),
    anchorCallback = useRef(onAnchor),
    addressSelection = useRef(selectedAddress),
    flight = useRef(0);
  const fallbackImagery = useRef<Cesium.ImageryLayer | null>(null),
    baseImagery = useRef<Cesium.ImageryLayer | null>(null),
    labelImagery = useRef<Cesium.ImageryLayer | null>(null),
    coverageImagery = useRef<Cesium.ImageryLayer[]>([]),
    coverageStatus = useRef(onCoverageStatus);
  coverageStatus.current = onCoverageStatus;
  const parkStatus = useRef(onParkStatus),
    parkPick = useRef(onParkPick);
  parkStatus.current = onParkStatus;
  parkPick.current = onParkPick;
  const orbitSource = useRef<Cesium.CustomDataSource | null>(null),
    trackSource = useRef<Cesium.CustomDataSource | null>(null),
    parcelSource = useRef<Cesium.CustomDataSource | null>(null),
    addressSource = useRef<Cesium.CustomDataSource | null>(null),
    pathEntity = useRef<Cesium.Entity | null>(null);
  useEffect(() => {
    viewCallback.current = onView;
    pickCallback.current = onPick;
    offset.current = offsetMinutes;
    spaceVisibility.current = spaceVisible;
    parcelVisibility.current = parcelsVisible;
    addressVisibility.current = addressesVisible;
    coverageAlpha.current = coverageOpacity;
    anchorCallback.current = onAnchor;
    addressSelection.current = selectedAddress;
  }, [
    onView,
    onPick,
    offsetMinutes,
    spaceVisible,
    parcelsVisible,
    addressesVisible,
    coverageOpacity,
    onAnchor,
    selectedAddress,
  ]);
  const [error, setError] = useState(''),
    [ready, setReady] = useState(0),
    [mapWarning, setMapWarning] = useState(''),
    [terrainWarning, setTerrainWarning] = useState('');
  useEffect(() => {
    const C = api.current,
      v = viewer.current;
    if (!C || !v || !ready || !searchLocation) return;
    const entity = v.entities.add({
      id: 'openview-search-location',
      position: C.Cartesian3.fromDegrees(
        searchLocation.lon,
        searchLocation.lat,
      ),
      properties: { openviewKind: 'search', openviewId: 'selected' },
      point: {
        pixelSize: 10,
        color: C.Color.WHITE,
        outlineColor: C.Color.fromCssColorString('#18252e'),
        outlineWidth: 3,
        heightReference: C.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: searchLocation.name,
        font: '13px sans-serif',
        fillColor: C.Color.WHITE,
        outlineColor: C.Color.BLACK,
        outlineWidth: 3,
        style: C.LabelStyle.FILL_AND_OUTLINE,
        heightReference: C.HeightReference.CLAMP_TO_GROUND,
        pixelOffset: new C.Cartesian2(0, -24),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    v.scene.requestRender();
    return () => {
      if (!v.isDestroyed()) {
        v.entities.remove(entity);
        v.scene.requestRender();
      }
    };
  }, [ready, searchLocation]);
  useParkImagery(
    'national',
    nationalParks,
    ready,
    api,
    viewer,
    labelImagery,
    parkStatus,
  );
  useParkImagery(
    'state',
    stateParks,
    ready,
    api,
    viewer,
    labelImagery,
    parkStatus,
  );
  useSourceMarkers(
    'radio',
    radioMarkers,
    radioVisible,
    ready,
    api,
    viewer,
    setMapWarning,
  );
  useSourceMarkers(
    'cells',
    cellMarkers,
    cellVisible,
    ready,
    api,
    viewer,
    setMapWarning,
  );
  useCampingMarkers(
    campingMarkers,
    campingVisible,
    ready,
    api,
    viewer,
    onCampingError || setMapWarning,
  );
  function flyTo(p: CameraView) {
    const C = api.current,
      v = viewer.current;
    if (C && v) {
      v.trackedEntity = undefined;
      const generation = ++flight.current;
      const go = (height: number) => {
        if (v.isDestroyed() || generation !== flight.current) return;
        const pivot = C.Cartesian3.fromDegrees(p.lon, p.lat, height);
        v.camera.flyToBoundingSphere(new C.BoundingSphere(pivot, 0), {
          duration: 1.8,
          offset: new C.HeadingPitchRange(
            C.Math.toRadians(p.heading ?? 0),
            C.Math.toRadians(p.pitch ?? -90),
            Math.max(20, p.height),
          ),
        });
      };
      if (p.height < 100000) {
        const target = C.Cartographic.fromDegrees(p.lon, p.lat);
        if (v.terrainProvider.availability) {
          let timeout: ReturnType<typeof setTimeout>;
          const fallback = new Promise<number>((resolve) => {
            timeout = setTimeout(
              () =>
                resolve(
                  v.isDestroyed() ? 0 : v.scene.globe.getHeight(target) || 0,
                ),
              2000,
            );
          });
          void Promise.race([
            C.sampleTerrainMostDetailed(v.terrainProvider, [target])
              .then((points) => points[0].height || 0)
              .catch(() =>
                v.isDestroyed() ? 0 : v.scene.globe.getHeight(target) || 0,
              ),
            fallback,
          ]).then((height) => {
            clearTimeout(timeout);
            go(height);
          });
        } else go(v.scene.globe.getHeight(target) || 0);
      } else go(0);
    }
  }
  function bounds(): Bounds | null {
    const C = api.current,
      v = viewer.current;
    if (!C || !v) return null;
    if (v.camera.positionCartographic.height < 100000) {
      const hits: { lat: number; lon: number }[] = [];
      for (const x of [0, 0.25, 0.5, 0.75, 1])
        for (const y of [0, 0.25, 0.5, 0.75, 1]) {
          const ray = v.camera.getPickRay(
            new C.Cartesian2(
              x * v.canvas.clientWidth,
              y * v.canvas.clientHeight,
            ),
          );
          const point = ray ? v.scene.globe.pick(ray, v.scene) : undefined;
          if (point) {
            const cart = C.Cartographic.fromCartesian(point);
            hits.push({
              lat: C.Math.toDegrees(cart.latitude),
              lon: C.Math.toDegrees(cart.longitude),
            });
          }
        }
      if (hits.length >= 4) {
        const result = {
          west: Math.min(...hits.map((p) => p.lon)),
          east: Math.max(...hits.map((p) => p.lon)),
          south: Math.min(...hits.map((p) => p.lat)),
          north: Math.max(...hits.map((p) => p.lat)),
        };
        return result;
      }
    }
    const r = v.camera.computeViewRectangle();
    return r
      ? {
          west: C.Math.toDegrees(r.west),
          south: C.Math.toDegrees(r.south),
          east: C.Math.toDegrees(r.east),
          north: C.Math.toDegrees(r.north),
        }
      : null;
  }
  useImperativeHandle(
    ref,
    () => ({
      flyTo,
      bounds,
      home: () => flyTo(HOME),
      focus: (id) => {
        const C = api.current,
          v = viewer.current;
        const entity =
          orbitSource.current?.entities.getById(id) ||
          trackSource.current?.entities.getById(id);
        if (C && v && entity) {
          const p = entity.position?.getValue(v.clock.currentTime);
          if (p) {
            const geo = C.Cartographic.fromCartesian(p);
            flyTo({
              lon: C.Math.toDegrees(geo.longitude),
              lat: C.Math.toDegrees(geo.latitude),
              height: Math.max(geo.height + 1500000, 300000),
            });
          }
        }
      },
      zoom: (d) => {
        flight.current++;
        viewer.current?.camera.cancelFlight();
        const v = viewer.current;
        if (v) {
          const C = api.current!;
          const ray = v.camera.getPickRay(
            new C.Cartesian2(
              v.canvas.clientWidth / 2,
              v.canvas.clientHeight / 2,
            ),
          );
          const point = ray ? v.scene.globe.pick(ray, v.scene) : undefined;
          const range = point
            ? C.Cartesian3.distance(v.camera.positionWC, point)
            : v.camera.positionCartographic.height;
          v.camera.zoomIn(
            Math.max(1, Math.min(range * 0.35, Math.max(0, range - 15))) * d,
          );
          v.scene.requestRender();
        }
      },
      north: () => {
        flight.current++;
        const v = viewer.current;
        if (v)
          v.camera.flyTo({
            destination: v.camera.position,
            orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
            duration: 0.8,
          });
      },
    }),
    [],
  );
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let releaseControls: (() => void) | undefined,
      releaseFlightInput: (() => void) | undefined;
    void (async () => {
      try {
        (window as Window & { CESIUM_BASE_URL?: string }).CESIUM_BASE_URL =
          '/cesium/';
        const C = await import('cesium');
        if (disposed || !container.current) return;
        api.current = C;
        C.Ion.defaultAccessToken = '';
        const v = new C.Viewer(container.current, {
          baseLayer: false,
          baseLayerPicker: false,
          geocoder: false,
          homeButton: false,
          sceneModePicker: false,
          navigationHelpButton: false,
          animation: false,
          timeline: false,
          fullscreenButton: false,
          infoBox: false,
          selectionIndicator: false,
          requestRenderMode: true,
          maximumRenderTimeChange: Infinity,
          skyBox: false,
        });
        viewer.current = v;
        const cancelPending = () => {
          flight.current++;
          v.camera.cancelFlight();
        };
        v.canvas.addEventListener('pointerdown', cancelPending, {
          passive: true,
        });
        v.canvas.addEventListener('wheel', cancelPending, { passive: true });
        releaseFlightInput = () => {
          v.canvas.removeEventListener('pointerdown', cancelPending);
          v.canvas.removeEventListener('wheel', cancelPending);
        };
        v.scene.backgroundColor = C.Color.fromCssColorString('#080d13');
        v.scene.globe.baseColor = C.Color.fromCssColorString('#182934');
        v.scene.globe.enableLighting = false;
        fallbackImagery.current = v.imageryLayers.addImageryProvider(
          new C.UrlTemplateImageryProvider({
            url: MAP_FALLBACK.url,
            maximumLevel: MAP_FALLBACK.max,
            tilingScheme: new C.GeographicTilingScheme(),
            hasAlphaChannel: false,
            enablePickFeatures: false,
            credit: MAP_FALLBACK.credit,
          }),
          0,
        );
        v.resolutionScale = 1;
        v.targetFrameRate = 30;
        releaseControls = installOrbitControls(C, v);
        v.scene.screenSpaceCameraController.maximumZoomDistance = 70000000;
        void C.ArcGISTiledElevationTerrainProvider.fromUrl(
          'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer',
        )
          .then((provider) => {
            if (!disposed && !v.isDestroyed()) {
              v.terrainProvider = provider;
              v.scene.globe.maximumScreenSpaceError = 1.5;
              v.scene.requestRender();
              report();
            }
          })
          .catch(() => {
            if (!disposed)
              setTerrainWarning(
                'Elevation data could not load. Reload to retry the terrain connection.',
              );
          });
        v.camera.setView({
          destination: C.Cartesian3.fromDegrees(
            HOME.lon,
            HOME.lat,
            HOME.height,
          ),
        });
        v.camera.percentageChanged = 0.05;
        const report = () => {
          const center = new C.Cartesian2(
            v.canvas.clientWidth / 2,
            v.canvas.clientHeight / 2,
          );
          const ray = v.camera.getPickRay(center);
          const point = ray
            ? (v.scene.globe.pick(ray, v.scene) ??
              v.camera.pickEllipsoid(center))
            : undefined;
          const p = point
            ? C.Cartographic.fromCartesian(point)
            : v.camera.positionCartographic;
          viewCallback.current({
            lat: C.Math.toDegrees(p.latitude),
            lon: C.Math.toDegrees(p.longitude),
            height: Math.max(
              10,
              v.camera.positionCartographic.height -
                (v.scene.globe.getHeight(v.camera.positionCartographic) ?? 0),
            ),
            heading: C.Math.toDegrees(v.camera.heading),
            pitch: C.Math.toDegrees(v.camera.pitch),
          });
        };
        v.camera.changed.addEventListener(report);
        v.camera.moveEnd.addEventListener(report);
        report();
        let lastAnchor = '';
        v.scene.postRender.addEventListener(() => {
          const selected = addressSelection.current;
          if (!selected) {
            if (lastAnchor) {
              lastAnchor = '';
              anchorCallback.current?.(null);
            }
            return;
          }
          const cart = C.Cartographic.fromDegrees(selected.lon, selected.lat),
            point = C.Cartesian3.fromRadians(
              cart.longitude,
              cart.latitude,
              (v.scene.globe.getHeight(cart) || 0) + 2,
            );
          const visible = new C.Occluder(
            new C.BoundingSphere(
              C.Cartesian3.ZERO,
              C.Ellipsoid.WGS84.minimumRadius,
            ),
            v.camera.positionWC,
          ).isPointVisible(point);
          const screen = visible
            ? C.SceneTransforms.worldToWindowCoordinates(v.scene, point)
            : undefined;
          const anchor =
            screen &&
            screen.x > 0 &&
            screen.y > 0 &&
            screen.x < v.canvas.clientWidth &&
            screen.y < v.canvas.clientHeight
              ? { x: Math.round(screen.x), y: Math.round(screen.y) }
              : null;
          const key = anchor
            ? `${selected.id}:${anchor.x},${anchor.y}`
            : `${selected.id}:offscreen`;
          if (key !== lastAnchor) {
            lastAnchor = key;
            anchorCallback.current?.(anchor);
          }
        });
        v.screenSpaceEventHandler.setInputAction(
          (click: { position: Cesium.Cartesian2 }) => {
            const picked = v.scene.pick(click.position);
            const entity = picked?.id as Cesium.Entity | undefined;
            const props = entity?.properties?.getValue(v.clock.currentTime);
            const ray = v.camera.getPickRay(click.position),
              point = ray ? v.scene.globe.pick(ray, v.scene) : undefined,
              cart = point ? C.Cartographic.fromCartesian(point) : undefined;
            if (props?.openviewKind && props.openviewId)
              pickCallback.current?.({
                kind: props.openviewKind,
                id: props.openviewId,
                location: cart
                  ? {
                      lat: C.Math.toDegrees(cart.latitude),
                      lon: C.Math.toDegrees(cart.longitude),
                    }
                  : undefined,
              });
            // Parks are imagery, so they cannot intercept existing entity hits.
            // Resolve the prepared park polygon only after existing pick handling.
            if (cart && parkMayPick(props?.openviewKind))
              parkPick.current?.({
                lat: C.Math.toDegrees(cart.latitude),
                lon: C.Math.toDegrees(cart.longitude),
              });
          },
          C.ScreenSpaceEventType.LEFT_CLICK,
        );
        v.screenSpaceEventHandler.removeInputAction(
          C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
        );
        v.scene.renderError.addEventListener((_s: unknown, e: Error) =>
          setError(e.message),
        );
        timer = setInterval(() => {
          if (!document.hidden && viewer.current && !v.isDestroyed()) {
            v.clock.currentTime = C.JulianDate.fromDate(new Date());
            v.scene.requestRender();
          }
        }, 250);
        setReady((generation) => generation + 1);
      } catch (e) {
        if (!disposed)
          setError(
            e instanceof Error ? e.message : 'Unable to initialize the globe.',
          );
      }
    })();
    return () => {
      disposed = true;
      clearInterval(timer);
      releaseControls?.();
      releaseFlightInput?.();
      if (viewer.current && !viewer.current.isDestroyed())
        viewer.current.destroy();
      viewer.current = null;
      fallbackImagery.current = null;
      baseImagery.current = null;
      labelImagery.current = null;
    };
  }, []);
  useEffect(() => {
    if (ready && viewer.current)
      viewer.current.scene.screenSpaceCameraController.zoomFactor =
        5 * scrollSensitivity;
  }, [ready, scrollSensitivity]);
  useEffect(() => {
    const C = api.current,
      v = viewer.current;
    if (!ready || !C || !v) return;
    setMapWarning('');
    const config = LAYERS.find((l) => l.id === layer)!;
    const provider = new C.UrlTemplateImageryProvider({
      url: config.url,
      maximumLevel: config.max,
      credit: config.credit,
      enablePickFeatures: false,
      tileDiscardPolicy: config.missingTileUrl
        ? new C.DiscardMissingTileImagePolicy({
            missingImageUrl: config.missingTileUrl,
            pixelsToCheck: [
              new C.Cartesian2(0, 0),
              new C.Cartesian2(200, 20),
              new C.Cartesian2(20, 200),
              new C.Cartesian2(80, 110),
              new C.Cartesian2(160, 130),
            ],
            disableCheckIfAllPixelsAreTransparent: true,
          })
        : undefined,
    });
    let failures = 0;
    provider.errorEvent.addEventListener(() => {
      if (++failures === 3)
        setMapWarning(
          'High-detail imagery is unavailable here. Showing the closest lower-resolution map.',
        );
    });
    const previous =
        baseImagery.current && v.imageryLayers.contains(baseImagery.current)
          ? baseImagery.current
          : null,
      fallbackIndex =
        fallbackImagery.current &&
        v.imageryLayers.contains(fallbackImagery.current)
          ? v.imageryLayers.indexOf(fallbackImagery.current)
          : -1,
      insertionIndex = previous
        ? v.imageryLayers.indexOf(previous) + 1
        : fallbackIndex + 1;
    baseImagery.current = v.imageryLayers.addImageryProvider(
      provider,
      Math.min(v.imageryLayers.length, Math.max(0, insertionIndex)),
    );
    if (previous) v.imageryLayers.remove(previous, true);
    v.scene.requestRender();
  }, [ready, layer]);
  useEffect(() => {
    const C = api.current,
      v = viewer.current;
    if (!ready || !C || !v) return;
    if (labelImagery.current && v.imageryLayers.contains(labelImagery.current))
      v.imageryLayers.remove(labelImagery.current, true);
    labelImagery.current = null;
    if (labels)
      labelImagery.current = v.imageryLayers.addImageryProvider(
        new C.UrlTemplateImageryProvider({
          url: 'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
          maximumLevel: 19,
          credit: 'Place labels © Esri and contributors',
        }),
      );
    v.scene.requestRender();
  }, [ready, labels]);
  useEffect(() => {
    const C = api.current,
      v = viewer.current;
    if (!ready || !C || !v || !coverage) return;
    const controller = new AbortController();
    const cache = new Map<string, Uint8Array<ArrayBuffer>>();
    let cacheBytes = 0,
      active = 0,
      failed = false;
    const transparent = document.createElement('canvas');
    transparent.width = transparent.height = 256;
    const { layer: chosen, index, release } = coverage;
    const layers: Cesium.ImageryLayer[] = [];
    const tileRoot = `/coverage/${release}/${chosen.id}`;
    coverageStatus.current?.('Loading coverage tiles for the imported area…');
    for (const region of chosen.regions) {
      const provider = new C.UrlTemplateImageryProvider({
        url: `${tileRoot}/{z}/{x}/{y}.png`,
        maximumLevel: chosen.tiles.maxZoom,
        minimumLevel: chosen.tiles.minZoom,
        tilingScheme: new C.WebMercatorTilingScheme(),
        rectangle: C.Rectangle.fromDegrees(...region.rectangle),
        credit: chosen.attribution,
      });
      provider.requestImage = (x, y, z) => {
        if (controller.signal.aborted) return undefined;
        const state = coverageTileStatus(index, z, x, y);
        if (state !== 'present') return Promise.resolve(transparent);
        if (active >= 6) return undefined;
        const key = `${z}/${x}/${y}`,
          descriptor = index.present[key];
        active++;
        return (async () => {
          let bytes = cache.get(key);
          if (!bytes) {
            bytes = await boundedCoverageBytes(
              `${tileRoot}/${key}.png`,
              controller.signal,
              descriptor.bytes,
            );
            const hash = Array.from(
              new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
              (b) => b.toString(16).padStart(2, '0'),
            ).join('');
            if (bytes.length !== descriptor.bytes || hash !== descriptor.sha256)
              throw new Error('Coverage tile checksum mismatch.');
            while (cacheBytes + bytes.length > 8 * 1024 * 1024 && cache.size) {
              const oldest = cache.keys().next().value!;
              cacheBytes -= cache.get(oldest)!.length;
              cache.delete(oldest);
            }
            cache.set(key, bytes);
            cacheBytes += bytes.length;
          }
          if (controller.signal.aborted)
            throw new DOMException('Cancelled', 'AbortError');
          // Cesium's ImageryProvider.loadImage also flips ImageBitmap pixels
          // during decode; WebGL cannot apply UNPACK_FLIP_Y to ImageBitmap.
          const image = await createImageBitmap(
            new Blob([bytes], { type: 'image/png' }),
            {
              imageOrientation: 'flipY',
              premultiplyAlpha: 'none',
              colorSpaceConversion: 'none',
            },
          );
          if (controller.signal.aborted) {
            image.close();
            throw new DOMException('Cancelled', 'AbortError');
          }
          if (!failed)
            coverageStatus.current?.(
              'Coverage tiles displayed. Areas outside the imported scope remain unknown.',
            );
          return image;
        })()
          .catch((e) => {
            if (!controller.signal.aborted) {
              failed = true;
              coverageStatus.current?.(
                e instanceof Error
                  ? `${e.message} Reload prepared coverage to retry.`
                  : 'Coverage tiles unavailable. Reload to retry.',
              );
            }
            throw e;
          })
          .finally(() => {
            active--;
            if (!v.isDestroyed()) v.scene.requestRender();
          });
      };
      const baseIndex =
        baseImagery.current && v.imageryLayers.contains(baseImagery.current)
          ? v.imageryLayers.indexOf(baseImagery.current) + 1
          : fallbackImagery.current &&
              v.imageryLayers.contains(fallbackImagery.current)
            ? v.imageryLayers.indexOf(fallbackImagery.current) + 1
            : 0;
      layers.push(
        v.imageryLayers.addImageryProvider(
          provider,
          Math.min(v.imageryLayers.length, baseIndex + layers.length),
        ),
      );
    }
    coverageImagery.current = layers;
    for (const item of layers) item.alpha = coverageAlpha.current;
    v.scene.requestRender();
    return () => {
      controller.abort();
      cache.clear();
      if (!v.isDestroyed())
        for (const item of layers)
          if (v.imageryLayers.contains(item))
            v.imageryLayers.remove(item, true);
      coverageImagery.current = [];
    };
  }, [ready, coverage]);
  useEffect(() => {
    for (const item of coverageImagery.current) item.alpha = coverageOpacity;
    viewer.current?.scene.requestRender();
  }, [coverageOpacity]);
  useEffect(() => {
    const C = api.current,
      v = viewer.current;
    if (!ready || !C || !v) return;
    if (orbitSource.current) v.dataSources.remove(orbitSource.current, true);
    const source = new C.CustomDataSource('Predicted satellite positions');
    orbitSource.current = source;
    source.show = spaceVisibility.current;
    void v.dataSources
      .add(source)
      .catch(() =>
        setMapWarning(
          'A map overlay could not be initialized. Reload to retry.',
        ),
      );
    for (const omm of orbits) {
      if (Math.abs(Date.now() - epochTime(omm)) > 14 * 86400000) continue;
      let sat;
      try {
        sat = makeSatellite(omm);
      } catch {
        continue;
      }
      const id = String(omm.NORAD_CAT_ID);
      source.entities.add({
        id,
        properties: { openviewKind: 'satellite', openviewId: id },
        position: new C.CallbackPositionProperty((_time, result) => {
          const p = orbitPosition(
            sat,
            new Date(Date.now() + offset.current * 60000),
          );
          return p
            ? C.Cartesian3.fromDegrees(
                p.lon,
                p.lat,
                p.altitude,
                C.Ellipsoid.WGS84,
                result,
              )
            : undefined;
        }, false),
        point: {
          pixelSize: id === selected?.id ? 12 : 7,
          color: C.Color.fromCssColorString('#c3ed97'),
          outlineColor: C.Color.fromCssColorString('#263a25'),
          outlineWidth: 2,
        },
        label: {
          text: omm.OBJECT_NAME,
          show: id === selected?.id,
          font: '13px sans-serif',
          fillColor: C.Color.WHITE,
          showBackground: true,
          backgroundColor: C.Color.fromCssColorString('#101820db'),
          pixelOffset: new C.Cartesian2(13, -12),
          horizontalOrigin: C.HorizontalOrigin.LEFT,
        },
      });
    }
    v.scene.requestRender();
    return () => {
      if (!v.isDestroyed()) v.dataSources.remove(source, true);
      if (orbitSource.current === source) orbitSource.current = null;
    };
  }, [ready, orbits, selected?.id]);
  useEffect(() => {
    if (orbitSource.current) orbitSource.current.show = spaceVisible;
    viewer.current?.scene.requestRender();
  }, [spaceVisible]);
  useEffect(() => {
    const C = api.current,
      v = viewer.current;
    if (!ready || !C || !v) return;
    const draw = () => {
      if (pathEntity.current) v.entities.remove(pathEntity.current);
      pathEntity.current = null;
      const omm = orbits.find((o) => String(o.NORAD_CAT_ID) === selected?.id);
      if (
        !spaceVisible ||
        !orbitPaths ||
        selected?.kind !== 'satellite' ||
        !omm ||
        Math.abs(Date.now() - epochTime(omm)) > 14 * 86400000
      )
        return;
      let sat;
      try {
        sat = makeSatellite(omm);
      } catch {
        return;
      }
      const period = Math.min(180, 1440 / omm.MEAN_MOTION);
      const positions = [];
      for (let i = 0; i <= 180; i++) {
        const p = orbitPosition(
          sat,
          new Date(Date.now() + (offset.current + (i * period) / 180) * 60000),
        );
        if (p)
          positions.push(C.Cartesian3.fromDegrees(p.lon, p.lat, p.altitude));
      }
      if (positions.length > 1)
        pathEntity.current = v.entities.add({
          polyline: {
            positions,
            width: 1.8,
            material: C.Color.fromCssColorString('#c3ed9799'),
            arcType: C.ArcType.NONE,
          },
        });
      v.scene.requestRender();
    };
    draw();
    const timer = setInterval(draw, 60000);
    return () => {
      clearInterval(timer);
      if (!v.isDestroyed() && pathEntity.current)
        v.entities.remove(pathEntity.current);
      pathEntity.current = null;
    };
  }, [ready, orbits, selected, offsetMinutes, spaceVisible, orbitPaths]);
  useEffect(() => {
    const C = api.current,
      v = viewer.current;
    if (!ready || !C || !v) return;
    if (trackSource.current) v.dataSources.remove(trackSource.current, true);
    const source = new C.CustomDataSource('Reported traffic');
    trackSource.current = source;
    void v.dataSources
      .add(source)
      .catch(() =>
        setMapWarning(
          'A map overlay could not be initialized. Reload to retry.',
        ),
      );
    const icon = (kind: string) => {
      const canvas = document.createElement('canvas');
      canvas.width = 40;
      canvas.height = 40;
      const ctx = canvas.getContext('2d')!;
      ctx.font = '30px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = kind === 'aircraft' ? '#8fceff' : '#ffbd86';
      ctx.shadowColor = '#000';
      ctx.shadowBlur = 3;
      ctx.fillText(kind === 'aircraft' ? '✈' : '◆', 20, 20);
      return canvas;
    };
    const plane = icon('aircraft'),
      ship = icon('ships');
    for (const track of tracks) {
      const id = `${track.kind}-${track.id}`;
      source.entities.add({
        id,
        properties: { openviewKind: track.kind, openviewId: track.id },
        position: new C.CallbackPositionProperty((_t, result) => {
          const p = predictedTrack(track, Date.now());
          return C.Cartesian3.fromDegrees(
            p.lon,
            p.lat,
            p.altitude,
            C.Ellipsoid.WGS84,
            result,
          );
        }, false),
        billboard: {
          image: track.kind === 'aircraft' ? plane : ship,
          width: track.kind === 'aircraft' ? 23 : 16,
          height: track.kind === 'aircraft' ? 23 : 16,
          rotation:
            track.kind === 'aircraft'
              ? C.Math.toRadians(90 - (track.heading ?? 0))
              : 0,
          color: new C.CallbackProperty(
            () =>
              Date.now() - track.observedAt >
              (track.kind === 'aircraft' ? 60000 : 600000)
                ? C.Color.WHITE.withAlpha(0.45)
                : C.Color.WHITE,
            false,
          ),
        },
        label: {
          text: track.name,
          show: selected?.id === track.id && selected.kind === track.kind,
          font: '13px sans-serif',
          fillColor: C.Color.WHITE,
          showBackground: true,
          pixelOffset: new C.Cartesian2(14, -12),
          horizontalOrigin: C.HorizontalOrigin.LEFT,
        },
      });
    }
    v.scene.requestRender();
    return () => {
      if (!v.isDestroyed()) v.dataSources.remove(source, true);
      if (trackSource.current === source) trackSource.current = null;
    };
  }, [ready, tracks, selected]);
  useEffect(() => {
    const C = api.current,
      v = viewer.current;
    if (!ready || !C || !v) return;
    if (parcelSource.current) {
      v.dataSources.remove(parcelSource.current, true);
      parcelSource.current = null;
    }
    if (!parcels) return;
    const ds = new C.CustomDataSource('U.S. parcel boundaries');
    parcelSource.current = ds;
    ds.show = parcelVisibility.current;
    void v.dataSources
      .add(ds)
      .catch(() =>
        setMapWarning(
          'A map overlay could not be initialized. Reload to retry.',
        ),
      );
    const rendered = new Set<string>();
    for (const f of parcels.data.features) {
      const polygons =
        f.geometry.type === 'Polygon'
          ? [f.geometry.coordinates as number[][][]]
          : (f.geometry.coordinates as number[][][][]);
      for (let p = 0; p < polygons.length; p++) {
        const rings = polygons[p];
        if (!rings.length) continue;
        const geometryKey = JSON.stringify(rings);
        if (rendered.has(geometryKey)) continue;
        rendered.add(geometryKey);
        const positions = (ring: number[][]) =>
          C.Cartesian3.fromDegreesArray(
            ring.flatMap((point) => [point[0], point[1]]),
          );
        const properties = { openviewKind: 'parcel', openviewId: f.id };
        ds.entities.add({
          id: `${f.id}:fill:${p}`,
          properties,
          polygon: {
            hierarchy: new C.PolygonHierarchy(
              positions(rings[0]),
              rings
                .slice(1)
                .map((ring) => new C.PolygonHierarchy(positions(ring))),
            ),
            material: C.Color.fromCssColorString('#ffd36e').withAlpha(0.055),
            heightReference: C.HeightReference.CLAMP_TO_GROUND,
            classificationType: C.ClassificationType.TERRAIN,
            zIndex: 1,
          },
        });
        rings.forEach((ring, r) =>
          ds.entities.add({
            id: `${f.id}:ring:${p}:${r}`,
            properties,
            polyline: {
              positions: positions(ring),
              clampToGround: true,
              width: 3,
              material: new C.PolylineOutlineMaterialProperty({
                color: C.Color.fromCssColorString('#ffe39a'),
                outlineColor: C.Color.fromCssColorString('#3b2c14'),
                outlineWidth: 1,
              }),
              classificationType: C.ClassificationType.TERRAIN,
              zIndex: 3,
            },
          }),
        );
      }
    }
    v.scene.requestRender();
    return () => {
      if (parcelSource.current && !v.isDestroyed()) {
        v.dataSources.remove(parcelSource.current, true);
        parcelSource.current = null;
      }
    };
  }, [ready, parcels]);
  useEffect(() => {
    if (parcelSource.current) parcelSource.current.show = parcelsVisible;
    viewer.current?.scene.requestRender();
  }, [parcelsVisible]);
  useEffect(() => {
    const C = api.current,
      v = viewer.current;
    if (!ready || !C || !v) return;
    const source = new C.CustomDataSource('Mapped address points');
    source.show = addressVisibility.current;
    addressSource.current = source;
    void v.dataSources
      .add(source)
      .catch(() =>
        setMapWarning(
          'A map overlay could not be initialized. Reload to retry.',
        ),
      );
    for (const a of addresses)
      source.entities.add({
        id: `address:${a.id}`,
        properties: { openviewKind: 'address', openviewId: a.id },
        position: C.Cartesian3.fromDegrees(a.lon, a.lat),
        point: {
          pixelSize: 7,
          color: C.Color.fromCssColorString('#8edeee'),
          outlineColor: C.Color.fromCssColorString('#082a37'),
          outlineWidth: 2,
          heightReference: C.HeightReference.CLAMP_TO_GROUND,
          distanceDisplayCondition: new C.DistanceDisplayCondition(0, 15000),
        },
        label: {
          text: [a.number, a.street, a.unit ? `(${a.unit})` : '']
            .filter(Boolean)
            .join(' '),
          font: '12px Arial',
          fillColor: C.Color.fromCssColorString('#dffaff'),
          outlineColor: C.Color.fromCssColorString('#0a2029'),
          outlineWidth: 3,
          style: C.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new C.Cartesian2(9, -9),
          horizontalOrigin: C.HorizontalOrigin.LEFT,
          heightReference: C.HeightReference.CLAMP_TO_GROUND,
          distanceDisplayCondition: new C.DistanceDisplayCondition(0, 900),
          disableDepthTestDistance: 1000,
        },
      });
    v.scene.requestRender();
    return () => {
      if (!v.isDestroyed()) v.dataSources.remove(source, true);
      if (addressSource.current === source) addressSource.current = null;
    };
  }, [ready, addresses]);
  useEffect(() => {
    if (addressSource.current) addressSource.current.show = addressesVisible;
    viewer.current?.scene.requestRender();
  }, [addressesVisible]);
  return (
    <>
      <div className="earth-canvas" ref={container} />
      {!ready && !error && (
        <div className="earth-loading">
          <span className="loading-ring" />
          Preparing your view of Earth…
        </div>
      )}
      {error && (
        <div className="earth-error">
          <strong>The globe could not load</strong>
          <p>{error}</p>
          <small>
            Use a browser with WebGL 2 and hardware acceleration enabled.
          </small>
        </div>
      )}
      {(mapWarning || terrainWarning) && (
        <output className="map-warning">
          {[terrainWarning, mapWarning].filter(Boolean).join(' ')}
        </output>
      )}
    </>
  );
});
export default Earth;
