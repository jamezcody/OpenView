import type { Bounds } from './model';

export const RADIO_CATEGORIES = [
  'transmitters',
  'candidates',
  'receivers',
] as const;
export type RadioCategory = (typeof RADIO_CATEGORIES)[number];
export const RADIO_LABELS: Record<RadioCategory, string> = {
  transmitters: 'Transmitter records',
  candidates: 'Estimated or uncertain sites',
  receivers: 'Receiving ground stations',
};
export const RADIO_COLORS: Record<RadioCategory, string> = {
  transmitters: '#58d6cd',
  candidates: '#ffc16d',
  receivers: '#bba2ff',
};
export type RadioFilters = {
  categories: RadioCategory[];
  source: string;
  country: string;
  service: string;
  network?: string;
  status: string;
  frequency: 'all' | 'known' | 'unknown';
  minMHz: string;
  maxMHz: string;
};
export const DEFAULT_RADIO_FILTERS: RadioFilters = {
  categories: [...RADIO_CATEGORIES],
  source: '*',
  country: '*',
  service: '*',
  network: '*',
  status: '*',
  frequency: 'all',
  minMHz: '',
  maxMHz: '',
};
export type RadioGroup = {
  category: RadioCategory;
  source: string;
  country: string;
  service: string;
  network?: string | null;
  status: string;
  frequency_mhz: number | null;
  frequency_upper_mhz: number | null;
  count: number;
  lat: number;
  lon: number;
};
export type RadioRecord = Omit<RadioGroup, 'count'> & {
  cell?: {
    radio: string;
    mcc: string;
    net: string;
    area: string;
    cell: string;
    unit: string | null;
    mnc: string | null;
    networkLabel: string;
    networkKind: string;
    firstSeen: string | null;
    lastSeen: string | null;
    samples: string | null;
    operatorSource: string | null;
    operatorMappingDate: string | null;
  };
  id: string;
  record_id: string;
  source_record_id: string;
  operator: string | null;
  call_sign: string | null;
  license_id: string | null;
  power_value: number | null;
  power_unit: string | null;
  source_crs: string | null;
  coordinate_note: string | null;
  source_url: string | null;
  source_file: string | null;
  retrieved_at: string | null;
  details_json: Record<string, unknown> | null;
  [key: string]: unknown;
};
export type RadioFile = { file: string; bytes: number; sha256: string };
export type RadioNode = {
  id: string;
  bounds: number[];
  children: string[];
  summaryPages: RadioFile[];
  overviewPages?: RadioFile[];
  recordPages: RadioFile[];
};
export type RadioSource = {
  id: string;
  name: string;
  status: string;
  mode: string;
  country?: string;
  scope?: string;
  coverage?: string;
  message?: string;
  url?: string;
  attribution?: string;
  license?: string;
  input_mode?: string;
  counts?: Record<string, number>;
};
export type RadioManifest = {
  datasetKind?: 'cell-locations';
  scope?: string;
  networkLabels?: Record<string, string>;
  networkReference?: {
    source: string;
    sourceSha256: string;
    retrievedAt: string;
    mncWidth: number;
  };
  schemaVersion: 1;
  version: string;
  createdAt: string;
  builderRun: string;
  dbSha256: string;
  reportSha256: string;
  counts: Record<RadioCategory, number>;
  sources: RadioSource[];
  facets: {
    sources: string[];
    countries: string[];
    services: string[];
    networks?: string[];
    statuses: string[];
  };
};
export type RadioMarker = {
  id: string;
  node: string;
  category: RadioCategory;
  lat: number;
  lon: number;
  count: number;
  bounds: number[];
  recordIds?: string[];
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
export const radioVersion = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(v);
export const radioNodeId = (v: unknown): v is string =>
  typeof v === 'string' && /^r[0-3]{0,12}$/.test(v);
export const radioPath = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[a-zA-Z0-9_/-]+\.json$/.test(v) &&
  !v.startsWith('/') &&
  !v.includes('//');
const number = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);
export const validNetwork = (v: unknown): v is string =>
  typeof v === 'string' &&
  (v === '' || /^(plmn|cdma|unknown):\d{3}:\d{1,20}$/.test(v));
export function validRadioBounds(b: unknown): b is number[] {
  return (
    Array.isArray(b) &&
    b.length === 4 &&
    b.every(number) &&
    b[0] >= -180 &&
    b[2] <= 180 &&
    b[1] >= -90 &&
    b[3] <= 90 &&
    b[0] < b[2] &&
    b[1] < b[3]
  );
}
export function validateRadioManifest(v: unknown): RadioManifest {
  if (!object(v) || !object(v.counts) || !object(v.facets))
    throw new Error('Radio dataset manifest is invalid.');
  const counts = v.counts,
    facets = v.facets;
  if (
    !object(v) ||
    v.schemaVersion !== 1 ||
    !radioVersion(v.version) ||
    !object(v.counts) ||
    !RADIO_CATEGORIES.every(
      (c) => Number.isSafeInteger(counts[c]) && Number(counts[c]) >= 0,
    ) ||
    !Array.isArray(v.sources) ||
    v.sources.length > 100 ||
    !v.sources.every(
      (s) =>
        object(s) &&
        typeof s.id === 'string' &&
        typeof s.name === 'string' &&
        typeof s.status === 'string',
    ) ||
    !['sources', 'countries', 'services', 'statuses'].every(
      (k) =>
        Array.isArray(facets[k]) &&
        (facets[k] as unknown[]).length <= 20000 &&
        (facets[k] as unknown[]).every((x) => typeof x === 'string'),
    ) ||
    (facets.networks !== undefined &&
      (!Array.isArray(facets.networks) ||
        facets.networks.length > 20000 ||
        !facets.networks.every(validNetwork))) ||
    (v.networkLabels !== undefined &&
      (!object(v.networkLabels) ||
        Object.entries(v.networkLabels).some(
          ([key, label]) =>
            !validNetwork(key) ||
            typeof label !== 'string' ||
            label.length > 500,
        ))) ||
    (v.datasetKind !== undefined && v.datasetKind !== 'cell-locations') ||
    typeof v.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(v.createdAt))
  )
    throw new Error('Radio dataset manifest is invalid.');
  return v as RadioManifest;
}
export function validateRadioNode(v: unknown, id: string): RadioNode {
  const files = (x: unknown): x is RadioFile[] =>
    Array.isArray(x) &&
    x.length <= 10000 &&
    x.every(
      (f) =>
        object(f) &&
        radioPath(f.file) &&
        Number.isSafeInteger(f.bytes) &&
        Number(f.bytes) > 0 &&
        Number(f.bytes) <= 262144 &&
        typeof f.sha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(f.sha256),
    );
  if (
    !object(v) ||
    v.id !== id ||
    !radioNodeId(id) ||
    !validRadioBounds(v.bounds) ||
    !Array.isArray(v.children) ||
    v.children.length > 4 ||
    new Set(v.children).size !== v.children.length ||
    !v.children.every(
      (c) => radioNodeId(c) && c.length === id.length + 1 && c.startsWith(id),
    ) ||
    !files(v.summaryPages) ||
    (v.overviewPages !== undefined && !files(v.overviewPages)) ||
    !files(v.recordPages) ||
    (v.children.length && v.recordPages.length)
  )
    throw new Error('Radio spatial index is invalid.');
  return v as RadioNode;
}
export function validRadioGroup(v: unknown): v is RadioGroup {
  return (
    object(v) &&
    RADIO_CATEGORIES.includes(v.category as RadioCategory) &&
    typeof v.source === 'string' &&
    (v.network === undefined ||
      v.network === null ||
      validNetwork(v.network)) &&
    ['country', 'service', 'status'].every(
      (k) => typeof v[k] === 'string' || v[k] === null,
    ) &&
    number(v.lat) &&
    Math.abs(v.lat) <= 90 &&
    number(v.lon) &&
    Math.abs(v.lon) <= 180 &&
    ['frequency_mhz', 'frequency_upper_mhz'].every(
      (k) => v[k] === null || (number(v[k]) && v[k] > 0),
    )
  );
}
export function radioFilterError(f: RadioFilters) {
  const values = [f.minMHz, f.maxMHz].filter((v) => v !== '');
  if (values.some((v) => !Number.isFinite(Number(v)) || Number(v) < 0))
    return 'Enter positive frequencies in MHz.';
  if (f.minMHz !== '' && f.maxMHz !== '' && Number(f.minMHz) > Number(f.maxMHz))
    return 'Minimum frequency must not exceed maximum.';
  return '';
}
export function matchesRadio(
  r: RadioGroup | RadioRecord,
  f: RadioFilters,
): boolean {
  if (!f.categories.includes(r.category)) return false;
  if (
    f.network !== undefined &&
    f.network !== '*' &&
    f.network !== (r.network || '')
  )
    return false;
  if (
    ['source', 'country', 'service', 'status'].some(
      (k) =>
        f[k as 'source'] !== '*' &&
        f[k as 'source'] !== (r[k as 'source'] || ''),
    )
  )
    return false;
  const known = r.frequency_mhz !== null;
  if (f.frequency === 'unknown') return !known;
  if (!known)
    return f.frequency !== 'known' && f.minMHz === '' && f.maxMHz === '';
  const lo = r.frequency_mhz!,
    hi = r.frequency_upper_mhz ?? lo;
  return (
    (f.minMHz === '' || hi >= Number(f.minMHz)) &&
    (f.maxMHz === '' || lo <= Number(f.maxMHz))
  );
}
/** Dateline-crossing camera bounds are two independent longitude intervals. */
export function intersectsRadio(b: number[], view: Bounds) {
  if (b[3] < view.south || b[1] > view.north) return false;
  return view.west <= view.east
    ? b[2] >= view.west && b[0] <= view.east
    : b[2] >= view.west || b[0] <= view.east;
}
export function radioDepth(height: number) {
  return Math.max(
    2,
    Math.min(12, Math.floor(Math.log2(40000000 / Math.max(100, height))) + 1),
  );
}
export function radioFrequency(
  r: Pick<RadioGroup, 'category' | 'frequency_mhz' | 'frequency_upper_mhz'>,
) {
  if (r.frequency_mhz === null) return 'Exact frequency unknown';
  return `${r.frequency_mhz}${r.frequency_upper_mhz && r.frequency_upper_mhz !== r.frequency_mhz ? `–${r.frequency_upper_mhz}` : ''} MHz${r.category === 'receivers' ? ' · receive range' : ''}`;
}
export function safeRadioUrl(v: unknown) {
  try {
    const u = new URL(String(v));
    return ['https:', 'http:'].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : undefined;
  } catch {
    return undefined;
  }
}
