import sourceRegistry from './data/us-parcels.json';
import type { Bounds, ParcelFeature, ParcelSnapshot } from './model';
export type AddressPoint = {
  id: string;
  lat: number;
  lon: number;
  number: string;
  street: string;
  unit: string;
  postcode: string;
  city: string;
  country: string;
  label: string;
  sources: { dataset: string; license?: string; record_id?: string }[];
  source: 'Overture Maps' | 'Parcel situs' | 'OpenStreetMap / Photon';
  parcelId?: string;
  sourceId?: string;
};
export type AddressSnapshot = {
  items: AddressPoint[];
  bounds: Bounds;
  fetchedAt: number;
  release: string;
  truncated: boolean;
  totalInView: number;
  tiles: number;
  warnings: string[];
  source: string;
  sourceUrl: string;
};
export type ParcelAdapter = {
  id: string;
  name: string;
  country: string;
  coverage: string;
  bounds: number[];
  url: string;
  sourceUrl: string;
  objectIdField: string;
  fields: Record<string, string[]>;
  outFields: string;
  boundaryOutFields: string;
  ownerDataOutFields: string;
  fieldTypes: Record<string, string>;
  supportsPagination: boolean;
  maxRecordCount: number;
  dataLastEdited: string | null;
  checkedAt: string;
  testCenter: number[];
  notes?: string;
  ownerRole?: string;
  suppressOwnerWhen?: {
    field?: string;
    fields?: string[];
    trueValues?: string[];
    falseValues?: string[];
    placeholderValues?: string[];
    alsoSuppressUnknownNonemptyValues?: boolean;
  };
};
export const PARCEL_ADAPTERS =
  sourceRegistry.adapters as unknown as ParcelAdapter[];
export type SourceStatus = {
  id: string;
  name: string;
  status: 'success' | 'empty' | 'failed' | 'unsupported';
  count: number;
  message?: string;
  url: string;
  truncated?: boolean;
};
export type LandParcelSnapshot = ParcelSnapshot & {
  sources: SourceStatus[];
  featureCount: number;
};
export type LandParcelFeature = ParcelFeature & {
  properties: ParcelFeature['properties'] & {
    sourceId?: string;
    objectId?: string;
  };
};
export type PropertyEvidence = {
  sourceId: string;
  source: string;
  sourceUrl: string;
  retrievedAt: number;
  match: 'point intersects parcel' | 'linked public record';
  parcelId: string;
  address: string;
  ownerNames: string[];
  ownerRole: string;
  sourceDate: string | null;
  facts: { field: string; label: string; value: string }[];
  recordLinks: string[];
  notes: string[];
};
export type PropertyInquiry = {
  address: AddressPoint;
  startedAt: number;
  completedAt?: number;
  status: 'running' | 'complete';
  evidence: PropertyEvidence[];
  checks: { source: string; status: string; message: string; url?: string }[];
  directory: {
    name: string;
    url: string;
    jurisdiction: string;
    access: string;
    notes: string;
  }[];
};
export type InquiryEvent =
  | { type: 'started'; value: PropertyInquiry }
  | { type: 'check'; value: PropertyInquiry['checks'][number] }
  | { type: 'evidence'; value: PropertyEvidence }
  | { type: 'complete'; value: PropertyInquiry }
  | { type: 'error'; message: string };
export function isInBounds(lat: number, lon: number, b: Bounds) {
  return lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north;
}
export function validateBounds(b: Bounds, maxSpan = 0.12) {
  if (
    !Object.values(b).every(Number.isFinite) ||
    b.west >= b.east ||
    b.south >= b.north ||
    b.west < -180 ||
    b.east > 180 ||
    b.south < -85 ||
    b.north > 85 ||
    b.east - b.west > maxSpan ||
    b.north - b.south > maxSpan
  )
    throw new Error(
      'Zoom closer to a neighborhood before loading this overlay.',
    );
  return b;
}
export function adaptersForBounds(b: Bounds) {
  return PARCEL_ADAPTERS.filter(
    (a) =>
      b.east >= a.bounds[0] &&
      b.west <= a.bounds[2] &&
      b.north >= a.bounds[1] &&
      b.south <= a.bounds[3],
  );
}
export function adaptersAt(lat: number, lon: number) {
  return PARCEL_ADAPTERS.filter(
    (a) =>
      lon >= a.bounds[0] &&
      lon <= a.bounds[2] &&
      lat >= a.bounds[1] &&
      lat <= a.bounds[3],
  );
}
export function addressLabel(
  a: Pick<AddressPoint, 'number' | 'street' | 'unit' | 'city' | 'postcode'>,
) {
  return [
    [a.number, a.street].filter(Boolean).join(' '),
    a.unit ? `Unit ${a.unit}` : '',
    [a.city, a.postcode].filter(Boolean).join(' '),
  ]
    .filter(Boolean)
    .join(', ');
}
