'use client';
import { useEffect, useRef } from 'react';
import { X, RefreshCw, ExternalLink, Tent } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { CampingState } from '@/hooks/use-camping';
import {
  PAYMENTS,
  PAYMENT_LABELS,
  PAYMENT_COLORS,
  PAYMENT_SYMBOLS,
  campMapped,
  campUrl,
  CAMP_LABELS,
  type CampRecord,
} from '@/lib/camping-model';

export function CampingControls({
  camping,
  onRecord,
}: {
  camping: CampingState;
  onRecord: (id: string, version: string) => void;
}) {
  return (
    <details
      className="panel-detail camping-controls"
      open={camping.enabled || undefined}
    >
      <summary>
        <Tent size={17} /> Camping filters & records
      </summary>
      <fieldset>
        <legend>Reported payment · map filters</legend>
        {PAYMENTS.map((p) => (
          <label key={p}>
            <input
              type="checkbox"
              checked={camping.payments.includes(p)}
              onChange={(e) =>
                camping.setPayments((old) =>
                  e.target.checked ? [...old, p] : old.filter((v) => v !== p),
                )
              }
            />
            <span style={{ color: PAYMENT_COLORS[p] }} aria-hidden>
              {PAYMENT_SYMBOLS[p]}
            </span>{' '}
            {PAYMENT_LABELS[p]}
          </label>
        ))}
      </fieldset>
      <p>
        All payment categories start enabled. Search includes records regardless
        of map filters.
      </p>
      <output className="camp-status">
        {camping.error ||
          (camping.loading
            ? 'Loading camping records for this view…'
            : camping.enabled
              ? `${camping.markers.reduce((n, m) => n + m.count, 0).toLocaleString()} source records represented in this view.`
              : 'Enable a camping overlay to load map records.')}
      </output>
      {camping.limited && (
        <p className="feed-error">
          Display budget reached. Some groups remain aggregated; zoom closer for
          more detail.
        </p>
      )}
      <p>
        ▲ Campground/location · ■ Individual/group site · ◆ Supplementary
        lodging/zone. Counts are source records, including overlaps. Individual
        sites appear below 18 km camera height; dense groups may require closer
        zoom.
      </p>
      <Button
        variant="secondary"
        disabled={!camping.enabled || camping.loading}
        onClick={camping.reload}
      >
        <RefreshCw size={14} /> Reload prepared camping layer
      </Button>
      <p>
        This reloads local prepared data. It does not acquire newer upstream
        reports.
      </p>
      {camping.manifest && (
        <p>
          Inventory built {camping.manifest.snapshot}.{' '}
          {camping.manifest.stats.unmapped.toLocaleString()} records have no
          accepted map location. Coverage across all 50 states is incomplete.
        </p>
      )}
      <details>
        <summary>Records visible here</summary>
        <ul className="camp-record-list">
          {camping.markers
            .filter((m) => !m.cluster)
            .slice(0, 60)
            .map((m) => (
              <li key={m.id}>
                <button onClick={() => onRecord(m.recordId!, m.version)}>
                  {m.name} · {PAYMENT_LABELS[m.payment]}
                </button>
              </li>
            ))}
        </ul>
        <p>
          Up to 60 records listed. Use search for the complete inventory,
          including unmapped records.
        </p>
      </details>
      <CampingAttribution />
    </details>
  );
}
export function CampingAttribution() {
  return (
    <p className="camp-attribution">
      <a
        href="https://www.openstreetmap.org/copyright"
        target="_blank"
        rel="noreferrer"
      >
        © OpenStreetMap contributors · ODbL 1.0
      </a>{' '}
      ·{' '}
      <a href="https://ridb.recreation.gov/" target="_blank" rel="noreferrer">
        data source: ridb.recreation.gov
      </a>{' '}
      · BLM · USGS · USFS. Census generalized states used for coordinate
      screening. Source records retain their separate licenses.
    </p>
  );
}
export function CampingPopup({
  camping,
  onRecord,
  fly,
}: {
  camping: CampingState;
  onRecord: (id: string, version: string) => void;
  fly: (r: CampRecord) => void;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.scrollTo({ top: 0 });
  }, [camping.selection?.id]);
  if (!camping.selection) return null;
  const r = camping.record,
    version = camping.selection.version;
  return (
    <aside
      ref={panel}
      className="radio-inspector camping-inspector"
      aria-label="Camping record details"
    >
      <div className="detail-heading">
        <span className="eyebrow">CAMPING SOURCE RECORD</span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close camping details"
          onClick={camping.close}
        >
          <X size={16} />
        </Button>
      </div>
      {camping.inspecting && <output>Loading record details…</output>}
      {camping.inspectionError && (
        <div role="alert">
          <p>{camping.inspectionError}</p>
          <button onClick={() => onRecord(camping.selection!.id, version)}>
            Retry record
          </button>
        </div>
      )}
      {r && (
        <>
          <h2>{r.name}</h2>
          <p>
            {r.kind.replaceAll('_', ' ')} · {r.state || 'State unavailable'}
          </p>
          <p
            className="camp-payment"
            style={{ color: PAYMENT_COLORS[r.payment_status] }}
          >
            {PAYMENT_SYMBOLS[r.payment_status]}{' '}
            {PAYMENT_LABELS[r.payment_status]}
          </p>
          <p>{r.payment_basis}</p>
          <p>
            “Completely free” means the source reports no required fee; it is
            not a current all-in price guarantee. Missing, conflicting and
            conditional fee information remains unclear. Fees are never
            inherited from a parent or nearby record.
          </p>
          <details>
            <summary>Payment evidence (original JSON text)</summary>
            <pre>{r.payment_evidence}</pre>
          </details>
          <dl className="camp-facts">
            {[
              ['Map category', CAMP_LABELS[r.layer]],
              ['Operator', r.operator],
              ['Reported access', r.access],
              ['Reported status', r.status],
              ['Source', r.source],
              ['Source record ID', r.source_id],
              ['Stable identity', r.id],
              ['Inventory built', r.snapshot],
              ['Source updated (as reported)', r.source_updated],
              ['Coordinate type', r.coordinate_kind],
              ['Coordinate screening', r.coordinate_quality],
              ['State basis', r.state_basis],
              ['Release', version],
            ].map(
              ([key, value]) =>
                value && (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{value}</dd>
                  </div>
                ),
            )}
          </dl>
          <p>
            Source dates describe the snapshot or source record, not current
            availability. “RIDB enabled” is a listing flag, not evidence that a
            campground is open.
          </p>
          <p>
            Source snapshot retrieved:{' '}
            {camping.detailManifest?.sourceSnapshots?.[r.source]
              ?.retrievedFrom || 'Not recorded'}
            {camping.detailManifest?.sourceSnapshots?.[r.source]?.retrievedTo &&
              ` through ${camping.detailManifest.sourceSnapshots[r.source].retrievedTo}`}
            . Raw source records may have older update dates.
          </p>
          {campMapped(r) ? (
            <>
              <p>
                {r.location![1].toFixed(6)}, {r.location![0].toFixed(6)}
              </p>
              <Button variant="secondary" onClick={() => fly(r)}>
                Go to reported location
              </Button>
            </>
          ) : (
            <p className="feed-error">
              Location unavailable — missing or flagged coordinates are excluded
              from the map.
            </p>
          )}
          <p>
            Points may be a source coordinate, approximate position, polygon
            interior, or OSM bounding-box center. They are not verified
            entrances or surveyed campsite locations.
          </p>
          {[
            ['Official website', r.website],
            ['Source record', r.source_url],
          ].map(
            ([label, url]) =>
              campUrl(url) && (
                <a
                  className="camp-external"
                  key={label}
                  href={campUrl(url)!}
                  target="_blank"
                  rel="noreferrer"
                >
                  {label} <ExternalLink size={12} />
                </a>
              ),
          )}
          {r.parent_id && (
            <section>
              <h3>Reported parent campground</h3>
              {r.parent_available ? (
                <button onClick={() => onRecord(r.parent_id!, version)}>
                  {r.parent_name || r.parent_id}
                </button>
              ) : (
                <p>
                  {r.parent_name || r.parent_id} — linked source record is
                  outside this inventory.
                </p>
              )}
              <small>{r.parent_id}</small>
            </section>
          )}
          {!!r.children_count && (
            <section>
              <h3>
                {r.children_count.toLocaleString()} explicitly linked sites
              </h3>
              <ul className="camp-record-list">
                {camping.children.map(([id, name, location]) => (
                  <li key={id}>
                    <button onClick={() => onRecord(id, version)}>
                      {name}{' '}
                      <small>
                        {id}
                        {!location && ' · Location unavailable'}
                      </small>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="camp-paging">
                <Button
                  variant="secondary"
                  disabled={!camping.childPage || camping.inspecting}
                  onClick={() => camping.setChildPage((p) => p - 1)}
                >
                  Previous
                </Button>
                <span>
                  {camping.childPage + 1} / {camping.childPages || 1}
                </span>
                <Button
                  variant="secondary"
                  disabled={
                    camping.childPage + 1 >= camping.childPages ||
                    camping.inspecting
                  }
                  onClick={() => camping.setChildPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </section>
          )}
          <p>
            Source overlaps remain separate; neither this record nor a map
            cluster identifies a unique physical campsite.
          </p>
          <CampingAttribution />
        </>
      )}
    </aside>
  );
}
