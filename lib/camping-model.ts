import type { SearchResult } from './search-model';

export const CAMP_LAYERS = ['campgrounds', 'sites', 'supplementary'] as const;
export type CampLayer = (typeof CAMP_LAYERS)[number];
export const CAMP_LABELS: Record<CampLayer, string> = {
  campgrounds: 'Campgrounds and camping locations',
  sites: 'Individual tent/RV sites',
  supplementary: 'Camping-related lodging and zones',
};
export const PAYMENTS = ['pay', 'unclear', 'completely_free'] as const;
export type Payment = (typeof PAYMENTS)[number];
export const PAYMENT_LABELS = {
  pay: 'Paid',
  unclear: 'Unclear',
  completely_free: 'Completely free',
};
export const PAYMENT_COLORS = {
  pay: '#ffc16d',
  unclear: '#b7c6df',
  completely_free: '#83dfac',
};
export const PAYMENT_SYMBOLS = { pay: '$', unclear: '?', completely_free: 'F' };
export type CampFile = { file: string; bytes: number; sha256: string };
export type CampBounds = [number, number, number, number];
export type CampPoint = [
  id: string,
  name: string,
  layer: CampLayer,
  payment: Payment,
  lon: number,
  lat: number,
];
export type CampGroup = [
  layer: CampLayer,
  payment: Payment,
  count: number,
  lon: number,
  lat: number,
];
export type CampNode = {
  b: CampBounds;
  g: CampGroup[];
  ref?: CampFile;
  c?: CampNode[];
  r?: CampPoint[];
  pages?: CampFile[];
};
export type CampMarker = {
  id: string;
  name: string;
  layer: CampLayer;
  payment: Payment;
  lon: number;
  lat: number;
  count: number;
  cluster: boolean;
  bounds: CampBounds;
  recordId?: string;
  version: string;
};
export function filterCampMarkers(
  markers: CampMarker[],
  version: string | undefined,
  layers: CampLayer[],
  payments: Payment[],
) {
  const filtered = markers.filter(
    (marker) =>
      marker.version === version &&
      layers.includes(marker.layer) &&
      payments.includes(marker.payment),
  );
  return filtered.length === markers.length ? markers : filtered;
}
export type CampRecord = {
  id: string;
  source: string;
  source_id: string;
  kind: string;
  name: string;
  layer: CampLayer;
  payment_status: Payment;
  payment_basis: string;
  payment_evidence: string;
  state: string | null;
  state_basis: string | null;
  source_state: string | null;
  coordinate_kind: string;
  coordinate_quality: string;
  location: [number, number] | null;
  operator: string | null;
  ownership: string | null;
  access: string | null;
  status: string | null;
  parent_id: string | null;
  parent_name: string | null;
  parent_available: boolean;
  children_count: number;
  website: string | null;
  source_url: string | null;
  source_updated: string | null;
  snapshot: string;
};
export type CampSearchRow = [
  string,
  string,
  CampLayer,
  Payment,
  string | null,
  [number, number] | null,
  string | null,
  string,
  string,
];
export type CampCatalog = {
  details: Record<string, CampFile>;
  search: CampFile[];
  terms: (CampFile & { first: string; last: string })[];
  links: CampFile;
};
export type CampManifest = {
  sourceSnapshots?: Record<
    string,
    { retrievedFrom: string | null; retrievedTo: string | null }
  >;
  schema: 1;
  version: string;
  snapshot: string;
  sourceSha256: string;
  root: CampFile;
  catalog: CampFile;
  stats: {
    records: number;
    mapped: number;
    unmapped: number;
    layers: Record<CampLayer, number>;
    payments: Record<Payment, number>;
    unresolvedParents: number;
    possibleDuplicatePairs: number;
  };
  attribution: string;
  limitations: string;
};
export const CAMP_BUDGET = {
  requests: 32,
  bytes: 6 * 1024 * 1024,
  markers: 360,
  cache: 8 * 1024 * 1024,
  file: 2 * 1024 * 1024,
};
export function campManifest(raw: unknown): CampManifest {
  const m = raw as CampManifest;
  if (
    m?.schema !== 1 ||
    !/^camping-[a-f0-9]{20}$/.test(m.version) ||
    !m.stats ||
    !Number.isSafeInteger(m.stats.records) ||
    m.stats.records < 1 ||
    !validCampFile(m.root) ||
    !validCampFile(m.catalog) ||
    typeof m.attribution !== 'string'
  )
    throw new Error('Invalid camping release. Reload the prepared layer.');
  return m;
}
export function validCampFile(f: CampFile) {
  return (
    f &&
    /^[a-z0-9-]+\.json$/.test(f.file) &&
    Number.isSafeInteger(f.bytes) &&
    f.bytes > 0 &&
    f.bytes <= CAMP_BUDGET.file &&
    /^[a-f0-9]{64}$/.test(f.sha256)
  );
}
export function campIntersects(a: number[], b: number[]): boolean {
  if (a[0] > a[2])
    return (
      campIntersects([a[0], a[1], 180, a[3]], b) ||
      campIntersects([-180, a[1], a[2], a[3]], b)
    );
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}
export function campMapped(
  r: Pick<CampRecord, 'location' | 'coordinate_quality'>,
) {
  return (
    r.coordinate_quality === 'within_us_state_polygon' &&
    validCampLocation(r.location)
  );
}
export function validCampLocation(p: unknown): p is [number, number] {
  return (
    Array.isArray(p) &&
    p.length === 2 &&
    p.every(Number.isFinite) &&
    Math.abs(p[0]) <= 180 &&
    Math.abs(p[1]) <= 90
  );
}
export function campWords(value: string) {
  return (
    value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .match(/[a-z0-9]+/g) || []
  );
}
export function campUrl(value: string | null) {
  try {
    const url = new URL(value || '');
    return ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function campSearchResult(
  r: CampSearchRow,
  version: string,
): SearchResult {
  return {
    id: `camping:${r[0]}`,
    kind: 'camping',
    name: r[1],
    detail: [
      r[7].replaceAll('_', ' '),
      r[4],
      PAYMENT_LABELS[r[3]],
      r[6],
      r[5] ? '' : 'Location unavailable',
    ]
      .filter(Boolean)
      .join(' · '),
    terms: r[0],
    lat: r[5]?.[1] ?? null,
    lon: r[5]?.[0] ?? null,
    height: 6000,
    source: r[8],
    sourceUrl: '',
    release: version,
    target: { type: 'camping', recordId: r[0], layer: r[2], version },
  };
}
export function campRecordResult(r: CampRecord, version: string) {
  return campSearchResult(
    [
      r.id,
      r.name,
      r.layer,
      r.payment_status,
      r.state,
      campMapped(r) ? r.location : null,
      r.parent_name,
      r.kind,
      r.source,
    ],
    version,
  );
}
