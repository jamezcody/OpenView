'use client';
/* oxlint-disable react/react-compiler -- Match the existing map-data hooks: external camera/layer changes synchronously invalidate stale markers before starting cancellable requests. */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { EarthHandle } from '@/components/earth';
import type { CameraView } from '@/lib/model';
import { CampingData, campRequest } from '@/lib/camping-data';
import {
  filterCampMarkers,
  PAYMENTS,
  type Payment,
  type CampLayer,
  type CampMarker,
  type CampManifest,
  type CampRecord,
} from '@/lib/camping-model';

export function useCamping(
  globe: RefObject<EarthHandle | null>,
  view: CameraView,
) {
  const [layers, setLayers] = useState<CampLayer[]>([]),
    [payments, setPayments] = useState<Payment[]>([...PAYMENTS]);
  const [manifest, setManifest] = useState<CampManifest | null>(null),
    [markers, setMarkers] = useState<CampMarker[]>([]);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [limited, setLimited] = useState(false),
    [revision, setRevision] = useState(0);
  const [selection, setSelection] = useState<{
      id: string;
      version: string;
    } | null>(null),
    [record, setRecord] = useState<CampRecord | null>(null),
    [inspectionError, setInspectionError] = useState(''),
    [inspecting, setInspecting] = useState(false);
  const [children, setChildren] = useState<
      [string, string, [number, number] | null][]
    >([]),
    [childPage, setChildPage] = useState(0),
    [childPages, setChildPages] = useState(0);
  const [detailManifest, setDetailManifest] = useState<CampManifest | null>(
    null,
  );
  const data = useRef<CampingData | null>(null),
    detailData = useRef<CampingData | null>(null);
  if (!data.current) data.current = new CampingData();
  if (!detailData.current) detailData.current = new CampingData();
  const close = useCallback(() => setSelection(null), []);
  const inspect = useCallback((id: string, version: string) => {
    setChildPage(0);
    setSelection({ id, version });
  }, []);
  const toggle = useCallback((layer: CampLayer, enabled: boolean) => {
    setLayers((old) =>
      enabled ? [...new Set([...old, layer])] : old.filter((l) => l !== layer),
    );
    setSelection(null);
  }, []);
  const enabled = layers.length > 0;
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    setMarkers([]);
    setManifest(null);
    if (!enabled) {
      data.current!.clear();
      setLoading(false);
      return;
    }
    setLoading(true);
    void data
      .current!.manifest(campRequest(controller.signal))
      .then((m) => {
        if (!controller.signal.aborted) setManifest(m);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [enabled, revision]);
  useEffect(() => {
    // Filter changes invalidate the old result, but camera changes do not:
    // retain visible markers while the debounced close-view query catches up.
    setMarkers((current) =>
      filterCampMarkers(
        current,
        manifest?.version,
        enabled ? layers : [],
        enabled ? payments : [],
      ),
    );
    setLimited(false);
  }, [enabled, manifest, layers, payments]);
  useEffect(() => {
    const controller = new AbortController();
    if (!enabled || !manifest || !payments.length) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    const timer = setTimeout(() => {
      const bounds = globe.current?.bounds();
      if (!bounds) {
        setMarkers([]);
        setLimited(false);
        setError('Point the camera toward Earth to load camping records.');
        setLoading(false);
        return;
      }
      void data
        .current!.view(
          manifest,
          [bounds.west, bounds.south, bounds.east, bounds.north],
          view.height,
          layers,
          payments,
          campRequest(controller.signal),
        )
        .then((result) => {
          if (!controller.signal.aborted) {
            setMarkers(result.markers);
            setLimited(result.limited);
          }
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, manifest, layers, payments, view, globe]);
  useEffect(() => {
    const controller = new AbortController();
    setRecord(null);
    setChildren([]);
    setChildPages(0);
    setInspectionError('');
    if (!selection) {
      setInspecting(false);
      detailData.current!.clear();
      return;
    }
    setInspecting(true);
    const run = async () => {
      const request = campRequest(controller.signal),
        m = await detailData.current!.manifest(request, selection.version);
      const r = await detailData.current!.record(m, selection.id, request);
      if (!r)
        throw new Error(
          'This record is unavailable in the selected camping release. Refresh search.',
        );
      if (controller.signal.aborted) return;
      setDetailManifest(m);
      setRecord(r);
      if (r.children_count) {
        const result = await detailData.current!.children(
          m,
          r.id,
          childPage,
          request,
        );
        if (!controller.signal.aborted) {
          setChildren(result.items);
          setChildPages(result.pages);
        }
      }
    };
    void run()
      .catch((e) => {
        if (!controller.signal.aborted) setInspectionError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setInspecting(false);
      });
    return () => controller.abort();
  }, [selection, childPage]);
  useEffect(
    () => () => {
      data.current?.clear();
      detailData.current?.clear();
    },
    [],
  );
  return {
    layers,
    payments,
    setPayments,
    toggle,
    enabled,
    manifest,
    detailManifest,
    markers,
    loading,
    error,
    limited,
    selection,
    record,
    children,
    childPage,
    childPages,
    setChildPage,
    inspectionError,
    inspecting,
    inspect,
    close,
    reload: () => {
      data.current!.clear();
      setRevision((n) => n + 1);
    },
    report: setError,
  };
}
export type CampingState = ReturnType<typeof useCamping>;
