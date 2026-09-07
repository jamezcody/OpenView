export type CameraView = {
  lat: number;
  lon: number;
  height: number;
  zoom?: number;
  pitch?: number;
  heading?: number;
};
export type Bounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};
export type OMM = {
  OBJECT_NAME: string;
  NORAD_CAT_ID: number;
  EPOCH: string;
  MEAN_MOTION: number;
  ECCENTRICITY: number;
  INCLINATION: number;
  RA_OF_ASC_NODE: number;
  ARG_OF_PERICENTER: number;
  MEAN_ANOMALY: number;
  BSTAR: number;
  MEAN_MOTION_DOT: number;
  MEAN_MOTION_DDOT: number;
  [key: string]: unknown;
};
export type Track = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  altitude: number;
  altitudeKnown?: boolean;
  speed: number | null;
  heading: number | null;
  observedAt: number;
  kind: 'aircraft' | 'ships';
  source?: string;
  sourceUrl?: string;
  trueHeading?: number | null;
  timestampBasis?: 'receiver' | 'received';
  destination?: string;
  vesselType?: number;
  registration?: string;
  country?: string;
};
export type Snapshot<T> = {
  items: T[];
  fetchedAt: number;
  nextRefreshAt: number;
  source: string;
  sourceUrl: string;
  cached?: boolean;
  coverage?: string;
  omitted?: number;
  warning?: string;
};
export type ParcelProperties = {
  id: string;
  owner: string;
  address: string;
  locality: string;
  sourceDate: string | null;
  source: string;
  sourceUrl: string;
};
export type ParcelFeature = {
  type: 'Feature';
  id: string;
  properties: ParcelProperties;
  geometry: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: number[][][] | number[][][][];
  };
};
export type ParcelCollection = {
  type: 'FeatureCollection';
  features: ParcelFeature[];
};
export type ParcelSnapshot = {
  data: ParcelCollection;
  fetchedAt: number;
  source: string;
  sourceUrl: string;
  truncated: boolean;
  bounds: Bounds;
  cached?: boolean;
};
export const REGIONS = [
  {
    id: 'nc',
    name: 'North Carolina',
    source: 'NC OneMap / counties and EBCI',
    url: 'https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer/1',
    bounds: [-84.4, 33.8, -75.4, 36.6],
    lat: 35.7805,
    lon: -78.6391,
    height: 1800,
    fields: 'objectid,parno,ownname,ownname2,siteadd,scity,cntyname,revisedate',
  },
  {
    id: 'ct',
    name: 'Connecticut',
    source: 'Connecticut GIS Office / municipalities',
    url: 'https://services3.arcgis.com/3FL1kr7L4LvwA2Kb/arcgis/rest/services/Connecticut_CAMA_and_Parcel_Layer/FeatureServer/0',
    bounds: [-73.7422, 40.9799, -71.7813, 42.0486],
    lat: 41.764,
    lon: -72.6821,
    height: 1800,
    fields:
      'OBJECTID,Parcel_ID,Owner,Co_Owner,Location,Location_1,Town_Name,Property_City,Source_Date',
  },
  {
    id: 'az',
    name: 'Maricopa County',
    source: 'Maricopa County Assessor',
    url: 'https://gis.mcassessor.maricopa.gov/arcgis/rest/services/Parcels/MapServer/0',
    bounds: [-113.335, 32.6955, -111.0818, 34.0469],
    lat: 33.4466,
    lon: -112.0764,
    height: 1800,
    fields: 'OBJECTID,APN,OWNER_NAME,PHYSICAL_ADDRESS,PHYSICAL_CITY',
  },
] as const;
export function regionAt(lat: number, lon: number) {
  return REGIONS.find(
    (r) =>
      lon >= r.bounds[0] &&
      lon <= r.bounds[2] &&
      lat >= r.bounds[1] &&
      lat <= r.bounds[3],
  );
}
export function ageLabel(timestamp: number, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
export function utc(timestamp: number | string) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? 'Not supplied'
    : date.toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
}
