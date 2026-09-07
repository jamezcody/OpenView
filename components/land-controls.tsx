'use client';
import { useMemo, useState, useId } from 'react';
import {
  MapPin,
  RefreshCw,
  ExternalLink,
  ArrowUpRight,
  ScanLine,
} from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { PARCEL_ADAPTERS } from '@/lib/land-model';
import type { CameraView } from '@/lib/model';
import type { LandExplorer } from '@/hooks/use-land-explorer';
export function LandControls({
  land,
  navigate,
  compact = false,
  controls = true,
}: {
  land: LandExplorer;
  navigate: (p: CameraView) => void;
  compact?: boolean;
  controls?: boolean;
}) {
  const [filter, setFilter] = useState('');
  const controlId = useId();
  const filtered = useMemo(
    () =>
      land.addresses.data?.items.filter((a) =>
        a.label.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
      ) || [],
    [land.addresses.data, filter],
  );
  return (
    <div className="land-controls">
      {controls && (
        <>
          <label className="toggle-row" htmlFor={`${controlId}-addresses`}>
            <span>
              <strong>
                <MapPin size={14} /> Mapped addresses
              </strong>
              <small>Available worldwide · neighborhood zoom</small>
            </span>
            <Switch
              id={`${controlId}-addresses`}
              aria-label="Mapped addresses"
              checked={land.addressesVisible}
              onCheckedChange={land.setAddressesVisible}
            />
          </label>
          <label className="toggle-row" htmlFor={`${controlId}-parcels`}>
            <span>
              <strong>
                <ScanLine size={14} /> U.S. parcel lines
              </strong>
              <small>Independent of your base map</small>
            </span>
            <Switch
              id={`${controlId}-parcels`}
              aria-label="U.S. parcel lines"
              checked={land.parcelsVisible}
              onCheckedChange={land.setParcelsVisible}
            />
          </label>
        </>
      )}
      {(land.addressesVisible || land.parcelsVisible) && (
        <>
          {land.areaMessage && <p className="zoom-note">{land.areaMessage}</p>}
          <Button
            variant="secondary"
            className="land-refresh"
            disabled={
              !!land.areaMessage ||
              land.addresses.loading ||
              land.parcels.loading
            }
            onClick={land.reload}
          >
            <RefreshCw
              size={14}
              className={
                land.addresses.loading || land.parcels.loading ? 'spinning' : ''
              }
            />
            Reload visible area
          </Button>
          <p className="source-meta">
            Map overlays load after you stop moving. Property records are
            queried only with Get data.
          </p>
        </>
      )}
      {land.addressesVisible && (
        <div className="overlay-status" aria-live="polite">
          {land.addresses.loading && (
            <p className="fetching">Loading mapped addresses…</p>
          )}
          {land.addresses.error && (
            <p className="feed-error">
              {land.addresses.error} Previous loaded area is retained.
            </p>
          )}
          {land.addresses.data && (
            <>
              <p>
                <MapPin size={13} />{' '}
                {land.addresses.data.items.length.toLocaleString()} addresses in
                loaded area
              </p>
              {land.addresses.data.truncated && (
                <p className="zoom-note">
                  Showing 4,000 of{' '}
                  {land.addresses.data.totalInView.toLocaleString()} mapped
                  addresses. Zoom closer for the rest.
                </p>
              )}
              {land.addresses.data.warnings.map((w, i) => (
                <p className="feed-error" key={i}>
                  {w}
                </p>
              ))}
            </>
          )}
        </div>
      )}
      {land.parcelsVisible && (
        <div className="overlay-status" aria-live="polite">
          {land.parcels.loading && (
            <p className="fetching">Loading U.S. parcel boundaries…</p>
          )}
          {land.parcels.error && (
            <p className="feed-error">
              {land.parcels.error} Previous loaded area is retained.
            </p>
          )}
          {land.parcels.data && (
            <>
              <p>
                <ScanLine size={13} />{' '}
                {land.parcels.data.featureCount.toLocaleString()} parcel
                boundaries in loaded area
              </p>
              {land.parcels.data.sources.map((s) => (
                <div className={`source-check ${s.status}`} key={s.id}>
                  <strong>{s.name}</strong>
                  <span>
                    {s.status === 'success'
                      ? `${s.count.toLocaleString()} parcels`
                      : s.status === 'empty'
                        ? 'No parcels returned'
                        : s.status === 'failed'
                          ? 'Source unavailable'
                          : 'Coverage unavailable'}
                    {s.truncated ? ' · zoom closer for all boundaries' : ''}
                  </span>
                  {s.message && <small>{s.message}</small>}
                </div>
              ))}
            </>
          )}
        </div>
      )}
      {!compact && (
        <>
          <div className="land-coverage">
            <span className="eyebrow">ADDRESS COVERAGE</span>
            <p>
              Overture combines hundreds of millions of published address
              points. Coverage varies by country; this is not a complete postal
              directory and mail deliverability is not verified.
            </p>
            <a
              className="source-link"
              href="https://docs.overturemaps.org/guides/addresses/"
              target="_blank"
              rel="noreferrer"
            >
              Overture Maps · release 2026-08-19 <ExternalLink size={12} />
            </a>
          </div>
          <div className="land-places">
            <span className="eyebrow">TRY AN ADDRESS MAP</span>
            {[
              { name: 'Paris', lat: 48.8566, lon: 2.3522 },
              { name: 'New York', lat: 40.713, lon: -74.006 },
              { name: 'São Paulo', lat: -23.5505, lon: -46.6333 },
            ].map((p) => (
              <button
                key={p.name}
                onClick={() => {
                  land.setAddressesVisible(true);
                  navigate({ ...p, height: 900 });
                }}
              >
                {p.name}
                <ArrowUpRight size={14} />
              </button>
            ))}
          </div>
          {land.addressesVisible && land.addresses.data && (
            <details className="land-directory">
              <summary>
                Browse loaded addresses (
                {land.addresses.data.items.length.toLocaleString()})
              </summary>
              <input
                aria-label="Filter loaded addresses"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Street, number, city…"
              />
              <div className="address-list">
                {filtered.slice(0, 60).map((a) => (
                  <button
                    key={a.id}
                    onClick={() => {
                      land.selectAddress(a);
                      navigate({ lat: a.lat, lon: a.lon, height: 500 });
                    }}
                  >
                    <MapPin size={13} />
                    <span>
                      {a.label || 'Mapped address'}
                      <small>
                        {a.country} · {a.source}
                      </small>
                    </span>
                  </button>
                ))}
                {filtered.length === 0 && (
                  <p>No matching address in the loaded area.</p>
                )}
                {filtered.length > 60 && (
                  <small>First 60 results. Type to narrow the list.</small>
                )}
              </div>
            </details>
          )}
          <details className="land-directory">
            <summary>
              U.S. parcel coverage · {PARCEL_ADAPTERS.length} public sources
            </summary>
            <p className="source-meta">
              State and county coverage overlaps and has gaps. Choose a source
              to inspect a verified sample area. Thin yellow lines show the
              published boundaries.
            </p>
            <div className="parcel-source-list">
              {PARCEL_ADAPTERS.map((a) => (
                <div key={a.id}>
                  <button
                    onClick={() => {
                      land.setParcelsVisible(true);
                      navigate({
                        lat: a.testCenter[1],
                        lon: a.testCenter[0],
                        height: 1300,
                      });
                    }}
                  >
                    <span>{a.name}</span>
                    <ArrowUpRight size={14} />
                  </button>
                  <small>
                    {a.coverage}
                    {a.notes ? ` · ${a.notes}` : ''}
                  </small>
                  <a href={a.sourceUrl} target="_blank" rel="noreferrer">
                    Source <ExternalLink size={10} />
                  </a>
                </div>
              ))}
            </div>
          </details>
          <p className="source-meta">
            Select an address or parcel, then Get data to query available
            official records and permitted linked public pages. Each result
            identifies its source and whether a name is an assessment owner,
            taxpayer, or page-stated owner.
          </p>
        </>
      )}
    </div>
  );
}
