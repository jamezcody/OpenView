'use client';
import { useEffect, useRef } from 'react';
import { Trees, X, ExternalLink, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  PARK_COLORS,
  PARK_LABELS,
  parkSourceUrl,
  type ParkKind,
} from '@/lib/park-model';
import type { Parks } from '@/hooks/use-parks';
import type { CameraView } from '@/lib/model';
export function ParkControls({
  parks,
  navigate,
  controls = true,
}: {
  parks: Parks;
  navigate: (view: CameraView) => void;
  controls?: boolean;
}) {
  return (
    <section className="park-controls" aria-label="Park boundary controls">
      <div className="section-title">
        <h2>Park boundaries</h2>
        <Trees size={18} />
      </div>
      {(['national', 'state'] as ParkKind[]).map((kind) => {
        const state = parks[kind],
          status = parks.renderStatus[kind],
          layer = state.data?.layer,
          controlId = `park-${kind}-visible`;
        return (
          <div key={kind} className="park-control">
            {controls && (
              <label className="toggle-row" htmlFor={controlId}>
                <span>
                  <strong>
                    <i
                      className="park-swatch"
                      style={{
                        borderColor: PARK_COLORS[kind],
                        background: `${PARK_COLORS[kind]}22`,
                      }}
                    />
                    {PARK_LABELS[kind]}
                  </strong>
                  <small>
                    {kind === 'national'
                      ? 'National Park designations, including combined preserves'
                      : 'PAD-US designated parks · mapped land extents'}
                  </small>
                </span>
                <Switch
                  id={controlId}
                  aria-label={PARK_LABELS[kind]}
                  checked={parks.enabled[kind]}
                  onCheckedChange={(value) => parks.toggle(kind, value)}
                />
              </label>
            )}
            {parks.enabled[kind] && (
              <>
                <p
                  className={
                    parks.manifestError || state.error || status.failed
                      ? 'feed-error'
                      : 'source-meta'
                  }
                >
                  <output>
                    {parks.manifestError ||
                      state.error ||
                      (parks.manifestLoading || state.loading
                        ? 'Loading park boundaries…'
                        : status.message || 'Preparing the park layer…')}
                  </output>
                </p>
                {layer && (
                  <p className="source-meta">
                    {layer.source.name} · {layer.source.release}
                  </p>
                )}
              </>
            )}
          </div>
        );
      })}
      <p className="source-meta">
        Select a shaded park for its details. State-park extents may be
        incomplete and usually describe protected park lands, not the full legal
        park perimeter.
      </p>
      {(parks.enabled.national || parks.enabled.state) && (
        <>
          <Button
            variant="secondary"
            className="secondary-action"
            onClick={parks.reload}
            disabled={parks.manifestLoading}
          >
            <RefreshCw size={14} />
            Reload park layers
          </Button>
          <details className="park-source-notes">
            <summary>Coverage, sources & boundary meanings</summary>
            <p>
              Prepared boundaries are not live or survey-grade. Small parks
              appear as you zoom closer. A blank area does not establish that no
              park exists.
            </p>
            {parks.manifest?.layers
              .filter((l) => parks.enabled[l.id])
              .map((l) => (
                <div key={l.id}>
                  <h3>{PARK_LABELS[l.id]}</h3>
                  <p>{l.source.attribution}</p>
                  <p>
                    Source release: {l.source.release}. Retrieved{' '}
                    {l.source.retrievedAt.slice(0, 10)}.
                  </p>
                  {l.source.limitations.map((t) => (
                    <p key={t}>{t}</p>
                  ))}
                  <a
                    href={parkSourceUrl(l.source.url)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Source and metadata <ExternalLink size={12} />
                  </a>
                </div>
              ))}
          </details>
          <details className="park-source-notes">
            <summary>Explore a park</summary>
            <div className="park-shortcuts">
              {[
                ['Yellowstone', 44.6, -110.5, 300000],
                ['Denali, Alaska', 63.3, -151, 600000],
                ['Hawaiʻi Volcanoes', 19.415, -155.286, 110000],
                ['American Samoa', -14.254, -170.686, 65000],
                ['Letchworth, New York', 42.656, -77.967, 45000],
                ['Custer, South Dakota', 43.742, -103.419, 90000],
              ].map(([name, lat, lon, height]) => (
                <Button
                  key={String(name)}
                  variant="ghost"
                  onClick={() =>
                    navigate({
                      lat: Number(lat),
                      lon: Number(lon),
                      height: Number(height),
                    })
                  }
                >
                  {name}
                </Button>
              ))}
            </div>
          </details>
        </>
      )}
    </section>
  );
}
export function ParkPopup({ parks }: { parks: Parks }) {
  const popup = useRef<HTMLDialogElement>(null),
    isOpen = !!parks.inspection;
  const close = parks.close;
  useEffect(() => {
    if (!isOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    popup.current?.focus({ preventScroll: true });
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('keydown', escape);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [isOpen, close]);
  const item = parks.inspection;
  if (!item) return null;
  return (
    <dialog
      open
      ref={popup}
      tabIndex={-1}
      aria-labelledby="park-details-title"
      className="park-popup"
    >
      <div className="detail-heading">
        <span className="eyebrow">
          <Trees size={14} /> PARK DETAILS
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Close park details"
          onClick={parks.close}
        >
          <X size={17} />
        </Button>
      </div>
      <h2 id="park-details-title">
        {item.loading
          ? 'Finding park details…'
          : item.records.length === 1
            ? item.records[0].name
            : item.records.length
              ? `${item.records.length} park records here`
              : item.error
                ? 'Park details unavailable'
                : 'No mapped park at this point'}
      </h2>
      {item.loading && (
        <p>
          <output>Reading the prepared boundary data…</output>
        </p>
      )}
      {item.error && (
        <p role="alert" className="feed-error">
          {item.error}{' '}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void parks.inspect(item.location)}
          >
            Retry details
          </Button>
        </p>
      )}
      {!item.loading && !item.error && !item.records.length && (
        <p>
          The enabled datasets contain no mapped park polygon at this location.
          State-park data may be incomplete.
        </p>
      )}
      {item.records.map((r) => (
        <article key={`${r.kind}:${r.id}`} className="park-record">
          {item.records.length > 1 && <h3>{r.name}</h3>}
          <dl>
            <div>
              <dt>Designation</dt>
              <dd>{r.designation}</dd>
            </div>
            <div>
              <dt>State / territory</dt>
              <dd>{r.states.join(', ') || 'Not supplied'}</dd>
            </div>
            <div>
              <dt>Boundary type</dt>
              <dd>{r.category}</dd>
            </div>
            <div>
              <dt>Data source</dt>
              <dd>{r.source}</dd>
            </div>
            {r.sourceDate && (
              <div>
                <dt>Source date</dt>
                <dd>{r.sourceDate}</dd>
              </div>
            )}
          </dl>
          <p>
            {r.boundaryMeaning ||
              'Generalized source boundary; not a legal boundary determination.'}
          </p>
          {r.kind === 'state' && (
            <p>
              {r.category === 'Fee'
                ? 'This outline follows recorded park land holdings, not necessarily the complete administrative park boundary.'
                : r.category === 'Designation'
                  ? 'This outline follows a recorded designation area. It may overlap other protected-area records.'
                  : 'This outline follows another recorded park interest and may not represent its complete administrative boundary.'}
            </p>
          )}
          {r.kind === 'state' && r.sourceDetails?.Mang_Type === 'UNK' && (
            <p>
              The managing agency is unknown in this source. Included because
              PAD-US designates it State Park (SP) and records state or
              territorial ownership.
            </p>
          )}
          <a href={parkSourceUrl(r.sourceUrl)} target="_blank" rel="noreferrer">
            Source record / dataset <ExternalLink size={13} />
          </a>
          <details>
            <summary>Original source identifiers</summary>
            <p>{r.sourceIds.join(', ')}</p>
          </details>
        </article>
      ))}
      <p className="source-meta">
        Displayed boundaries use prepared vector geometry. Boundaries are
        generalized; use the source for decisions near an edge.
      </p>
    </dialog>
  );
}
