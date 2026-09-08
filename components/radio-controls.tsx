'use client';
import {
  RadioTower,
  RefreshCw,
  ExternalLink,
  X,
  LocateFixed,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { RadioSites } from '@/hooks/use-radio-sites';
import { radioAuthorization } from '@/lib/radio-authorization';
import {
  RADIO_CATEGORIES,
  RADIO_COLORS,
  RADIO_LABELS,
  radioFilterError,
  radioFrequency,
  safeRadioUrl,
  type RadioRecord,
  type RadioMarker,
} from '@/lib/radio-model';

export function RadioFilter({
  name,
  value,
  values,
  change,
  labels,
  prefix = 'Radio',
  includeUnknown = true,
}: {
  name: string;
  value: string;
  values: string[];
  change: (v: string) => void;
  labels?: Record<string, string>;
  prefix?: string;
  includeUnknown?: boolean;
}) {
  const controlId = `${prefix}-${name}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  const options = [
    { value: '*', label: `All ${name.toLowerCase()}` },
    ...Array.from(new Set([...values, ...(includeUnknown ? [''] : [])])).map(
      (v) => ({
        value: v,
        label: labels?.[v] || v || 'Unknown / not supplied',
      }),
    ),
  ];
  return (
    <label className="radio-filter" htmlFor={controlId}>
      <span>{name}</span>
      <Select
        value={value}
        onValueChange={(v) => change(String(v))}
        items={options}
      >
        <SelectTrigger
          id={controlId}
          aria-label={`${prefix} ${name.toLowerCase()}`}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}
export function RadioControls({
  radio,
  inspect,
  controls = true,
}: {
  radio: RadioSites;
  inspect: (marker: RadioMarker) => void;
  controls?: boolean;
}) {
  const m = radio.manifest,
    f = radio.filters;
  const update = (
    key: 'source' | 'country' | 'service' | 'status',
    value: string,
  ) => radio.setFilters((old) => ({ ...old, [key]: value }));
  const status = !radio.enabled
    ? 'Off'
    : radio.loading
      ? 'Loading this view…'
      : radio.error
        ? radio.error
        : radio.markers.length
          ? `${radio.markers.reduce((a, p) => a + p.count, 0).toLocaleString()} matching records in visible map cells`
          : 'No matching records in the loaded area. Source coverage may be incomplete.';
  return (
    <section
      className="radio-controls"
      aria-label="Radio sites controls"
      data-radio-version={m?.version}
      data-radio-markers={radio.markers.length}
      data-radio-requests={radio.metrics.requests}
      data-radio-bytes={radio.metrics.bytes}
    >
      <div className="section-title">
        <h2>Radio sites</h2>
        <RadioTower size={18} />
      </div>
      {controls && (
        <label className="toggle-row" htmlFor="radio-sites-visible">
          <span>
            <strong>Show radio sites</strong>
            <small>Source records and receiving stations</small>
          </span>
          <Switch
            id="radio-sites-visible"
            aria-label="Show radio sites"
            checked={radio.enabled}
            onCheckedChange={radio.setEnabled}
          />
        </label>
      )}
      {radio.manifestError && (
        <p className="feed-error" role="alert">
          {radio.manifestError}
          {m ? ' Previous dataset remains available.' : ''}
        </p>
      )}
      {m && radio.enabled && (
        <>
          <div className="radio-categories">
            {RADIO_CATEGORIES.map((c) => (
              <label
                className="toggle-row"
                htmlFor={`radio-category-${c}`}
                key={c}
              >
                <span>
                  <strong>
                    <span
                      aria-hidden
                      className={`radio-symbol ${c}`}
                      style={{ color: RADIO_COLORS[c] }}
                    />
                    {RADIO_LABELS[c]}
                  </strong>
                  <small>
                    {m.counts[c].toLocaleString()} records in this dataset
                  </small>
                </span>
                <Switch
                  id={`radio-category-${c}`}
                  checked={f.categories.includes(c)}
                  onCheckedChange={(v) =>
                    radio.setFilters((old) => ({
                      ...old,
                      categories: v
                        ? [...old.categories, c]
                        : old.categories.filter((x) => x !== c),
                    }))
                  }
                  aria-label={RADIO_LABELS[c]}
                />
              </label>
            ))}
          </div>
          <RadioFilter
            name="Sources"
            value={f.source}
            values={m.facets.sources}
            labels={Object.fromEntries(m.sources.map((s) => [s.id, s.name]))}
            change={(v) => update('source', v)}
          />
          <RadioFilter
            name="Countries"
            value={f.country}
            values={m.facets.countries}
            change={(v) => update('country', v)}
          />
          <RadioFilter
            name="Services"
            value={f.service}
            values={m.facets.services}
            change={(v) => update('service', v)}
          />
          <RadioFilter
            name="Recorded status"
            value={f.status}
            values={m.facets.statuses}
            change={(v) => update('status', v)}
          />
          <label className="radio-filter" htmlFor="radio-frequency-information">
            <span>Frequency information</span>
            <Select
              value={f.frequency}
              onValueChange={(v) =>
                radio.setFilters((old) => ({
                  ...old,
                  frequency: v as typeof f.frequency,
                }))
              }
              items={[
                { value: 'all', label: 'Any frequency information' },
                { value: 'known', label: 'Known exact frequency / range' },
                { value: 'unknown', label: 'Exact frequency unknown' },
              ]}
            >
              <SelectTrigger
                id="radio-frequency-information"
                aria-label="Radio frequency information"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any frequency information</SelectItem>
                <SelectItem value="known">
                  Known exact frequency / range
                </SelectItem>
                <SelectItem value="unknown">Exact frequency unknown</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <div className="radio-frequency-range">
            {(['minMHz', 'maxMHz'] as const).map((key, i) => (
              <label key={key}>
                {i ? 'Maximum MHz' : 'Minimum MHz'}
                <input
                  type="number"
                  min="0"
                  step="any"
                  disabled={f.frequency === 'unknown'}
                  aria-label={
                    i
                      ? 'Maximum radio frequency MHz'
                      : 'Minimum radio frequency MHz'
                  }
                  value={f[key]}
                  placeholder="Any"
                  onChange={(e) =>
                    radio.setFilters((old) => ({
                      ...old,
                      [key]: e.target.value,
                    }))
                  }
                />
              </label>
            ))}
          </div>
          {radioFilterError(f) && (
            <p role="alert" className="feed-error">
              {radioFilterError(f)}
            </p>
          )}
          <p className="radio-note">
            Ranges match by overlap. Receiver frequencies are receive tuning
            ranges. Nominal bands and TV channels remain in record details.
          </p>
        </>
      )}
      <p className="radio-status">
        <output>{status}</output>
      </p>
      {radio.limited && (
        <p className="feed-error">
          Display limit reached. These are partial results; zoom closer to load
          more.
        </p>
      )}
      <Button
        variant="secondary"
        className="secondary-action"
        onClick={radio.reload}
        disabled={radio.refreshing || radio.loading}
      >
        <RefreshCw size={14} className={radio.refreshing ? 'spinning' : ''} />
        {radio.refreshing ? 'Checking dataset…' : 'Reload prepared dataset'}
      </Button>
      <p className="radio-note">
        Records are not unique towers or proof of operation. This layer shows
        locations, not signal strength or coverage.
      </p>
      {m && (
        <details className="radio-source-report">
          <summary>Dataset coverage & attribution</summary>
          <p>
            Selected-source builder run {m.builderRun}. Prepared{' '}
            {new Date(m.createdAt).toLocaleDateString()}. Empty areas do not
            establish an absence of radio sites.
          </p>
          {m.sources.map((s) => (
            <div key={s.id}>
              <strong>{s.name}</strong>
              <span>
                {s.status} · {s.input_mode || s.mode}
              </span>
              <p>{s.coverage || s.message || s.scope}</p>
              <p>
                {s.attribution || 'See publisher for attribution'} ·{' '}
                {s.license || 'Publisher reuse terms apply'}
              </p>
              {safeRadioUrl(s.url) && (
                <a href={safeRadioUrl(s.url)} target="_blank" rel="noreferrer">
                  Source & terms <ExternalLink size={12} />
                </a>
              )}
            </div>
          ))}
        </details>
      )}
      {radio.enabled && radio.markers.length > 0 && (
        <details className="radio-source-report">
          <summary>Browse visible record groups</summary>
          <p>
            Map symbols and this list open the same records. Counts are grouped
            by category and map cell.
          </p>
          {radio.markers.slice(0, 24).map((p) => (
            <Button
              key={p.id}
              variant="ghost"
              className="radio-browse-row"
              onClick={() => inspect(p)}
            >
              <span
                className={`radio-symbol ${p.category}`}
                style={{ color: RADIO_COLORS[p.category] }}
              />
              {p.count.toLocaleString()}{' '}
              {p.category === 'receivers'
                ? 'receiver'
                : p.category === 'candidates'
                  ? 'uncertain'
                  : 'transmitter'}{' '}
              records · {p.lat.toFixed(1)}°, {p.lon.toFixed(1)}°
            </Button>
          ))}
          {radio.markers.length > 24 && (
            <p>First 24 groups listed. Select other groups on the map.</p>
          )}
        </details>
      )}
    </section>
  );
}
const display = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return 'Not supplied';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint')
    return String(v);
  if (typeof v === 'object') return JSON.stringify(v) || 'Not supplied';
  return 'Not supplied';
};
function RecordDetails({
  record: r,
  radio,
}: {
  record: RadioRecord;
  radio: RadioSites;
}) {
  const source = radio.manifest?.sources.find((s) => s.id === r.source);
  const authorization = radioAuthorization(r, source);
  const fields: [string, unknown][] = r.cell
    ? [
        ['Source', 'OpenCellID · U.S. network-code exports'],
        ['Technology', r.cell.radio],
        ['Network allocation', r.cell.networkLabel],
        ['MCC', r.cell.mcc],
        [
          r.cell.networkKind === 'SID' ? 'SID (raw net)' : 'Raw net',
          r.cell.net,
        ],
        ['MNC (allocation code)', r.cell.mnc],
        ['Area (LAC / TAC / NID)', r.cell.area],
        ['Cell identifier', r.cell.cell],
        ['Unit (raw PSC / PCI field)', r.cell.unit],
        ['Composite identity', r.source_record_id],
        ['Estimated coordinates', `${r.lat}, ${r.lon} (latitude, longitude)`],
        ['Coordinate quality', r.coordinate_note],
        [
          'Physical country',
          r.country || 'Unknown; MCC identifies the network',
        ],
        ['First seen by source', r.cell.firstSeen],
        ['Last seen / updated by source', r.cell.lastSeen],
        ['Contributed measurements', r.cell.samples],
        ['Acquired', r.retrieved_at],
        ['Allocation reference retrieved', r.cell.operatorMappingDate],
      ]
    : [
        ['Source', source?.name || r.source],
        ['Source record', r.source_record_id],
        ['Operator', r.operator],
        [
          r.source === 'global_ourairports'
            ? 'Navigation-aid identifier'
            : 'Callsign',
          r.call_sign,
        ],
        ['Service', r.service],
        ['Frequency', radioFrequency(r)],
        [
          'Power',
          r.power_value === null
            ? null
            : `${r.power_value} ${r.power_unit || '(unit unknown)'}`,
        ],
        ['Recorded status', r.status],
        ['Expiration', r.expiration_date],
        ['Coordinates', `${r.lat}, ${r.lon} (latitude, longitude)`],
        ['Source datum', r.source_crs],
        ['Coordinate quality', r.coordinate_note],
        [
          'Original coordinates',
          `${display(r.source_latitude)}, ${display(r.source_longitude)}`,
        ],
        [
          'Source vintage',
          r.details_json?.publication_date ||
            r.details_json?.source_date ||
            null,
        ],
        ['Retrieved', r.retrieved_at],
        ['Source file', r.source_file],
      ];
  return (
    <article className="radio-record">
      <h3>
        {r.call_sign || r.operator || r.source_record_id || 'Source record'}
      </h3>
      <p>{r.cell ? 'Estimated cell location' : RADIO_LABELS[r.category]}</p>
      <dl>
        {fields.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{display(value)}</dd>
          </div>
        ))}
      </dl>
      {!r.cell && (
        <section className="my-4" aria-label="License / authorization">
          <h4 className="mb-2 font-semibold">License / authorization</h4>
          {authorization.missingReason && <p>{authorization.missingReason}</p>}
          {authorization.identifiers.length > 0 && (
            <dl>
              {authorization.identifiers.map(({ label, value }) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          )}
          <p className="radio-note">{authorization.note}</p>
          {authorization.sourceUrl && (
            <a href={authorization.sourceUrl} target="_blank" rel="noreferrer">
              View source information <ExternalLink size={12} />
            </a>
          )}
        </section>
      )}
      {r.details_json && Object.keys(r.details_json).length > 0 && (
        <details>
          <summary>Source details, dates & interpretation</summary>
          <dl>
            {Object.entries(r.details_json).map(([k, v]) => (
              <div key={k}>
                <dt>{k.replaceAll('_', ' ')}</dt>
                <dd>{display(v)}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      <p className="radio-note">
        Dates and statuses describe the source record; they do not verify
        current operation. Missing source vintage is unknown.
      </p>
      {r.cell && (
        <p className="radio-note">
          Network names are current code-allocation assignees, not mast
          ownership or a historical carrier guarantee. Measurements are not
          subscribers or a confidence score. Source range is not a coverage
          radius; averageSignal and changeable are deprecated. No coverage or
          signal strength is inferred.
          {safeRadioUrl(r.cell.operatorSource) && (
            <>
              {' '}
              <a
                href={safeRadioUrl(r.cell.operatorSource)}
                target="_blank"
                rel="noreferrer"
              >
                IMSI allocation reference
              </a>
            </>
          )}
        </p>
      )}
      {safeRadioUrl(r.source_url) && (
        <a
          href={
            r.cell
              ? 'https://opencellid.org/downloads.php'
              : safeRadioUrl(r.source_url)
          }
          target="_blank"
          rel="noreferrer"
        >
          Open source record / dataset <ExternalLink size={12} />
        </a>
      )}
      <p className="radio-note">
        {source?.attribution || source?.name} ·{' '}
        {source?.license || 'Publisher reuse terms apply'}
      </p>
    </article>
  );
}
export function RadioInspector({
  radio,
  zoom,
  kind = 'radio',
}: {
  radio: RadioSites;
  zoom: (p: RadioMarker) => void;
  kind?: 'radio' | 'cells';
}) {
  const selected = radio.selection;
  if (!selected) return null;
  return (
    <aside
      className="radio-inspector"
      aria-label={
        kind === 'cells' ? 'Cell record inspection' : 'Radio record inspection'
      }
    >
      <div className="section-title">
        <h2>
          {selected.count.toLocaleString()} source{' '}
          {selected.count === 1 ? 'record' : 'records'}
        </h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label={
            kind === 'cells'
              ? 'Close cell inspection'
              : 'Close radio inspection'
          }
          onClick={radio.close}
        >
          <X size={18} />
        </Button>
      </div>
      <p>
        {kind === 'cells'
          ? 'Estimated cell locations'
          : RADIO_LABELS[selected.category]}{' '}
        · grouped for display
      </p>
      <Button
        className="secondary-action"
        variant="secondary"
        onClick={() => zoom(selected)}
      >
        <LocateFixed size={15} />
        Zoom to this group
      </Button>
      {radio.inspectionError && (
        <p role="alert" className="feed-error">
          {radio.inspectionError}
        </p>
      )}
      {radio.inspecting && (
        <p>
          <output>Loading source records…</output>
        </p>
      )}
      {radio.records.map((r) => (
        <RecordDetails key={r.id} record={r} radio={radio} />
      ))}
      {!radio.inspecting && !radio.records.length && !radio.inspectionError && (
        <p>No matching records in this page.</p>
      )}
      {(radio.more || radio.inspectionError) && (
        <Button
          className="secondary-action"
          variant="secondary"
          disabled={radio.inspecting}
          onClick={() => void radio.loadMore()}
        >
          {radio.inspectionError ? 'Retry / continue records' : 'Next records'}
        </Button>
      )}
      <p className="radio-note">
        Up to 50 records per page. Record identities are preserved; coincident
        points are not merged into a tower count.
      </p>
    </aside>
  );
}
