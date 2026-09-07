'use client';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RadioFilter } from '@/components/radio-controls';
import type { RadioSites } from '@/hooks/use-radio-sites';
import type { RadioMarker } from '@/lib/radio-model';

export function CellControls({
  cells,
  inspect,
}: {
  cells: RadioSites;
  inspect: (marker: RadioMarker) => void;
}) {
  const m = cells.manifest;
  const count = cells.markers.reduce((n, p) => n + p.count, 0);
  const update = (key: 'network' | 'service', value: string) =>
    cells.setFilters((old) => ({ ...old, [key]: value }));
  return (
    <section
      className="radio-controls"
      aria-label="Cell locations controls"
      data-cell-version={m?.version}
      data-cell-markers={cells.markers.length}
      data-cell-requests={cells.metrics.requests}
      data-cell-bytes={cells.metrics.bytes}
    >
      <div className="section-title">
        <h2>Estimated cell locations</h2>
      </div>
      <p className="radio-note">
        U.S. networks — MCC 310–314. Crowdsourced cell records, not a surveyed
        tower inventory. Physical country is not established by the network
        code.
      </p>
      {m && (
        <>
          <RadioFilter
            prefix="Cell"
            name="Networks"
            value={cells.filters.network || '*'}
            values={m.facets.networks || []}
            labels={m.networkLabels}
            includeUnknown={false}
            change={(v) => update('network', v)}
          />
          <RadioFilter
            prefix="Cell"
            name="Technologies"
            value={cells.filters.service}
            values={m.facets.services}
            includeUnknown={false}
            change={(v) => update('service', v)}
          />
          <p className="radio-note">
            {m.counts.candidates.toLocaleString()} estimated cell records.{' '}
            Prepared {new Date(m.createdAt).toLocaleDateString()}. Source dates
            appear in each record.
          </p>
        </>
      )}
      <p className="radio-note">
        <output>
          {!cells.enabled
            ? 'Off. Enable Cell locations to load this dataset.'
            : cells.refreshing
              ? 'Checking the prepared dataset…'
              : cells.loading
                ? 'Loading cells in this view…'
                : cells.error
                  ? cells.error
                  : m
                    ? count
                      ? `${count.toLocaleString()} matching records in visible map cells.`
                      : 'No matching records in this loaded area. This does not establish absence of service.'
                    : 'Dataset unavailable.'}
        </output>
      </p>
      {cells.manifestError && (
        <p role="alert" className="feed-error">
          {cells.manifestError}
          {m
            ? ' The previous valid dataset remains available.'
            : ' Cell data has not loaded.'}
        </p>
      )}
      {cells.limited && (
        <p className="feed-error">
          <output>
            View limit reached; some records are not shown. Zoom closer or
            select a network or technology.
          </output>
        </p>
      )}
      <Button
        variant="secondary"
        className="secondary-action"
        disabled={!cells.enabled || cells.refreshing}
        onClick={cells.reload}
      >
        <RefreshCw size={15} /> Reload prepared cell data
      </Button>
      <p className="radio-note">
        Reload checks the locally prepared release. Source downloads run
        offline; the browser never queries OpenCellID. Exports cover recent
        observations and are incomplete.
      </p>
      {cells.enabled && cells.markers.length > 0 && (
        <details>
          <summary>Browse visible cell groups</summary>
          <div className="radio-groups">
            {cells.markers.slice(0, 30).map((p) => (
              <Button
                key={p.id}
                variant="ghost"
                className="radio-group"
                onClick={() => inspect(p)}
              >
                {p.count.toLocaleString()} cell{' '}
                {p.count === 1 ? 'record' : 'records'} · {p.lat.toFixed(3)},{' '}
                {p.lon.toFixed(3)}
              </Button>
            ))}
          </div>
          {cells.markers.length > 30 && (
            <p className="radio-note">
              First 30 groups listed; additional groups are selectable on the
              map.
            </p>
          )}
        </details>
      )}
      <p className="radio-note">
        Data:{' '}
        <a href="https://opencellid.org/" target="_blank" rel="noreferrer">
          OpenCellID
        </a>{' '}
        © OpenCellID contributors,{' '}
        <a
          href="https://creativecommons.org/licenses/by-sa/4.0/"
          target="_blank"
          rel="noreferrer"
        >
          CC BY-SA 4.0
        </a>
        . Network labels:{' '}
        <a
          href="https://imsiadmin.com/assignments/hni/"
          target="_blank"
          rel="noreferrer"
        >
          U.S. IMSI administrator
        </a>
        . Names identify allocation assignees, not tower owners.
      </p>
    </section>
  );
}
