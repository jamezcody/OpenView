'use client';
/* oxlint-disable react/react-compiler -- The React Compiler transform is not installed; external park-layer changes synchronously invalidate stale prepared data. */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  parseParkManifest,
  parseParkRecords,
  type ParkKind,
  type ParkLayer,
  type ParkManifest,
  type ParkRecord,
} from '@/lib/park-model';
import type { ParkArchive } from '@/lib/park-data';
export type ParkSelection = {
  layer: ParkLayer;
  archive: ParkArchive;
  records: Map<string, ParkRecord>;
};
export type ParkLayerState = {
  data: ParkSelection | null;
  loading: boolean;
  error: string;
};
function useParkLayer(
  kind: ParkKind,
  enabled: boolean,
  manifest: ParkManifest | null,
  revision: number,
) {
  const [state, setState] = useState<ParkLayerState>({
    data: null,
    loading: false,
    error: '',
  });
  useEffect(() => {
    if (!enabled || !manifest) {
      setState({ data: null, loading: false, error: '' });
      return;
    }
    const layer = manifest.layers.find((l) => l.id === kind)!;
    const controller = new AbortController();
    let archive: ParkArchive | undefined;
    setState({ data: null, loading: true, error: '' });
    void (async () => {
      const { ParkArchive, parkJson } = await import('@/lib/park-data');
      controller.signal.throwIfAborted();
      const root = `/parks/${manifest.release}`;
      archive = new ParkArchive(`${root}/${layer.file}`, layer);
      controller.signal.addEventListener('abort', () => archive?.close(), {
        once: true,
      });
      const [raw] = await Promise.all([
        parkJson(
          `${root}/${layer.records.file}`,
          controller.signal,
          layer.records.bytes,
          layer.records.sha256,
        ),
        archive.ready(),
      ]);
      const records = parseParkRecords(raw, layer);
      if (!controller.signal.aborted)
        setState({
          data: { layer, archive, records },
          loading: false,
          error: '',
        });
    })().catch((e) => {
      archive?.close();
      if (!controller.signal.aborted)
        setState({
          data: null,
          loading: false,
          error: e instanceof Error ? e.message : 'Park data could not load.',
        });
    });
    return () => {
      controller.abort();
      archive?.close();
    };
  }, [kind, enabled, manifest, revision]);
  return state;
}
export function useParks() {
  const [enabled, setEnabled] = useState<Record<ParkKind, boolean>>({
    national: false,
    state: false,
  });
  const [manifest, setManifest] = useState<ParkManifest | null>(null),
    [manifestError, setManifestError] = useState(''),
    [manifestLoading, setManifestLoading] = useState(false),
    [revision, setRevision] = useState(0);
  const anyEnabled = enabled.national || enabled.state;
  useEffect(() => {
    if (!anyEnabled) return;
    const controller = new AbortController();
    setManifestLoading(true);
    setManifestError('');
    void import('@/lib/park-data')
      .then(({ parkJson }) =>
        parkJson(
          `/parks/latest.json?reload=${revision}`,
          controller.signal,
          1024 * 1024,
        ),
      )
      .then((raw) => {
        if (!controller.signal.aborted) setManifest(parseParkManifest(raw));
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setManifestError(
            e instanceof Error ? e.message : 'Park catalog is unavailable.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setManifestLoading(false);
      });
    return () => controller.abort();
  }, [anyEnabled, revision]);
  const national = useParkLayer(
      'national',
      enabled.national,
      manifest,
      revision,
    ),
    state = useParkLayer('state', enabled.state, manifest, revision);
  const [renderStatus, setRenderStatus] = useState<
    Record<ParkKind, { message: string; failed: boolean }>
  >({
    national: { message: '', failed: false },
    state: { message: '', failed: false },
  });
  const report = useCallback(
    (kind: ParkKind, message: string, failed = false) =>
      setRenderStatus((s) => ({ ...s, [kind]: { message, failed } })),
    [],
  );
  const [inspection, setInspection] = useState<{
    location: { lat: number; lon: number };
    loading: boolean;
    records: (ParkRecord & { kind: ParkKind })[];
    error: string;
  } | null>(null);
  const generation = useRef(0);
  const close = useCallback(() => {
    generation.current++;
    setInspection(null);
  }, []);
  const toggle = useCallback(
    (kind: ParkKind, value: boolean) => {
      close();
      setEnabled((e) => ({ ...e, [kind]: value }));
      report(kind, '');
    },
    [close, report],
  );
  const reload = useCallback(() => {
    close();
    setRevision((n) => n + 1);
  }, [close]);
  const inspect = useCallback(
    async (location: { lat: number; lon: number }) => {
      const token = ++generation.current;
      setInspection({ location, loading: true, records: [], error: '' });
      const selections: [ParkKind, ParkLayerState][] = [
        ['national', national],
        ['state', state],
      ];
      const results = await Promise.all(
        selections
          .filter(([kind]) => enabled[kind])
          .map(async ([kind, value]) => {
            if (!value.data)
              return {
                records: [],
                error: `${kind === 'national' ? 'National' : 'State'} park data is not ready. ${value.error}`,
              };
            try {
              const ids = await value.data.archive.identify(
                location.lon,
                location.lat,
              );
              return {
                records: ids.map((id) => {
                  const r = value.data!.records.get(id);
                  if (!r)
                    throw new Error('Park tile contains an unknown record.');
                  return { ...r, kind };
                }),
                error: '',
              };
            } catch (e) {
              return {
                records: [],
                error:
                  e instanceof Error
                    ? e.message
                    : 'Park details could not load.',
              };
            }
          }),
      );
      if (token !== generation.current) return;
      setInspection({
        location,
        loading: false,
        records: results.flatMap((r) => r.records),
        error: results
          .map((r) => r.error)
          .filter(Boolean)
          .join(' '),
      });
    },
    [national, state, enabled],
  );
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const selectRecord = useCallback(
    (kind: ParkKind, id: string, location: { lat: number; lon: number }) => {
      const record = (kind === 'national' ? national : state).data?.records.get(
        id,
      );
      generation.current++;
      setInspection({
        location,
        loading: false,
        records: record ? [{ ...record, kind }] : [],
        error: record
          ? ''
          : 'The selected park is missing from this release. Reload search and park data.',
      });
    },
    [national, state],
  );
  return {
    enabled,
    toggle,
    national,
    state,
    manifest,
    manifestError,
    manifestLoading,
    renderStatus,
    report,
    inspection,
    inspect,
    selectRecord,
    close,
    reload,
  };
}
export type Parks = ReturnType<typeof useParks>;
