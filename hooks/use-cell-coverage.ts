'use client';
/* oxlint-disable react/react-compiler -- The React Compiler transform is not installed; external coverage changes synchronously invalidate stale selections before loading. */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  boundedCoverageBytes,
  coverageIndex,
  coverageManifest,
  type CoverageManifest,
  type CoverageSelection,
} from '@/lib/coverage-model';
import type { CameraView } from '@/lib/model';

export function useCellCoverage(view: CameraView) {
  const [enabled, setEnabled] = useState(false),
    [opacity, setOpacity] = useState(0.45);
  const [manifest, setManifest] = useState<CoverageManifest | null>(null),
    [layerId, setLayerId] = useState('');
  const [selection, setSelection] = useState<CoverageSelection | null>(null),
    [error, setError] = useState('');
  const [loading, setLoading] = useState(false),
    [reload, setReload] = useState(0),
    [tileStatus, setTileStatus] = useState('');
  const manifestGeneration = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController(),
      generation = ++manifestGeneration.current;
    setLoading(true);
    setError('');
    boundedCoverageBytes(
      `/coverage/latest.json?reload=${reload}`,
      controller.signal,
      1024 * 1024,
    )
      .then((bytes) =>
        coverageManifest(JSON.parse(new TextDecoder().decode(bytes))),
      )
      .then((next) => {
        if (
          controller.signal.aborted ||
          generation !== manifestGeneration.current
        )
          return;
        setManifest(next);
        setLayerId((id) =>
          next.layers.some((l) => l.id === id) ? id : next.layers[0].id,
        );
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error
              ? e.message
              : 'Coverage manifest is unavailable.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [enabled, reload]);
  useEffect(() => {
    if (!enabled || !manifest || !layerId) {
      setSelection(null);
      return;
    }
    const layer = manifest.layers.find((l) => l.id === layerId);
    if (!layer) return;
    const controller = new AbortController();
    setSelection(null);
    setLoading(true);
    setTileStatus('');
    setError('');
    boundedCoverageBytes(
      `/coverage/${manifest.release}/${layer.id}/index.json`,
      controller.signal,
      8 * 1024 * 1024,
    )
      .then((bytes) =>
        coverageIndex(
          JSON.parse(new TextDecoder().decode(bytes)),
          manifest.release,
          layer,
        ),
      )
      .then((index) => {
        if (!controller.signal.aborted)
          setSelection({ release: manifest.release, layer, index });
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error ? e.message : 'Coverage index is unavailable.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [enabled, manifest, layerId]);
  const refresh = useCallback(() => setReload((n) => n + 1), []);
  const centerInBounds =
    selection?.layer.regions.some(
      ({ rectangle: [w, s, e, n] }) =>
        view.lon >= w && view.lon <= e && view.lat >= s && view.lat <= n,
    ) ?? false;
  return {
    enabled,
    setEnabled,
    opacity,
    setOpacity,
    manifest,
    layerId,
    setLayerId,
    selection,
    error,
    loading,
    refresh,
    tileStatus,
    setTileStatus,
    centerInBounds,
  };
}
export type CellCoverage = ReturnType<typeof useCellCoverage>;
