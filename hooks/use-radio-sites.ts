'use client';
/* oxlint-disable react/react-compiler -- The React Compiler transform is not installed; refs and invalidation effects intentionally coordinate the bounded external data loader. */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { EarthHandle } from '@/components/earth';
import type { CameraView } from '@/lib/model';
import { RadioData, RadioInspection } from '@/lib/radio-data';
import {
  DEFAULT_RADIO_FILTERS,
  radioDepth,
  radioFilterError,
  type RadioFilters,
  type RadioManifest,
  type RadioMarker,
  type RadioRecord,
} from '@/lib/radio-model';

export function useRadioSites(
  globe: RefObject<EarthHandle | null>,
  view: CameraView,
  base: '/radio' | '/cells' = '/radio',
) {
  const [enabled, setEnabled] = useState(false),
    [filters, setFilters] = useState<RadioFilters>(DEFAULT_RADIO_FILTERS);
  const [manifest, setManifest] = useState<RadioManifest | null>(null),
    [manifestError, setManifestError] = useState('');
  const [revision, setRevision] = useState(0),
    [refreshing, setRefreshing] = useState(false);
  const [markers, setMarkers] = useState<RadioMarker[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [limited, setLimited] = useState(false);
  const [metrics, setMetrics] = useState({ requests: 0, bytes: 0 });
  const [selection, setSelection] = useState<RadioMarker | null>(null),
    [records, setRecords] = useState<RadioRecord[]>([]),
    [more, setMore] = useState(false),
    [inspecting, setInspecting] = useState(false),
    [inspectionError, setInspectionError] = useState('');
  const data = useRef<RadioData | null>(null);
  if (!data.current) data.current = new RadioData(undefined, base);
  const inspection = useRef<RadioInspection | null>(null),
    inspectionAbort = useRef<AbortController | null>(null);
  const manifestEnabled = base !== '/cells' || enabled,
    manifestVersion = manifest?.version;
  const close = useCallback(() => {
    inspectionAbort.current?.abort();
    inspection.current = null;
    setSelection(null);
    setRecords([]);
    setInspectionError('');
    setInspecting(false);
  }, []);
  useEffect(() => {
    if (!manifestEnabled) {
      setRefreshing(false);
      return;
    }
    const controller = new AbortController();
    setRefreshing(true);
    setManifestError('');
    void data
      .current!.manifest(controller.signal)
      .then((m) => {
        if (!controller.signal.aborted) setManifest(m);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setManifestError(
            e instanceof Error ? e.message : 'Dataset unavailable.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setRefreshing(false);
      });
    return () => controller.abort();
  }, [revision, base, manifestEnabled]);
  useEffect(() => {
    close();
  }, [filters, manifestVersion, enabled, close]);
  useEffect(() => {
    const controller = new AbortController();
    setMarkers([]);
    setError('');
    setLimited(false);
    if (
      !enabled ||
      !manifest ||
      radioFilterError(filters) ||
      !filters.categories.length
    ) {
      setLoading(false);
      return () => controller.abort();
    }
    setLoading(true);
    const timer = setTimeout(() => {
      const bounds = globe.current?.bounds();
      if (!bounds) {
        setError(
          `Point the camera toward Earth to load ${base === '/cells' ? 'cell locations' : 'radio sites'}.`,
        );
        setLoading(false);
        return;
      }
      void data
        .current!.view(
          manifest,
          bounds,
          radioDepth(view.height),
          filters,
          controller.signal,
        )
        .then((result) => {
          if (controller.signal.aborted) return;
          setMarkers(result.markers);
          setLimited(result.limited);
          setMetrics({ requests: result.requests, bytes: result.bytes });
        })
        .catch((e) => {
          if (!controller.signal.aborted)
            setError(
              e instanceof Error ? e.message : 'Radio sites could not load.',
            );
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    enabled,
    manifest,
    filters,
    view.lat,
    view.lon,
    view.height,
    view.heading,
    view.pitch,
    revision,
    globe,
    base,
  ]);
  const loadMore = useCallback(async () => {
    const current = inspection.current;
    if (!current) return;
    inspectionAbort.current?.abort();
    const controller = new AbortController();
    inspectionAbort.current = controller;
    setInspecting(true);
    setInspectionError('');
    try {
      const page = await current.next(controller.signal);
      if (!controller.signal.aborted) {
        setRecords(page.records);
        setMore(page.more);
        if (page.limited)
          setInspectionError(
            'Search limit reached. Continue to search the next prepared files.',
          );
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setInspectionError(
          e instanceof Error ? e.message : 'Record details unavailable.',
        );
    } finally {
      if (!controller.signal.aborted) setInspecting(false);
    }
  }, []);
  const inspect = useCallback(
    (marker: RadioMarker) => {
      if (!manifest) return;
      inspectionAbort.current?.abort();
      setSelection(marker);
      setRecords([]);
      setMore(false);
      inspection.current = new RadioInspection(
        data.current!,
        manifest.version,
        marker,
        filters,
      );
      void loadMore();
    },
    [manifest, filters, loadMore],
  );
  useEffect(() => () => inspectionAbort.current?.abort(), []);
  return {
    enabled,
    setEnabled,
    filters,
    setFilters,
    manifest,
    manifestError,
    refreshing,
    reload: () => setRevision((n) => n + 1),
    markers,
    loading,
    error,
    limited,
    metrics,
    selection,
    records,
    more,
    inspecting,
    inspectionError,
    inspect,
    close,
    loadMore,
  };
}
export type RadioSites = ReturnType<typeof useRadioSites>;
