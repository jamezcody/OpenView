'use client';
import { useEffect, useRef } from 'react';
import { X, MapPin, Search, RefreshCw, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { LandExplorer } from '@/hooks/use-land-explorer';
import { utc } from '@/lib/model';
export function AddressPopup({ land }: { land: LandExplorer }) {
  const popup = useRef<HTMLDialogElement>(null),
    a = land.selectedAddress;
  const selectedId = a?.id,
    close = land.close;
  useEffect(() => {
    if (!selectedId) return;
    const previous = document.activeElement as HTMLElement | null;
    popup.current?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [selectedId, close]);
  if (!a) return null;
  return (
    <dialog
      open
      ref={popup}
      tabIndex={-1}
      aria-labelledby="address-title"
      className={`address-popup ${land.anchor ? 'anchored' : 'docked'}`}
      style={
        land.anchor
          ? {
              left: `clamp(12px, ${land.anchor.x + 18}px, calc(100% - 394px))`,
              top: `clamp(12px, ${land.anchor.y - 80}px, calc(100% - 350px))`,
            }
          : undefined
      }
    >
      <div className="detail-heading">
        <span className="eyebrow">
          <MapPin size={13} />{' '}
          {a.source === 'Parcel situs' ? 'PARCEL LOCATION' : 'MAPPED ADDRESS'}
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Close address details"
          onClick={land.close}
        >
          <X size={16} />
        </Button>
      </div>
      <h2 id="address-title">{a.label || 'Mapped address'}</h2>
      <p className="address-subtitle">
        {a.country || 'Country not supplied'} · {a.lat.toFixed(5)},{' '}
        {a.lon.toFixed(5)}
      </p>
      <p className="source-meta">
        {a.source}
        {a.sources.length
          ? ` · ${a.sources.map((s) => s.dataset).join(', ')}`
          : ''}
        . Mail deliverability not verified.
      </p>
      <Button
        className="primary-action"
        onClick={() => void land.getData()}
        disabled={land.inquiring}
      >
        {land.inquiring ? <RefreshCw className="spinning" /> : <Search />}
        {land.inquiring ? 'Finding property data…' : 'Get data'}
      </Button>
      <div className="property-results" aria-live="polite">
        {!land.inquiry && !land.inquiring && !land.inquiryError && (
          <p className="source-meta">
            Query official property APIs and permitted linked records for this
            location. Coverage and available ownership fields differ by
            jurisdiction.
          </p>
        )}
        {land.inquiryError && (
          <p className="feed-error" role="alert">
            {land.inquiryError}
          </p>
        )}
        {land.inquiry && (
          <>
            <div className="inquiry-progress">
              <span>
                {land.inquiring
                  ? 'Source checks in progress'
                  : `Checked ${utc(land.inquiry.completedAt || land.inquiry.startedAt)}`}
              </span>
              <strong>
                {land.inquiry.evidence.length} record
                {land.inquiry.evidence.length === 1 ? '' : 's'}
              </strong>
            </div>
            {land.inquiry.evidence.map((e, i) => (
              <article
                className="property-evidence"
                key={`${e.sourceId}-${e.parcelId}-${i}`}
              >
                <a
                  className="source-link"
                  href={e.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {e.source}
                  <ExternalLink size={12} />
                </a>
                <span className="evidence-role">{e.ownerRole}</span>
                {e.ownerNames.length > 0 ? (
                  <p className="owner-name">{e.ownerNames.join(' · ')}</p>
                ) : (
                  <p className="source-meta">
                    No publishable owner name returned by this source.
                  </p>
                )}
                <dl>
                  <div>
                    <dt>Parcel</dt>
                    <dd>{e.parcelId || 'Not supplied'}</dd>
                  </div>
                  <div>
                    <dt>Address</dt>
                    <dd>{e.address || 'Not supplied'}</dd>
                  </div>
                  <div>
                    <dt>Layer updated</dt>
                    <dd>
                      {e.sourceDate
                        ? utc(Date.parse(e.sourceDate))
                        : 'Not supplied'}
                    </dd>
                  </div>
                  <div>
                    <dt>Matched by</dt>
                    <dd>{e.match}</dd>
                  </div>
                </dl>
                {e.notes.map((n, j) => (
                  <p className="evidence-note" key={j}>
                    {n}
                  </p>
                ))}
                <details>
                  <summary>
                    All returned property fields ({e.facts.length})
                  </summary>
                  <dl>
                    {e.facts.map((f, j) => (
                      <div key={`${f.field}-${j}`}>
                        <dt>{f.label}</dt>
                        <dd>{f.value}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
                {e.recordLinks.map((url) => (
                  <a
                    className="source-link"
                    href={url}
                    key={url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open linked record
                    <ExternalLink size={12} />
                  </a>
                ))}
              </article>
            ))}
            {!land.inquiring && !land.inquiry.evidence.length && (
              <p className="zoom-note">
                No matching public property record was returned. Registry links
                below may require a manual search, login, or fee.
              </p>
            )}
            <details
              className="inquiry-checks"
              open={!land.inquiry.evidence.length}
            >
              <summary>Source checks ({land.inquiry.checks.length})</summary>
              {land.inquiry.checks.map((c, i) => (
                <div className={`source-check ${c.status}`} key={i}>
                  <strong>{c.source}</strong>
                  <small>{c.message}</small>
                  {c.url && (
                    <a href={c.url} target="_blank" rel="noreferrer">
                      Source <ExternalLink size={10} />
                    </a>
                  )}
                </div>
              ))}
            </details>
            {land.inquiry.directory.length > 0 && (
              <details className="inquiry-checks">
                <summary>
                  Registry and property sources ({land.inquiry.directory.length}
                  )
                </summary>
                {land.inquiry.directory.map((d, i) => (
                  <div className="source-check" key={i}>
                    <a
                      className="source-link"
                      href={d.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {d.name}
                      <ExternalLink size={12} />
                    </a>
                    <small>
                      {d.jurisdiction} · {d.access}
                    </small>
                    <small>{d.notes}</small>
                  </div>
                ))}
              </details>
            )}
            <p className="source-meta">
              Assessment records and web pages can lag title changes. A returned
              name is not proof of current legal ownership.
            </p>
          </>
        )}
      </div>
    </dialog>
  );
}
