'use client';
/* oxlint-disable react/react-compiler -- The React Compiler transform is not installed; refs intentionally bridge the imperative Cesium and feed lifecycles. */
import Link from 'next/link';
import Image from 'next/image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Globe2,
  Layers,
  Building2,
  ArrowUpRight,
  Plus,
  Minus,
  Compass,
  RotateCcw,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  X,
  LocateFixed,
  ExternalLink,
  Radio,
  Clock3,
} from 'lucide-react';
import { UnifiedSearch, type SearchFeed } from '@/components/unified-search';
import {
  liveSearchItems,
  SEARCH_LABELS,
  type SearchResult,
} from '@/lib/search-model';
import { PARCEL_ADAPTERS } from '@/lib/land-model';
import { DEFAULT_RADIO_FILTERS } from '@/lib/radio-model';
import { LayerPanel, type OverlayControl } from '@/components/layer-panel';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { useLandExplorer } from '@/hooks/use-land-explorer';
import { useRadioSites } from '@/hooks/use-radio-sites';
import { RadioControls, RadioInspector } from '@/components/radio-controls';
import { CellControls } from '@/components/cell-controls';
import { CoverageControls } from '@/components/coverage-controls';
import { useCellCoverage } from '@/hooks/use-cell-coverage';
import { useParks } from '@/hooks/use-parks';
import { useCamping } from '@/hooks/use-camping';
import { CampingControls, CampingPopup } from '@/components/camping-controls';
import {
  CAMP_LAYERS,
  CAMP_LABELS,
  PAYMENTS,
  campMapped,
  type CampRecord,
} from '@/lib/camping-model';
import { ParkControls, ParkPopup } from '@/components/park-controls';
import type { RadioMarker } from '@/lib/radio-model';
import { LandControls } from '@/components/land-controls';
import { AddressPopup } from '@/components/address-popup';
import Earth, { type EarthHandle, type Pick } from '@/components/earth';
import {
  regionAt,
  ageLabel,
  utc,
  type CameraView,
  type OMM,
  type Track,
  type Snapshot,
} from '@/lib/model';
import {
  makeSatellite,
  orbitPosition,
  epochTime,
  predictedTrack,
} from '@/lib/orbits';
import { LAYERS, type LayerId } from '@/lib/map-layers';
import { SpaceDetails } from '@/components/space-details';
import { useOsm } from '@/hooks/use-osm';
import { OsmControls } from '@/components/osm-controls';
import {
  DEFAULT_SPACE_TYPES,
  SPACE_TYPES,
  SPACE_LABELS,
  SPACE_CACHE_KEY,
  isSpaceObject,
  spaceRefreshAt,
  visibleSpaceObjects,
  type SpaceType,
  type SpaceObject,
} from '@/lib/space-data';
import {
  readSpaceSnapshot,
  saveSpaceSnapshot,
  readSpaceRetry,
  saveSpaceRetry,
} from '@/lib/space-storage';
const PLACES = [
  {
    name: 'Raleigh, North Carolina',
    lat: 35.7805,
    lon: -78.6391,
    height: 1800,
  },
  { name: 'Hartford, Connecticut', lat: 41.764, lon: -72.6821, height: 1800 },
  {
    name: 'Phoenix, Maricopa County',
    lat: 33.4466,
    lon: -112.0764,
    height: 1800,
  },
  { name: 'New York', lat: 40.71, lon: -74, height: 150000 },
  { name: 'London', lat: 51.5074, lon: -0.1278, height: 150000 },
  { name: 'Helsinki, Baltic Sea', lat: 60.1, lon: 24.9, height: 240000 },
  { name: 'Singapore', lat: 1.3521, lon: 103.8198, height: 150000 },
  { name: 'Tokyo', lat: 35.6762, lon: 139.65, height: 150000 },
  { name: 'Sydney', lat: -33.8688, lon: 151.2093, height: 150000 },
  {
    name: 'Swiss Alps · Matterhorn',
    lat: 45.9763,
    lon: 7.6586,
    height: 12000,
    pitch: -35,
  },
];
type Feed = 'orbits' | 'aircraft' | 'ships';
const Toggle = ({
  label,
  detail,
  checked,
  onChange,
}: {
  label: string;
  detail?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) => (
  <label className="toggle-row">
    <span>
      <strong>{label}</strong>
      {detail && <small>{detail}</small>}
    </span>
    <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
  </label>
);
function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="detail-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
export default function Home() {
  const osm = useOsm();
  const globe = useRef<EarthHandle>(null),
    [view, setView] = useState<CameraView>({
      lat: 20,
      lon: -25,
      height: 19000000,
    }),
    viewRef = useRef(view);
  viewRef.current = view;
  const [open, setOpen] = useState(true),
    [now, setNow] = useState(0),
    [selected, setSelected] = useState<Pick | null>(null);
  const [orbits, setOrbits] = useState<Snapshot<OMM> | null>(null),
    [air, setAir] = useState<Snapshot<Track> | null>(null),
    [sea, setSea] = useState<Snapshot<Track> | null>(null);
  const [spaceTypes, setSpaceTypes] =
    useState<Record<SpaceType, boolean>>(DEFAULT_SPACE_TYPES);
  const [spaceVisible, setSpaceVisible] = useState(false),
    [paths, setPaths] = useState(false),
    [airVisible, setAirVisible] = useState(false),
    [seaVisible, setSeaVisible] = useState(false),
    [live, setLive] = useState(false);
  const [layer, setLayer] = useState<LayerId>('satellite'),
    [labels, setLabels] = useState(false),
    [scrollSensitivity, setScrollSensitivity] = useState(1),
    [offset, setOffset] = useState(0);
  const coverage = useCellCoverage(view);
  const parks = useParks();
  const closeParks = parks.close;
  const [busy, setBusy] = useState<Partial<Record<Feed, boolean>>>({}),
    [errors, setErrors] = useState<Partial<Record<Feed, string>>>({}),
    [retryAt, setRetryAt] = useState<Partial<Record<Feed, number>>>({}),
    retryRef = useRef(retryAt);
  retryRef.current = retryAt;
  const locks = useRef(new Set<Feed>()),
    controllers = useRef(new Set<AbortController>()),
    [notice, setNotice] = useState('');
  const region = regionAt(view.lat, view.lon),
    surface = view.height < 1800000;
  const land = useLandExplorer(globe, view);
  const radio = useRadioSites(globe, view);
  const cells = useRadioSites(globe, view, '/cells');
  const camping = useCamping(globe, view);
  useEffect(() => {
    if (selected || land.selectedAddress || radio.selection || cells.selection)
      closeParks();
  }, [
    selected,
    land.selectedAddress,
    radio.selection,
    cells.selection,
    closeParks,
  ]);
  useEffect(() => {
    try {
      const stored = Number(
        localStorage.getItem('openview-scroll-sensitivity') || 1,
      );
      if (stored >= 0.25 && stored <= 3) setScrollSensitivity(stored);
    } catch {}
    if (window.innerWidth < 640) setOpen(false);
    try {
      // Only preferences belong in localStorage; the catalog uses IndexedDB.
      localStorage.removeItem('openview-orbits-v1');
      const preferences = JSON.parse(
        localStorage.getItem(SPACE_CACHE_KEY) || 'null',
      );
      if (
        preferences &&
        typeof preferences.payload === 'boolean' &&
        typeof preferences['rocket-body'] === 'boolean'
      )
        setSpaceTypes(preferences);
    } catch {}
    let timer: ReturnType<typeof setInterval> | undefined;
    const updateClock = () => setNow(Date.now());
    const syncClock = () => {
      if (document.visibilityState === 'visible') {
        updateClock();
        timer ??= setInterval(updateClock, 1000);
      } else if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    document.addEventListener('visibilitychange', syncClock);
    syncClock();
    const activeControllers = controllers.current;
    return () => {
      document.removeEventListener('visibilitychange', syncClock);
      if (timer !== undefined) clearInterval(timer);
      activeControllers.forEach((c) => c.abort());
    };
  }, []);
  const load = useCallback(async (feed: Feed) => {
    if (locks.current.has(feed) || Date.now() < (retryRef.current[feed] || 0))
      return;
    locks.current.add(feed);
    setBusy((b) => ({ ...b, [feed]: true }));
    setErrors((e) => ({ ...e, [feed]: undefined }));
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      let url = `/api/${feed}`;
      if (feed === 'aircraft')
        url += `?lat=${viewRef.current.lat.toFixed(3)}&lon=${viewRef.current.lon.toFixed(3)}`;
      const response = await fetch(url, { signal: controller.signal });
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object')
        throw new Error('The data source returned an unreadable response.');
      const data = body as Record<string, unknown>;
      if (!response.ok) {
        const retryAt = data.retryAt;
        if (typeof retryAt === 'number' && Number.isFinite(retryAt)) {
          retryRef.current = { ...retryRef.current, [feed]: retryAt };
          setRetryAt((t) => ({ ...t, [feed]: retryAt }));
          if (feed === 'orbits')
            saveSpaceRetry({
              retryAt,
              error:
                typeof data.error === 'string'
                  ? data.error
                  : 'The source is unavailable.',
            });
        }
        throw new Error(
          typeof data.error === 'string'
            ? data.error
            : 'The data could not be loaded.',
        );
      }
      if (feed === 'orbits') {
        const raw = body as Snapshot<SpaceObject>;
        if (
          !Array.isArray(raw.items) ||
          !Number.isFinite(raw.fetchedAt) ||
          !Number.isFinite(raw.nextRefreshAt)
        )
          throw Error('The space catalog has an unexpected format.');
        const snapshot = {
          ...raw,
          nextRefreshAt: spaceRefreshAt(raw),
          items: raw.items.filter(isSpaceObject),
        };
        if (!snapshot.items.length)
          throw Error('No valid space objects were returned.');
        setOrbits(snapshot);
        saveSpaceRetry(null);
        retryRef.current = { ...retryRef.current, orbits: 0 };
        setRetryAt((t) => ({ ...t, orbits: 0 }));
        setErrors((e) => ({ ...e, orbits: snapshot.warning }));
        void saveSpaceSnapshot(snapshot).catch(() => {});
      }
      if (feed === 'aircraft') setAir(body as Snapshot<Track>);
      if (feed === 'ships') {
        const snapshot = body as Snapshot<Track>;
        setSea(snapshot);
        setErrors((e) => ({ ...e, ships: snapshot.warning }));
        retryRef.current = {
          ...retryRef.current,
          ships: snapshot.nextRefreshAt,
        };
        setRetryAt((t) => ({ ...t, ships: snapshot.nextRefreshAt }));
      }
      setNotice(
        data.cached === true
          ? 'Showing the latest cached source data.'
          : `${feed === 'orbits' ? 'Orbital elements' : feed === 'ships' ? 'Ship reports' : 'Aircraft reports'} updated.`,
      );
    } catch (e) {
      if (feed === 'ships' && !controller.signal.aborted) {
        const next = Math.max(Date.now() + 600000, retryRef.current.ships || 0);
        retryRef.current = { ...retryRef.current, ships: next };
        setRetryAt((t) => ({ ...t, ships: next }));
      }
      if (!controller.signal.aborted)
        setErrors((p) => ({
          ...p,
          [feed]: e instanceof Error ? e.message : 'The source is unavailable.',
        }));
    } finally {
      controllers.current.delete(controller);
      locks.current.delete(feed);
      setBusy((b) => ({ ...b, [feed]: false }));
    }
  }, []);
  const radioEnabled = radio.enabled,
    radioManifest = radio.manifest,
    radioManifestError = radio.manifestError,
    inspectRadioSearchResult = radio.inspect,
    parksEnabled = parks.enabled,
    parksManifest = parks.manifest,
    parksManifestError = parks.manifestError,
    nationalParks = parks.national,
    stateParks = parks.state,
    selectParkRecord = parks.selectRecord;
  useEffect(() => {
    if (!live) return;
    const timers: ReturnType<typeof setInterval>[] = [];
    if (airVisible)
      timers.push(
        setInterval(() => {
          if (!document.hidden) void load('aircraft');
        }, 15000),
      );
    return () => timers.forEach(clearInterval);
  }, [live, airVisible, load]);
  useEffect(() => {
    if (!live || !seaVisible) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      clearTimeout(timer);
      if (document.hidden) return;
      const due = Math.max(
        sea?.nextRefreshAt || Date.now() + 600000,
        retryAt.ships || 0,
      );
      timer = setTimeout(
        () => {
          void load('ships');
        },
        Math.max(0, due - Date.now()),
      );
    };
    schedule();
    document.addEventListener('visibilitychange', schedule);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [live, seaVisible, sea, retryAt.ships, load]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(t);
  }, [notice]);
  const navigate = useCallback((p: CameraView) => {
    globe.current?.flyTo(p);
    if (window.innerWidth < 640) setOpen(false);
  }, []);
  useEffect(() => {
    const ctx = (
      document as Document & {
        modelContext?: {
          registerTool: (
            tool: unknown,
            options: { signal: AbortSignal },
          ) => unknown;
        };
      }
    ).modelContext;
    if (!ctx?.registerTool) return;
    const life = new AbortController();
    try {
      Promise.resolve(
        ctx.registerTool(
          {
            name: 'navigate_earth',
            title: 'Navigate Earth',
            description:
              'Fly the globe to latitude and longitude with a camera height in meters.',
            inputSchema: {
              type: 'object',
              properties: {
                latitude: { type: 'number', minimum: -90, maximum: 90 },
                longitude: { type: 'number', minimum: -180, maximum: 180 },
                height: { type: 'number', minimum: 120, maximum: 70000000 },
              },
              required: ['latitude', 'longitude'],
              additionalProperties: false,
            },
            annotations: { readOnlyHint: false, untrustedContentHint: false },
            execute(input: unknown) {
              const p = input as {
                latitude: number;
                longitude: number;
                height?: number;
              };
              if (
                !p ||
                !Number.isFinite(p.latitude) ||
                !Number.isFinite(p.longitude) ||
                Math.abs(p.latitude) > 90 ||
                Math.abs(p.longitude) > 180 ||
                (p.height !== undefined &&
                  (!Number.isFinite(p.height) ||
                    p.height < 120 ||
                    p.height > 70000000))
              )
                throw new Error('Invalid coordinates or height.');
              const camera = {
                lat: p.latitude,
                lon: p.longitude,
                height: p.height ?? 150000,
              };
              navigate(camera);
              return { navigationStarted: true, ...camera };
            },
          },
          { signal: life.signal },
        ),
      ).catch(() => {});
    } catch {}
    return () => life.abort();
  }, [navigate]);
  const tracks = useMemo(
    () => [
      ...(airVisible ? air?.items || [] : []),
      ...(seaVisible ? sea?.items || [] : []),
    ],
    [airVisible, seaVisible, air, sea],
  );
  const shownOrbits = useMemo(
    () => visibleSpaceObjects(orbits?.items || [], spaceTypes),
    [orbits, spaceTypes],
  );
  const selectedOrbit =
    selected?.kind === 'satellite'
      ? shownOrbits.find((o) => String(o.NORAD_CAT_ID) === selected.id)
      : undefined;
  const sat = useMemo(() => {
    try {
      return selectedOrbit ? makeSatellite(selectedOrbit) : null;
    } catch {
      return null;
    }
  }, [selectedOrbit]);
  const satPosition =
    sat && now ? orbitPosition(sat, new Date(now + offset * 60000)) : null;
  const selectedTrack =
    selected && ['aircraft', 'ships'].includes(selected.kind)
      ? tracks.find((t) => t.id === selected.id && t.kind === selected.kind)
      : undefined;
  const trackPosition = selectedTrack
    ? predictedTrack(selectedTrack, now)
    : null;
  const inspectRadio = (p: RadioMarker) => {
    camping.close();
    parks.close();
    land.close();
    setSelected(null);
    cells.close();
    radio.inspect(p);
  };
  const inspectCells = (p: RadioMarker) => {
    camping.close();
    parks.close();
    land.close();
    radio.close();
    setSelected(null);
    cells.inspect(p);
  };
  const zoomRadio = (p: RadioMarker) => {
    const span = Math.max(p.bounds[2] - p.bounds[0], p.bounds[3] - p.bounds[1]);
    globe.current?.flyTo({
      lat: p.lat,
      lon: p.lon,
      height: Math.max(700, Math.min(view.height * 0.45, span * 90000)),
      pitch: -70,
    });
  };
  const inspectCamping = (id: string, version: string) => {
    parks.close();
    land.close();
    radio.close();
    cells.close();
    setSelected(null);
    setSearchLocation(null);
    setPendingSearch(null);
    camping.inspect(id, version);
    if (window.innerWidth < 900) setOpen(false);
  };
  const flyCamping = (r: CampRecord) => {
    if (!campMapped(r)) return;
    camping.setPayments([...PAYMENTS]);
    // Keep the selected details while enabling its category.
    if (!camping.layers.includes(r.layer)) {
      camping.toggle(r.layer, true);
      camping.inspect(r.id, camping.selection!.version);
    }
    navigate({ lat: r.location![1], lon: r.location![0], height: 6000 });
  };
  const selectObject = (p: Pick) => {
    parks.close();
    if (p.kind === 'camping') {
      const marker = camping.markers.find((m) => m.id === p.id);
      if (!marker) return;
      if (marker.cluster) {
        camping.close();
        setNotice(
          `${marker.count.toLocaleString()} grouped source records. Zooming toward this group.`,
        );
        navigate({
          lat: marker.lat,
          lon: marker.lon,
          height: Math.max(150, view.height * 0.25),
        });
      } else inspectCamping(marker.recordId!, marker.version);
      return;
    }
    camping.close();
    if (p.kind === 'search') {
      if (searchLocation) selectSearchResult(searchLocation);
      return;
    }
    setSearchLocation(null);
    setPendingSearch(null);
    if (p.kind === 'cells') {
      const marker = cells.markers.find((m) => m.id === p.id);
      if (marker) inspectCells(marker);
      return;
    }
    if (p.kind === 'radio') {
      const marker = radio.markers.find((m) => m.id === p.id);
      if (marker) inspectRadio(marker);
      return;
    }
    radio.close();
    cells.close();
    if (land.selectMapObject(p)) {
      setSelected(null);
      return;
    }
    land.close();
    setSelected(p);
  };
  const [searchLocation, setSearchLocation] = useState<
      (SearchResult & { lat: number; lon: number }) | null
    >(null),
    [pendingSearch, setPendingSearch] = useState<SearchResult | null>(null);
  const searchItems = useMemo(() => {
    const items = liveSearchItems({
      orbits,
      air,
      sea,
      addresses: land.addresses.data?.items,
      parcels: land.parcels.data,
    });
    for (const p of PLACES)
      items.push({
        id: 'preset:' + p.name,
        kind: 'place',
        name: p.name,
        detail: 'Featured map location',
        terms: p.name,
        lat: p.lat,
        lon: p.lon,
        height: p.height,
        source: 'OpenView location shortcut',
        sourceUrl: '',
        target: { type: 'place' },
      });
    for (const a of PARCEL_ADAPTERS) {
      const [w, s, e, n] = a.bounds;
      items.push({
        id: 'parcel-source:' + a.id,
        kind: 'parcel-source',
        name: a.name,
        detail: a.coverage,
        terms: a.name + ' ' + a.coverage + ' parcels boundaries',
        lat: a.testCenter?.[1] ?? (s + n) / 2,
        lon: a.testCenter?.[0] ?? (w + e) / 2,
        height: 1800,
        source: a.name,
        sourceUrl: a.sourceUrl,
        target: { type: 'parcel-source' },
      });
    }
    for (const l of coverage.manifest?.layers || [])
      for (const region of l.regions) {
        const j = l.jurisdictions.find(
          (j) => j.id === region.id && j.status === 'ready',
        );
        if (!j) continue;
        const [w, s, e, n] = region.rectangle;
        items.push({
          id: 'coverage:' + l.id + ':' + region.id,
          kind: 'coverage',
          name: l.provider.name + ' ' + l.technology + ' · ' + j.name,
          detail:
            l.downloadMbps + '/' + l.uploadMbps + ' Mbps · ' + l.reportingDate,
          terms:
            l.provider.name + ' ' + j.name + ' cell coverage ' + l.technology,
          lat: (s + n) / 2,
          lon: (w + e) / 2,
          height: Math.max(40000, (n - s) * 130000),
          source: 'FCC BDC',
          sourceUrl: l.sourceUrl,
          target: { type: 'coverage', layerId: l.id },
        });
      }
    return items;
  }, [
    orbits,
    air,
    sea,
    land.addresses.data,
    land.parcels.data,
    coverage.manifest,
  ]);
  const searchFeeds: SearchFeed[] = [
    {
      id: 'orbits',
      name: 'Space objects',
      detail:
        'Public payloads and rocket bodies from CelesTrak. Debris and unknown types are excluded.',
      count: orbits?.items.length || 0,
      loaded: !!orbits,
      busy: !!busy.orbits,
      error: errors.orbits,
      disabled:
        Math.max(retryAt.orbits || 0, orbits ? spaceRefreshAt(orbits) : 0) >
        now,
      refresh: () => void load('orbits'),
    },
    {
      id: 'aircraft',
      name: 'Aircraft',
      detail:
        'Reception within 250 nautical miles of the current map center. Search includes the last requested area.',
      count: air?.items.length || 0,
      loaded: !!air,
      busy: !!busy.aircraft,
      error: errors.aircraft,
      disabled: (retryAt.aircraft || 0) > now,
      refresh: () => void load('aircraft'),
    },
    {
      id: 'ships',
      name: 'Ships',
      detail:
        'Sampled AIS reports every ten minutes. Search covers the loaded snapshot; ship positions stay fixed.',
      count: sea?.items.length || 0,
      loaded: !!sea,
      busy: !!busy.ships,
      error: errors.ships,
      disabled: (retryAt.ships || 0) > now,
      refresh: () => void load('ships'),
    },
  ];
  const selectSearchResult = (r: SearchResult) => {
    camping.close();
    parks.close();
    land.close();
    radio.close();
    cells.close();
    setSelected(null);
    setPendingSearch(null);
    const target = r.target;
    if (target.type === 'camping') {
      camping.setPayments([...PAYMENTS]);
      camping.toggle(target.layer, true);
      inspectCamping(target.recordId, target.version);
      if (r.lat !== null && r.lon !== null)
        navigate({ lat: r.lat, lon: r.lon, height: r.height });
      return;
    }
    if (r.lat === null || r.lon === null) {
      setSearchLocation(null);
      setNotice('Location unavailable.');
      return;
    }
    setSearchLocation(
      target.type === 'satellite' || target.type === 'track'
        ? null
        : { ...r, lat: r.lat, lon: r.lon },
    );
    let destination = { lat: r.lat, lon: r.lon, height: r.height };
    if (target.type === 'satellite') {
      const object = orbits?.items.find(
        (o) => String(o.NORAD_CAT_ID) === target.id,
      );
      if (!isSpaceObject(object)) return;
      setSpaceTypes((types) => ({ ...types, [object.objectType]: true }));
      setSpaceVisible(true);
      setSelected({ kind: 'satellite', id: target.id });
      setOffset(0);
      try {
        if (!object || Math.abs(Date.now() - epochTime(object)) > 14 * 86400000)
          throw Error(
            'Orbital elements are too old to locate this satellite. Update orbital data.',
          );
        const p = orbitPosition(makeSatellite(object), new Date());
        if (!p)
          throw Error('A current orbit position could not be calculated.');
        destination = {
          lat: p.lat,
          lon: p.lon,
          height: Math.max(300000, p.altitude + 1500000),
        };
      } catch (e) {
        setNotice(
          e instanceof Error ? e.message : 'Cannot locate this satellite.',
        );
        return;
      }
    } else if (target.type === 'track') {
      if (target.kind === 'aircraft') setAirVisible(true);
      else setSeaVisible(true);
      const track = (target.kind === 'aircraft' ? air : sea)?.items.find(
        (t) => t.id === target.id,
      );
      if (!track) {
        setNotice('This report is no longer in the loaded feed. Search again.');
        return;
      }
      const p = predictedTrack(track, Date.now());
      destination = {
        lat: p.lat,
        lon: p.lon,
        height: Math.max(6000, track.altitude + 12000),
      };
      setSelected({ kind: target.kind, id: target.id });
    } else if (target.type === 'address') {
      land.setAddressesVisible(true);
      land.selectAddress(target.address);
    } else if (target.type === 'parcel') {
      land.setParcelsVisible(true);
      land.selectMapObject({
        kind: 'parcel',
        id: target.parcelId,
        location: { lat: r.lat, lon: r.lon },
      });
    } else if (target.type === 'parcel-source') land.setParcelsVisible(true);
    else if (target.type === 'radio') {
      radio.setFilters(DEFAULT_RADIO_FILTERS);
      radio.setEnabled(true);
      setPendingSearch(r);
      setNotice(
        'Locating radio record. Radio filters reset to show the result.',
      );
    } else if (target.type === 'park') {
      parks.toggle(target.kind, true);
      setPendingSearch(r);
    } else if (target.type === 'coverage') {
      coverage.setEnabled(true);
      coverage.setLayerId(target.layerId);
    }
    navigate(destination);
  };
  useEffect(() => {
    if (!pendingSearch) return;
    const r = pendingSearch,
      t = r.target;
    if (r.lat === null || r.lon === null) {
      setPendingSearch(null);
      return;
    }
    if (t.type === 'radio') {
      if (radioManifestError) {
        setNotice(radioManifestError);
        setPendingSearch(null);
        return;
      }
      if (!radioEnabled) {
        setPendingSearch(null);
        return;
      }
      if (!radioManifest) return;
      if (radioManifest.version !== r.release) {
        setNotice(
          'The radio search catalog is from a different release. Refresh the search catalog.',
        );
        setPendingSearch(null);
        return;
      }
      inspectRadioSearchResult({
        id: 'search:' + t.recordId,
        node: t.node,
        category: t.category,
        lat: r.lat,
        lon: r.lon,
        count: 1,
        bounds: [r.lon, r.lat, r.lon, r.lat],
        recordIds: [t.recordId],
      });
      setPendingSearch(null);
    } else if (t.type === 'park') {
      const park = t.kind === 'national' ? nationalParks : stateParks;
      const error = parksManifestError || park.error;
      if (error) {
        setNotice(error);
        setPendingSearch(null);
        return;
      }
      if (!parksEnabled[t.kind]) {
        setPendingSearch(null);
        return;
      }
      if (!park.data) return;
      if (parksManifest?.release !== r.release) {
        setNotice(
          'The park search catalog is from a different release. Refresh the search catalog.',
        );
        setPendingSearch(null);
        return;
      }
      if (r.lat !== null && r.lon !== null)
        selectParkRecord(t.kind, t.parkId, { lat: r.lat, lon: r.lon });
      setPendingSearch(null);
    }
  }, [
    pendingSearch,
    radioEnabled,
    radioManifest,
    radioManifestError,
    inspectRadioSearchResult,
    parksEnabled,
    parksManifest,
    parksManifestError,
    nationalParks,
    stateParks,
    selectParkRecord,
  ]);
  const feedMessage = (feed: Feed) => (
    <>
      {errors[feed] && (
        <p className="feed-error" role="alert">
          {errors[feed]}
          {(retryAt[feed] || 0) > now && (
            <span> Retry after {utc(retryAt[feed]!)}</span>
          )}
        </p>
      )}
      {busy[feed] && (
        <p className="fetching">
          <output>Connecting to the source…</output>
        </p>
      )}
    </>
  );
  const refresh = (feed: Feed, label: string, disabled = false) => (
    <Button
      className="primary-action"
      disabled={!!busy[feed] || disabled || (retryAt[feed] || 0) > now}
      onClick={() => void load(feed)}
    >
      <RefreshCw className={busy[feed] ? 'spinning' : ''} />
      {busy[feed] ? 'Updating…' : label}
    </Button>
  );
  useEffect(() => {
    let active = true;
    void readSpaceSnapshot()
      .catch(() => null)
      .then((saved) => {
        if (!active) return;
        if (saved?.items.length) {
          setOrbits(saved);
          setErrors((e) => ({ ...e, orbits: saved.warning }));
        }
        const retry = readSpaceRetry();
        if (retry) {
          retryRef.current = { ...retryRef.current, orbits: retry.retryAt };
          setRetryAt((t) => ({ ...t, orbits: retry.retryAt }));
          setErrors((e) => ({ ...e, orbits: retry.error }));
          return;
        }
        // Restore saved data for search; acquire fresh elements only when the
        // user enables space objects or explicitly requests a source update.
      });
    return () => {
      active = false;
    };
  }, [load]);
  const nextSpaceCheck = Math.max(
    retryAt.orbits || 0,
    orbits ? spaceRefreshAt(orbits) : 0,
  );
  useEffect(() => {
    if (!spaceVisible || !nextSpaceCheck) return;
    const check = () => {
      if (!document.hidden && Date.now() >= nextSpaceCheck) void load('orbits');
    };
    const timer = setTimeout(
      check,
      Math.max(1000, Math.min(2147483647, nextSpaceCheck - Date.now())),
    );
    document.addEventListener('visibilitychange', check);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, [spaceVisible, nextSpaceCheck, load]);
  const changeSpaceType = (type: SpaceType, enabled: boolean) => {
    const next = {
      ...(spaceVisible ? spaceTypes : { payload: false, 'rocket-body': false }),
      [type]: enabled,
    };
    setSpaceTypes(next);
    try {
      localStorage.setItem(SPACE_CACHE_KEY, JSON.stringify(next));
    } catch {}
    if (selected?.kind === 'satellite') {
      const object = orbits?.items.find(
        (o) => String(o.NORAD_CAT_ID) === selected.id,
      );
      if (isSpaceObject(object) && object.objectType === type && !enabled)
        setSelected(null);
    }
    if (enabled) {
      setSpaceVisible(true);
      if (!orbits) void load('orbits');
    }
  };
  const toggleTraffic = (kind: 'aircraft' | 'ships', on: boolean) => {
    if (kind === 'aircraft') setAirVisible(on);
    else setSeaVisible(on);
    if (on) void load(kind);
  };
  const overlayControls: OverlayControl[] = [
    {
      id: 'labels',
      label: 'Place names & boundaries',
      description: 'Geographic labels',
      symbol: 'line',
      color: '#d7e0e7',
      enabled: labels,
      change: (v) => {
        if (surface || !v) setLabels(v);
        else setNotice('Zoom closer to enable place labels.');
      },
    },
    {
      id: 'space',
      label: 'Space objects',
      description: 'Payloads and rocket bodies · predicted positions',
      symbol: 'dot',
      color: '#c3ed97',
      enabled: spaceVisible,
      change: (v) => {
        setSpaceVisible(v);
        if (v && !orbits) void load('orbits');
      },
      status:
        errors.orbits ||
        (busy.orbits
          ? 'Loading orbital elements…'
          : orbits
            ? shownOrbits.length +
              ' enabled / ' +
              orbits.items.length +
              ' loaded'
            : 'Update orbital data below to load objects.'),
      error: !!errors.orbits,
    },
    {
      id: 'paths',
      label: 'Selected orbit path',
      description: 'One predicted revolution',
      symbol: 'line',
      color: '#c3ed9799',
      enabled: paths,
      change: setPaths,
    },
    {
      id: 'aircraft',
      label: 'Aircraft',
      description: 'Reports near your requested area',
      symbol: 'plane',
      color: '#8fceff',
      enabled: airVisible,
      change: (v) => toggleTraffic('aircraft', v),
      status:
        errors.aircraft ||
        (busy.aircraft
          ? 'Loading aircraft…'
          : air
            ? air.items.length + ' reports · ' + ageLabel(air.fetchedAt, now)
            : 'No aircraft reports loaded.'),
      error: !!errors.aircraft,
    },
    {
      id: 'ships',
      label: 'Ships',
      description: 'AIS snapshots · every 10 minutes',
      symbol: 'diamond',
      color: '#ffbd86',
      enabled: seaVisible,
      change: (v) => toggleTraffic('ships', v),
      status:
        errors.ships ||
        (busy.ships
          ? 'Collecting a ship snapshot (up to 30 seconds)…'
          : sea
            ? sea.items.length + ' reports · ' + ageLabel(sea.fetchedAt, now)
            : 'No ship reports loaded.'),
      error: !!errors.ships,
    },
    {
      id: 'addresses',
      label: 'Mapped addresses',
      description: 'Published address points',
      symbol: 'dot',
      color: '#8edeee',
      enabled: land.addressesVisible,
      change: land.setAddressesVisible,
      status:
        land.addresses.error ||
        (land.addresses.loading ? 'Loading addresses…' : land.areaMessage),
      error: !!land.addresses.error,
    },
    {
      id: 'parcels',
      label: 'U.S. parcel lines',
      description: 'Available state & county boundaries',
      symbol: 'line',
      color: '#ffe39a',
      enabled: land.parcelsVisible,
      change: land.setParcelsVisible,
      status:
        land.parcels.error ||
        (land.parcels.loading ? 'Loading parcels…' : land.areaMessage),
      error: !!land.parcels.error,
    },
    {
      id: 'radio',
      label: 'Radio sites',
      description: 'Transmitters, uncertain sites & receivers',
      symbol: 'triangle',
      color: '#58d6cd',
      enabled: radio.enabled,
      change: radio.setEnabled,
      status:
        radio.manifestError ||
        radio.error ||
        (radio.loading ? 'Loading radio sites…' : ''),
      error: !!(radio.manifestError || radio.error),
    },
    {
      id: 'cells',
      label: 'Cell locations',
      description: 'Estimated cells · U.S. network codes',
      symbol: 'dot',
      color: '#f596bf',
      enabled: cells.enabled,
      change: cells.setEnabled,
      status:
        cells.manifestError ||
        cells.error ||
        (cells.refreshing
          ? 'Checking dataset…'
          : cells.loading
            ? 'Loading this view…'
            : cells.limited
              ? 'View limited — zoom or filter'
              : cells.manifest
                ? `${cells.markers.reduce((n, p) => n + p.count, 0).toLocaleString()} matching cell records`
                : 'Loads when enabled'),
      error: !!(cells.manifestError || cells.error),
    },
    {
      id: 'coverage',
      label: 'Cell coverage',
      description: 'FCC reported mobile availability',
      symbol: 'area',
      color: '#40be82',
      enabled: coverage.enabled,
      change: coverage.setEnabled,
      status:
        coverage.error ||
        (coverage.loading ? 'Loading coverage…' : coverage.tileStatus),
      error: !!coverage.error,
    },
    ...CAMP_LAYERS.map((kind) => ({
      id: `camping-${kind}`,
      label: CAMP_LABELS[kind],
      description:
        kind === 'campgrounds'
          ? 'Source campground & RV park records'
          : kind === 'sites'
            ? 'Individual and group sites · close zoom'
            : 'Lodging, zones and related facilities',
      symbol: (kind === 'campgrounds'
        ? 'triangle'
        : kind === 'sites'
          ? 'square'
          : 'diamond') as 'triangle' | 'square' | 'diamond',
      color: '#83dfac',
      enabled: camping.layers.includes(kind),
      change: (v: boolean) => camping.toggle(kind, v),
      status:
        camping.error || (camping.loading ? 'Loading camping records…' : ''),
      error: !!camping.error,
    })),
    ...(['national', 'state'] as const).map((kind) => ({
      id: kind + '-parks',
      label: kind === 'national' ? 'National parks' : 'State parks',
      description:
        kind === 'national'
          ? 'NPS administrative boundaries'
          : 'PAD-US mapped park lands',
      symbol: 'area' as const,
      color: kind === 'national' ? '#f0ad72' : '#bdb1ff',
      enabled: parks.enabled[kind],
      change: (v: boolean) => parks.toggle(kind, v),
      status:
        parks.manifestError ||
        parks[kind].error ||
        (parks[kind].loading
          ? 'Loading park areas…'
          : parks.renderStatus[kind].message),
      error: !!(
        parks.manifestError ||
        parks[kind].error ||
        parks.renderStatus[kind].failed
      ),
    })),
  ];
  return (
    <main className="observatory dark">
      <header className="topbar">
        <Link className="brand" href="/">
          <Image
            src="/OpenView.ico"
            unoptimized
            alt=""
            className="brand-logo"
            width={36}
            height={36}
          />
          <span>
            Open<span>View</span>
          </span>
          <span className="brand-divider" />
          <small>EARTH EXPLORER</small>
        </Link>
        <UnifiedSearch
          items={searchItems}
          onSelect={selectSearchResult}
          feeds={searchFeeds}
        />
        <div className="top-status">
          <i />
          {now ? new Date(now).toISOString().slice(11, 19) : '--:--:--'} UTC
        </div>
      </header>
      <div className="workspace">
        <aside className={`explorer ${open ? '' : 'collapsed'}`}>
          <div className="panel-heading">
            <div>
              <span className="eyebrow">MAP CONTROLS</span>
              <h1>Views & overlays</h1>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close explorer"
              onClick={() => setOpen(false)}
            >
              <PanelLeftClose />
            </Button>
          </div>
          <LayerPanel
            layer={layer}
            setLayer={setLayer}
            overlays={overlayControls}
            osmLayers={osm.selection?.layers}
          >
            <OsmControls
              osm={osm}
              onShow={(bounds) => {
                const [west, south, east, north] = bounds;
                globe.current?.flyTo({
                  lon: (west + east) / 2,
                  lat: (south + north) / 2,
                  height: Math.max(
                    1800,
                    Math.min(
                      19000000,
                      Math.max(east - west, north - south) * 120000,
                    ),
                  ),
                });
              }}
            />
            <details className="panel-detail" open>
              <summary>Space object types</summary>
              {SPACE_TYPES.map((type) => (
                <Toggle
                  key={type}
                  label={SPACE_LABELS[type]}
                  detail={`${orbits?.items.filter((o) => isSpaceObject(o) && o.objectType === type).length || 0} loaded`}
                  checked={spaceVisible && spaceTypes[type]}
                  onChange={(enabled) => changeSpaceType(type, enabled)}
                />
              ))}
              <p className="source-meta">
                Debris and unknown object types are excluded. Non-operational
                satellites remain payloads.
              </p>
            </details>
            <details className="panel-detail">
              <summary>
                <RefreshCw size={17} />
                Data updates
              </summary>
              <section className="data-feed">
                <h3>Space objects</h3>
                <p>
                  Public satellites, payloads and rocket bodies. Positions are
                  calculated locally. Orbital data refreshes at most once every
                  24 hours.
                </p>
                {refresh(
                  'orbits',
                  'Update orbital data',
                  !!orbits && now < spaceRefreshAt(orbits),
                )}
                {feedMessage('orbits')}
                <p className="source-meta">
                  {orbits
                    ? orbits.items.length +
                      ' objects · retrieved ' +
                      ageLabel(orbits.fetchedAt, now)
                    : 'No orbital elements loaded.'}
                </p>
                {orbits && (
                  <p className="source-meta">
                    Next source check {utc(spaceRefreshAt(orbits))}
                  </p>
                )}
                <a
                  className="source-link"
                  href="https://celestrak.org/usage-policy.php"
                  target="_blank"
                  rel="noreferrer"
                >
                  CelesTrak source and refresh policy <ExternalLink size={12} />
                </a>
              </section>
              <section className="data-feed">
                <h3>Aircraft</h3>
                <p>
                  Reports within 250 nautical miles of the current map center.
                </p>
                {refresh('aircraft', 'Update aircraft in this area')}
                {feedMessage('aircraft')}
                {air && (
                  <p className="source-meta">
                    {air.items.length} reports · {air.coverage} · retrieved{' '}
                    {ageLabel(air.fetchedAt, now)}. {air.omitted || 0} old or
                    invalid reports omitted.
                  </p>
                )}
                <a
                  className="source-link"
                  href="https://www.adsb.lol/"
                  target="_blank"
                  rel="noreferrer"
                >
                  ADSB.lol · ODbL <ExternalLink size={12} />
                </a>
              </section>
              <section className="data-feed">
                <h3>Ships</h3>
                <p>
                  {sea?.coverage ||
                    'AISStream snapshots when configured, with Digitraffic regional fallback.'}{' '}
                  Positions stay fixed between ten-minute updates.
                </p>
                {refresh('ships', 'Update ship reports')}
                {feedMessage('ships')}
                {sea && (
                  <p className="source-meta">
                    {sea.items.length} reports ·{' '}
                    {sea.fetchedAt
                      ? `retrieved ${ageLabel(sea.fetchedAt, now)}`
                      : 'awaiting first snapshot'}
                    . Reports older than 24 hours omitted. Next collection{' '}
                    {utc(sea.nextRefreshAt)}.
                    {!!sea.omitted &&
                      ` ${sea.omitted.toLocaleString()} additional reports omitted.`}
                  </p>
                )}
                <a
                  className="source-link"
                  href={sea?.sourceUrl || 'https://aisstream.io/'}
                  target="_blank"
                  rel="noreferrer"
                >
                  {sea?.source || 'AISStream / Digitraffic'}{' '}
                  <ExternalLink size={12} />
                </a>
              </section>
              <Toggle
                label="Live traffic updates"
                detail="Aircraft every 15s · ships every 10 minutes"
                checked={live}
                onChange={setLive}
              />
              <p className="source-meta">
                Only enabled traffic layers update while this page is visible.
                Orbital elements never update in the background.
              </p>
            </details>
            <details className="panel-detail">
              <summary>
                <Radio size={17} />
                Cell location filters and source
              </summary>
              <CellControls cells={cells} inspect={inspectCells} />
            </details>
            <CampingControls camping={camping} onRecord={inspectCamping} />
            <details className="panel-detail">
              <summary>
                <Radio size={17} />
                Radio filters and sources
              </summary>
              <RadioControls
                radio={radio}
                inspect={inspectRadio}
                controls={false}
              />
            </details>
            <details className="panel-detail">
              <summary>
                <Layers size={17} />
                Cell coverage settings
              </summary>
              <CoverageControls coverage={coverage} controls={false} />
            </details>
            <details className="panel-detail">
              <summary>
                <Layers size={17} />
                Park sources and locations
              </summary>
              <ParkControls
                parks={parks}
                navigate={navigate}
                controls={false}
              />
            </details>
            <details className="panel-detail">
              <summary>
                <Building2 size={17} />
                Address and parcel sources
              </summary>
              <LandControls land={land} navigate={navigate} controls={false} />
            </details>
            <details className="panel-detail">
              <summary>
                <Compass size={17} />
                Navigation settings
              </summary>
              <div className="camera-settings">
                <label htmlFor="scroll-sensitivity">
                  Scroll sensitivity · {scrollSensitivity.toFixed(2)}×
                </label>
                <Slider
                  id="scroll-sensitivity"
                  aria-label="Mouse scroll sensitivity"
                  min={0.25}
                  max={3}
                  step={0.05}
                  value={[scrollSensitivity]}
                  onValueChange={(v) => {
                    const next = Array.isArray(v) ? v[0] : v;
                    setScrollSensitivity(next);
                    try {
                      localStorage.setItem(
                        'openview-scroll-sensitivity',
                        String(next),
                      );
                    } catch {}
                  }}
                />
                <Button
                  variant="ghost"
                  onClick={() => {
                    setScrollSensitivity(1);
                    try {
                      localStorage.setItem('openview-scroll-sensitivity', '1');
                    } catch {}
                  }}
                >
                  Reset sensitivity
                </Button>
                <p className="source-meta">
                  Left-drag moves the globe. Middle-drag rotates and tilts
                  through 360°. Scroll zooms. Terrain elevation is present on
                  every basemap.
                </p>
                <Button variant="secondary" onClick={() => navigate(PLACES[9])}>
                  Explore the Swiss Alps <ArrowUpRight size={14} />
                </Button>
              </div>
            </details>
          </LayerPanel>
          <div className="panel-footer">
            <Globe2 size={15} />
            <span>Open data. New perspectives.</span>
          </div>
        </aside>
        <section className="world" aria-label="Interactive 3D Earth">
          <Earth
            osm={osm.selection}
            onOsmStatus={osm.setRenderStatus}
            ref={globe}
            searchLocation={searchLocation}
            onView={setView}
            onPick={selectObject}
            orbits={shownOrbits}
            spaceVisible={spaceVisible}
            tracks={tracks}
            parcels={land.parcels.data}
            parcelsVisible={land.parcelsVisible}
            addresses={land.addresses.data?.items}
            addressesVisible={land.addressesVisible}
            selectedAddress={land.selectedAddress}
            onAnchor={land.setAnchor}
            selected={selected}
            layer={layer}
            labels={labels}
            scrollSensitivity={scrollSensitivity}
            offsetMinutes={offset}
            orbitPaths={paths}
            radioMarkers={radio.markers}
            radioVisible={radio.enabled}
            cellMarkers={cells.markers}
            cellVisible={cells.enabled}
            campingMarkers={camping.markers}
            campingVisible={camping.enabled}
            onCampingError={camping.report}
            coverage={coverage.selection}
            coverageOpacity={coverage.opacity}
            onCoverageStatus={coverage.setTileStatus}
            nationalParks={parks.national.data}
            stateParks={parks.state.data}
            onParkStatus={parks.report}
            onParkPick={
              parks.enabled.national || parks.enabled.state
                ? (location) => {
                    setSearchLocation(null);
                    setPendingSearch(null);
                    land.close();
                    radio.close();
                    cells.close();
                    camping.close();
                    setSelected(null);
                    void parks.inspect(location);
                  }
                : undefined
            }
          />
          {searchLocation &&
            ['place', 'coverage', 'parcel-source'].includes(
              searchLocation.target.type,
            ) && (
              <aside
                className="search-location-popup"
                aria-label="Search location details"
              >
                <div className="detail-heading">
                  <span className="eyebrow">
                    {SEARCH_LABELS[searchLocation.kind]}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Close search location"
                    onClick={() => setSearchLocation(null)}
                  >
                    <X size={16} />
                  </Button>
                </div>
                <h2>{searchLocation.name}</h2>
                <p>{searchLocation.detail}</p>
                <p>
                  {searchLocation.lat.toFixed(5)},{' '}
                  {searchLocation.lon.toFixed(5)}
                </p>
                <p>{searchLocation.source}</p>
                {searchLocation.sourceUrl && (
                  <a
                    href={searchLocation.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View source <ExternalLink size={12} />
                  </a>
                )}
              </aside>
            )}
          <AddressPopup land={land} />
          <RadioInspector radio={radio} zoom={zoomRadio} />
          <RadioInspector radio={cells} zoom={zoomRadio} kind="cells" />
          <ParkPopup parks={parks} />
          <CampingPopup
            camping={camping}
            onRecord={inspectCamping}
            fly={flyCamping}
          />
          {!open && (
            <Button
              className="reopen"
              variant="secondary"
              size="icon"
              aria-label="Open explorer"
              onClick={() => setOpen(true)}
            >
              <PanelLeftOpen />
            </Button>
          )}
          <div className="world-title">
            <span className="eyebrow">
              {view.height < 6000
                ? 'AT GROUND LEVEL'
                : view.height < 1800000
                  ? 'A CLOSER LOOK'
                  : 'THE BIG PICTURE'}
            </span>
            <h2>
              {view.height > 1800000 ? (
                <>
                  One planet.
                  <br />
                  <span>Every perspective.</span>
                </>
              ) : (
                <>
                  {region?.name || 'Explore the surface'}
                  <br />
                  <span>{LAYERS.find((l) => l.id === layer)?.name}</span>
                </>
              )}
            </h2>
          </div>
          <div className="view-badge">
            <i /> EARTH <span>3D</span>
          </div>
          {(selectedOrbit || selectedTrack) && (
            <aside
              className="object-detail"
              aria-label="Selected object details"
            >
              <div className="detail-heading">
                <span className="eyebrow">
                  {selectedOrbit
                    ? 'ORBITAL OBJECT'
                    : selectedTrack
                      ? selectedTrack.kind === 'aircraft'
                        ? 'AIRCRAFT REPORT'
                        : 'VESSEL REPORT'
                      : 'PARCEL RECORD'}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close object details"
                  onClick={() => setSelected(null)}
                >
                  <X size={16} />
                </Button>
              </div>
              <h2>
                {selectedOrbit?.OBJECT_NAME ||
                  selectedTrack?.name ||
                  'Selected object'}
              </h2>
              {selectedOrbit && (
                <>
                  <span className="detail-status">
                    <i />{' '}
                    {offset === 0 ? 'Predicted position' : 'Orbit simulation'} ·
                    SGP4
                  </span>
                  <SpaceDetails
                    object={selectedOrbit}
                    position={satPosition}
                    now={now}
                    offset={offset}
                  />
                  {Math.abs(now + offset * 60000 - epochTime(selectedOrbit)) >
                    3 * 86400000 && (
                    <p className="feed-error">
                      Older elements reduce prediction accuracy. Objects over 14
                      days from epoch are hidden.
                    </p>
                  )}
                  <Button
                    variant="secondary"
                    className="detail-action"
                    onClick={() =>
                      globe.current?.focus(String(selectedOrbit.NORAD_CAT_ID))
                    }
                  >
                    <LocateFixed />
                    Locate object
                  </Button>
                  <p className="source-meta">
                    Predicted from mean orbital elements. Maneuvers and drag can
                    change the actual path.
                  </p>
                </>
              )}
              {selectedTrack && (
                <>
                  <span className="detail-status traffic">
                    <i />
                    {selectedTrack.kind === 'ships'
                      ? now - selectedTrack.observedAt > 600000
                        ? 'Older report · fixed position'
                        : 'Reported position · fixed until next snapshot'
                      : selectedTrack.speed === null ||
                          selectedTrack.heading === null
                        ? 'Reported position · motion unavailable'
                        : now - selectedTrack.observedAt >
                            (selectedTrack.kind === 'aircraft' ? 60000 : 120000)
                          ? 'Older report · estimate frozen'
                          : 'Motion estimated from last report'}
                  </span>
                  <dl>
                    <Row
                      label={
                        selectedTrack.kind === 'aircraft' ? 'ICAO hex' : 'MMSI'
                      }
                      value={selectedTrack.id}
                    />
                    <Row
                      label="Last report"
                      value={utc(selectedTrack.observedAt)}
                    />
                    {selectedTrack.kind === 'ships' && (
                      <>
                        <Row
                          label="Source"
                          value={selectedTrack.source || sea?.source || 'AIS'}
                        />
                        {selectedTrack.timestampBasis === 'received' && (
                          <Row
                            label="Timestamp basis"
                            value="Collector receipt time; source time unavailable"
                          />
                        )}
                        {selectedTrack.destination && (
                          <Row
                            label="Reported destination"
                            value={selectedTrack.destination}
                          />
                        )}
                      </>
                    )}
                    <Row
                      label="Report age"
                      value={ageLabel(selectedTrack.observedAt, now)}
                    />
                    <Row
                      label="Speed"
                      value={
                        selectedTrack.speed === null
                          ? 'Not reported'
                          : `${selectedTrack.speed.toFixed(1)} kn`
                      }
                    />
                    <Row
                      label="Course"
                      value={
                        selectedTrack.heading === null
                          ? 'Not reported'
                          : `${selectedTrack.heading.toFixed(1)}°`
                      }
                    />
                    {selectedTrack.kind === 'aircraft' && (
                      <Row
                        label="Altitude"
                        value={
                          selectedTrack.altitudeKnown === false
                            ? 'Not reported'
                            : `${Math.round(selectedTrack.altitude / 0.3048).toLocaleString()} ft`
                        }
                      />
                    )}
                    <Row
                      label="Position"
                      value={`${trackPosition?.lat.toFixed(4)}°, ${trackPosition?.lon.toFixed(4)}°`}
                    />
                  </dl>
                  <Button
                    variant="secondary"
                    className="detail-action"
                    onClick={() =>
                      globe.current?.focus(
                        `${selectedTrack.kind}-${selectedTrack.id}`,
                      )
                    }
                  >
                    <LocateFixed />
                    Locate report
                  </Button>
                </>
              )}
            </aside>
          )}
          <div className="map-controls">
            <Button
              variant="ghost"
              size="icon"
              aria-label="North up"
              title="North up"
              onClick={() => globe.current?.north()}
            >
              <Compass />
            </Button>
            <span />
            <Button
              variant="ghost"
              size="icon"
              aria-label="Zoom in"
              title="Zoom in"
              onClick={() => globe.current?.zoom(1)}
            >
              <Plus />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Zoom out"
              title="Zoom out"
              onClick={() => globe.current?.zoom(-1)}
            >
              <Minus />
            </Button>
            <span />
            <Button
              variant="ghost"
              size="icon"
              aria-label="Reset globe"
              title="Reset globe"
              onClick={() => globe.current?.home()}
            >
              <RotateCcw />
            </Button>
          </div>
          {orbits && spaceVisible && (
            <div className="orbit-timeline">
              <div>
                <Clock3 size={14} />
                <span>
                  {offset === 0
                    ? 'NOW · PREDICTED'
                    : `${offset > 0 ? '+' : ''}${offset} MIN · SIMULATION`}
                </span>
                <button onClick={() => setOffset(0)}>Reset to now</button>
              </div>
              <Slider
                aria-label="Orbit time offset in minutes"
                min={-90}
                max={90}
                step={1}
                value={[offset]}
                onValueChange={(v) => setOffset(Array.isArray(v) ? v[0] : v)}
              />
              <footer>
                <span>−90 min</span>
                <span>Orbital time only</span>
                <span>+90 min</span>
              </footer>
            </div>
          )}
          {!orbits && (
            <div className="globe-hint">
              Drag to explore <b>·</b> Scroll to zoom <b>·</b> Middle-drag to
              rotate & tilt
            </div>
          )}
          <Button
            className="legend-launch"
            variant="secondary"
            onClick={() => {
              setOpen(true);
              requestAnimationFrame(() => {
                const guide = document.getElementById(
                  'map-legend-guide',
                ) as HTMLDetailsElement | null;
                if (guide) {
                  guide.open = true;
                  guide.scrollIntoView({ block: 'start', behavior: 'smooth' });
                }
              });
            }}
          >
            Map legend
          </Button>
          {notice && <output className="toast-message">{notice}</output>}
          <div className="coordinate-bar">
            <span>
              {Math.abs(view.lat).toFixed(3)}° {view.lat >= 0 ? 'N' : 'S'}{' '}
              <em>/</em> {Math.abs(view.lon).toFixed(3)}°{' '}
              {view.lon >= 0 ? 'E' : 'W'}
            </span>
            <span className="camera-readout">
              <span>
                CAMERA{' '}
                <strong>
                  {(view.height / 1000).toLocaleString(undefined, {
                    maximumFractionDigits: 1,
                  })}{' '}
                  km
                </strong>
              </span>
              <span title="Approximate map zoom at the center of the view. Feature detail also depends on terrain, tilt and tile loading.">
                ZOOM{' '}
                <strong>
                  {view.zoom === undefined ? '—' : `≈${view.zoom.toFixed(1)}`}
                </strong>
              </span>
            </span>
          </div>
        </section>
      </div>
    </main>
  );
}
