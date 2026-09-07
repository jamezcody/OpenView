'use client';
/* oxlint-disable react/react-compiler -- Refs bridge the imperative Cesium lifecycle. */
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { OsmPickResult } from '@/lib/osm-pick';
import type * as Cesium from 'cesium';
import { OSM_LIMITS, type OsmSelection } from '@/lib/osm-model';
// oxlint-disable-next-line import/default -- Vite generates this module's default worker constructor.
import OsmWorker from '../lib/osm-worker?worker';
export function useOsmImagery(
  selection: OsmSelection | null,
  ready: number,
  api: RefObject<typeof Cesium | null>,
  viewer: RefObject<Cesium.Viewer | null>,
  report?: (message: string) => void,
) {
  const [popup, setPopup] = useState<
    (OsmPickResult & { loading?: boolean; error?: string }) | null
  >(null);
  const pickAt = useRef<((position: Cesium.Cartesian2) => void) | null>(null);
  const pickGeneration = useRef(0);
  const closePopup = () => {
    pickGeneration.current++;
    setPopup(null);
  };
  const callback = useRef(report);
  callback.current = report;
  useEffect(() => {
    pickGeneration.current++;
    setPopup(null);
    const C = api.current,
      v = viewer.current;
    if (!selection?.layers.length || !ready || !C || !v) return;
    if (
      typeof OffscreenCanvas === 'undefined' ||
      typeof Worker === 'undefined'
    ) {
      callback.current?.(
        'This browser needs OffscreenCanvas support to display imported OSM. Use a current browser.',
      );
      return;
    }
    let worker: Worker;
    try {
      // Explicit worker imports retain a web asset URL through the RSC build.
      worker = new OsmWorker();
    } catch {
      callback.current?.(
        'The OSM renderer could not start. Turn its layers off and on to retry.',
      );
      return;
    }
    const waiting = new Map<
      number,
      {
        resolve: (canvas: HTMLCanvasElement) => void;
        reject: (error: Error) => void;
      }
    >();
    const picks = new Map<
      number,
      {
        resolve: (result: OsmPickResult) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    const clearPicks = (message: string) => {
      for (const item of picks.values()) {
        clearTimeout(item.timer);
        item.reject(new Error(message));
      }
      picks.clear();
    };
    let sequence = 0,
      disposed = false,
      failed = false;
    const fail = (message: string) => {
      failed = true;
      worker.terminate();
      callback.current?.(message);
      for (const item of waiting.values()) item.reject(new Error(message));
      waiting.clear();
      clearPicks(message);
    };
    worker.onerror = () =>
      fail(
        'The OSM renderer stopped. Disable and re-enable the dataset to retry.',
      );
    worker.onmessage = (
      event: MessageEvent<{
        id: number;
        type?: string;
        features?: OsmPickResult['features'];
        bitmap?: ImageBitmap;
        limited?: boolean;
        error?: string;
      }>,
    ) => {
      const result = event.data;
      if (result.type === 'pick') {
        const pending = picks.get(result.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        picks.delete(result.id);
        if (result.error) pending.reject(new Error(result.error));
        else
          pending.resolve({
            features: result.features || [],
            limited: Boolean(result.limited),
          });
        return;
      }
      const item = waiting.get(result.id);
      waiting.delete(result.id);
      if (!item || disposed) {
        result.bitmap?.close();
        return;
      }
      if (result.error || !result.bitmap) {
        const message = result.error || 'OSM rendering failed.';
        item.reject(new Error(message));
        fail(message);
        return;
      }
      // Cesium owns the small display canvas; release the transferred worker bitmap immediately.
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      const context = canvas.getContext('2d');
      if (!context) {
        result.bitmap.close();
        item.reject(new Error('Canvas unavailable.'));
        return;
      }
      context.drawImage(result.bitmap, 0, 0);
      result.bitmap.close();
      item.resolve(canvas);
      callback.current?.(
        result.limited
          ? 'Dense area: some detail is limited. Zoom closer for more.'
          : 'Buildings appear at neighborhood scale; small features appear closer.',
      );
      if (!v.isDestroyed()) v.scene.requestRender();
    };
    worker.postMessage({
      type: 'init',
      maximum: selection.maxZoom,
      layers: selection.layers,
      url: new URL(
        `/local-osm/tiles/${selection.id}.pmtiles`,
        window.location.origin,
      ).href,
    });
    const provider = new C.UrlTemplateImageryProvider({
      url: '/local-osm/display/{z}/{x}/{y}',
      minimumLevel: 0,
      maximumLevel: 19,
      tilingScheme: new C.WebMercatorTilingScheme(),
      enablePickFeatures: true,
      credit: new C.Credit(
        '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors · ODbL</a>',
        true,
      ),
    });
    provider.requestImage = (x, y, z) => {
      if (disposed || failed || waiting.size >= OSM_LIMITS.concurrent)
        return undefined;
      if (z < selection.minZoom) {
        const blank = document.createElement('canvas');
        blank.width = blank.height = 256;
        return Promise.resolve(blank);
      }
      const id = ++sequence;
      return new Promise<HTMLCanvasElement>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        worker.postMessage({ type: 'tile', id, z, x, y });
      });
    };
    provider.pickFeatures = (x, y, z, longitude, latitude) => {
      if (disposed || failed) return undefined;
      const count = 2 ** z;
      const px = ((longitude / (2 * Math.PI) + 0.5) * count - x) * 256;
      const py =
        (((1 - Math.log(Math.tan(Math.PI / 4 + latitude / 2)) / Math.PI) / 2) *
          count -
          y) *
        256;
      const id = ++sequence;
      return new Promise<OsmPickResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          picks.delete(id);
          reject(new Error('Feature lookup timed out. Click again to retry.'));
        }, 20000);
        picks.set(id, { resolve, reject, timer });
        worker.postMessage({ type: 'pick', id, z, x, y, px, py });
      }).then((result) => {
        // Return a sentinel for an empty/limited result so the popup can explain it.
        const info = new C.ImageryLayerFeatureInfo();
        info.data = { openviewOsm: result };
        return [info];
      });
    };
    const imagery = v.imageryLayers.addImageryProvider(provider);
    pickAt.current = (position) => {
      const generation = ++pickGeneration.current;
      const ray = v.camera.getPickRay(position);
      if (!ray) {
        setPopup(null);
        return;
      }
      setPopup({ features: [], limited: false, loading: true });
      const lookup = v.imageryLayers.pickImageryLayerFeatures(ray, v.scene);
      if (!lookup) {
        setPopup({ features: [], limited: false });
        return;
      }
      void lookup
        .then((results) => {
          if (disposed || generation !== pickGeneration.current) return;
          setPopup(
            results.find((result) => result.data?.openviewOsm)?.data
              .openviewOsm || { features: [], limited: false },
          );
        })
        .catch((error) => {
          if (!disposed && generation === pickGeneration.current)
            setPopup({
              features: [],
              limited: false,
              error:
                error instanceof Error
                  ? error.message
                  : 'Feature lookup failed.',
            });
        });
    };
    v.scene.requestRender();
    return () => {
      disposed = true;
      pickAt.current = null;
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- Intentionally invalidate requests through the shared generation counter.
      pickGeneration.current++;
      clearPicks('Cancelled');
      worker.terminate();
      for (const item of waiting.values())
        item.reject(new DOMException('Cancelled', 'AbortError'));
      waiting.clear();
      if (!v.isDestroyed() && v.imageryLayers.contains(imagery)) {
        v.imageryLayers.remove(imagery, true);
        v.scene.requestRender();
      }
    };
  }, [selection, ready, api, viewer]);
  return { popup, pickAt, closePopup };
}
