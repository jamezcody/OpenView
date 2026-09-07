'use client';
/* oxlint-disable react/react-compiler -- Refs bridge the imperative Cesium lifecycle. */
import { useEffect, useRef, type RefObject } from 'react';
import type * as Cesium from 'cesium';
import type { OMM } from '@/lib/model';
import { isSpaceObject, SPACE_COLORS } from '@/lib/space-data';
// oxlint-disable-next-line import/default -- Vite generates this module's default worker constructor.
import SpaceWorker from '../lib/space-worker?worker';

export function useSpaceObjects({
  api,
  viewer,
  ready,
  orbits,
  visible,
  offset,
  selectedId,
  report,
}: {
  api: RefObject<typeof Cesium | null>;
  viewer: RefObject<Cesium.Viewer | null>;
  ready: number;
  orbits: OMM[];
  visible: boolean;
  offset: number;
  selectedId?: string;
  report: (message: string) => void;
}) {
  const points = useRef(new Map<string, Cesium.PointPrimitive>());
  const state = useRef({ visible, offset, selectedId });
  const refresh = useRef<(() => void) | null>(null);
  state.current = { visible, offset, selectedId };
  useEffect(() => {
    const C = api.current,
      v = viewer.current;
    if (!ready || !C || !v) return;
    const collection = v.scene.primitives.add(
      new C.PointPrimitiveCollection(),
    ) as Cesium.PointPrimitiveCollection;
    const labels = v.scene.primitives.add(
      new C.LabelCollection(),
    ) as Cesium.LabelCollection;
    const label = labels.add({
      position: C.Cartesian3.ZERO,
      show: false,
      font: '14px sans-serif',
      showBackground: true,
      pixelOffset: new C.Cartesian2(12, -12),
      horizontalOrigin: C.HorizontalOrigin.LEFT,
    });
    const names = new Map<string, string>();
    const map = new Map<string, Cesium.PointPrimitive>();
    const objects = orbits.filter(isSpaceObject);
    for (const object of objects) {
      const id = String(object.NORAD_CAT_ID);
      names.set(id, object.OBJECT_NAME);
      map.set(
        id,
        collection.add({
          id: { openviewKind: 'satellite', openviewId: id },
          show: false,
          pixelSize: 5,
          color: C.Color.fromCssColorString(SPACE_COLORS[object.objectType]),
          outlineColor: C.Color.fromCssColorString('#263a25'),
          outlineWidth: 1,
        }),
      );
    }
    points.current = map;
    type Sample = {
      point: Cesium.PointPrimitive;
      a: Cesium.Cartesian3;
      b: Cesium.Cartesian3;
    };
    let samples: Sample[] = [],
      sampleTime = 0,
      busy = false,
      failed = false;
    let previousSelected: string | undefined;
    let worker: Worker | undefined;
    const fail = () => {
      failed = true;
      collection.show = false;
      label.show = false;
      report(
        'Space positions could not be calculated. Reload the page to retry.',
      );
      v.scene.requestRender();
    };
    const calculate = () => {
      if (
        busy ||
        failed ||
        document.hidden ||
        !state.current.visible ||
        !worker
      )
        return;
      busy = true;
      worker.postMessage({
        type: 'positions',
        time: Date.now(),
        offset: state.current.offset,
      });
    };
    const invalidate = () => {
      samples = [];
      for (const point of map.values()) point.show = false;
      calculate();
      v.scene.requestRender();
    };
    refresh.current = invalidate;
    if (objects.length) {
      try {
        // A worker import avoids the RSC transform replacing import.meta.url
        // with a server-side file URL in the browser's development bundle.
        worker = new SpaceWorker();
        worker.onerror = fail;
        worker.onmessage = ({
          data,
        }: MessageEvent<{
          positions: Float64Array;
          time: number;
          offset: number;
        }>) => {
          busy = false;
          if (data.offset !== state.current.offset) {
            calculate();
            return;
          }
          sampleTime = data.time;
          samples = [];
          const p = data.positions;
          for (let i = 0; i < p.length; i += 7) {
            const point = map.get(String(p[i]));
            if (!point) continue;
            point.show = Number.isFinite(p[i + 1]);
            if (point.show)
              samples.push({
                point,
                a: C.Cartesian3.fromDegrees(p[i + 1], p[i + 2], p[i + 3]),
                b: C.Cartesian3.fromDegrees(p[i + 4], p[i + 5], p[i + 6]),
              });
          }
          v.scene.requestRender();
        };
        worker.postMessage({ type: 'init', objects });
        calculate();
      } catch {
        fail();
      }
    }
    const scratch = new C.Cartesian3();
    const removeRender = v.scene.preRender.addEventListener(() => {
      collection.show = state.current.visible && !failed;
      label.show = false;
      if (!collection.show || document.hidden) return;
      const t = Math.min(1, Math.max(0, (Date.now() - sampleTime) / 3000));
      for (const sample of samples)
        sample.point.position = C.Cartesian3.lerp(
          sample.a,
          sample.b,
          t,
          scratch,
        );
      const id = state.current.selectedId;
      if (previousSelected !== id) {
        const previous = previousSelected && map.get(previousSelected);
        if (previous) previous.pixelSize = 5;
        previousSelected = id;
      }
      const selected = id ? map.get(id) : undefined;
      if (selected?.show) {
        selected.pixelSize = 11;
        label.show = true;
        label.id = { openviewKind: 'satellite', openviewId: id };
        label.text = names.get(id!) || '';
        label.position = selected.position;
      }
    });
    const timer = setInterval(calculate, 2000);
    const resume = () => {
      if (!document.hidden) invalidate();
    };
    document.addEventListener('visibilitychange', resume);
    return () => {
      clearInterval(timer);
      worker?.terminate();
      removeRender();
      document.removeEventListener('visibilitychange', resume);
      refresh.current = null;
      if (points.current === map) points.current = new Map();
      if (!v.isDestroyed()) {
        v.scene.primitives.remove(collection);
        v.scene.primitives.remove(labels);
      }
    };
  }, [api, viewer, ready, orbits, report]);
  useEffect(() => {
    refresh.current?.();
  }, [visible, offset]);
  return points;
}
