'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  OSM_LAYERS,
  type OsmLayer,
  type OsmLibrary,
  type OsmSelection,
} from '@/lib/osm-model';
import { readBounded } from '@/lib/bounded-fetch';
const readJson = async (response: Response) => {
  const data = JSON.parse(
    new TextDecoder().decode(await readBounded(response, 2 * 1024 * 1024)),
  );
  if (!response.ok) throw new Error(data.error || 'Local data request failed.');
  return data;
};
export function useOsm() {
  const [library, setLibrary] = useState<OsmLibrary | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [pendingAction, setPendingAction] = useState('');
  const [renderStatus, setRenderStatus] = useState('');
  const [layers, setLayers] = useState<OsmLayer[]>([]);
  const nonce = useRef('');
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    const response = await fetch('/local-osm/status', {
      signal: AbortSignal.timeout(5000),
      cache: 'no-store',
    });
    if (
      !response.ok ||
      !response.headers.get('content-type')?.includes('application/json')
    )
      throw new Error(
        'OSM import is available in the local OpenView app. Start the updated OpenView controller.',
      );
    const data = (await readJson(response)) as OsmLibrary;
    if (
      data.schemaVersion !== 1 ||
      !Array.isArray(data.datasets) ||
      typeof data.nonce !== 'string'
    )
      throw new Error('Update the local OpenView server to use OSM imports.');
    nonce.current = data.nonce;
    if (alive.current) setLibrary(data);
    return data;
  }, []);
  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await refresh();
        if (alive.current)
          timer = setTimeout(
            () => {
              void poll();
            },
            data.busy ? 1500 : 10000,
          );
      } catch (e) {
        if (alive.current) {
          setError(
            e instanceof Error
              ? e.message
              : 'Local OSM service is unavailable.',
          );
          timer = setTimeout(() => {
            void poll();
          }, 10000);
        }
      }
    };
    void poll();
    return () => {
      alive.current = false;
      clearTimeout(timer);
    };
  }, [refresh]);
  const request = useCallback(
    async <T>(action: string, body: object = {}): Promise<T> => {
      setPending(true);
      setPendingAction(action);
      setError('');
      try {
        if (!nonce.current) await refresh();
        const response = await fetch(`/local-osm/${action}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-OpenView-Local': nonce.current,
          },
          body: JSON.stringify(body),
        });
        const data = await readJson(response);
        if (data?.schemaVersion === 1 && alive.current) setLibrary(data);
        return data as T;
      } catch (e) {
        const message =
          e instanceof Error ? e.message : 'Local data operation failed.';
        if (alive.current) setError(message);
        throw e;
      } finally {
        if (alive.current) {
          setPending(false);
          setPendingAction('');
        }
      }
    },
    [refresh],
  );
  const active = library?.datasets.find(
    (d) => d.enabled && d.status === 'ready',
  );
  const activeId = active?.id,
    prepared = active?.prepared,
    minZoom = active?.minZoom,
    maxZoom = active?.maxZoom;
  const selection = useMemo<OsmSelection | null>(
    () =>
      activeId && prepared
        ? {
            id: activeId,
            prepared,
            minZoom: minZoom ?? 0,
            maxZoom: maxZoom ?? 14,
            layers,
          }
        : null,
    [activeId, prepared, minZoom, maxZoom, layers],
  );
  return {
    library,
    error,
    pending,
    pendingAction,
    request,
    selection,
    renderStatus,
    setRenderStatus,
    layers,
    setLayers: (next: OsmLayer[]) =>
      setLayers(
        [...new Set(next)].filter((layer) => OSM_LAYERS.includes(layer)),
      ),
    toggleLayer: (layer: OsmLayer, enabled: boolean) =>
      setLayers((previous) =>
        enabled
          ? [...new Set([...previous, layer])]
          : previous.filter((l) => l !== layer),
      ),
  };
}
export type OsmControlsState = ReturnType<typeof useOsm>;
