import type { OMM, Snapshot } from './model';

export const SPACE_REFRESH_INTERVAL = 24 * 60 * 60 * 1000;
export function spaceRefreshAt(
  snapshot: Pick<Snapshot<unknown>, 'fetchedAt' | 'nextRefreshAt'>,
) {
  return Math.max(
    snapshot.nextRefreshAt,
    snapshot.fetchedAt + SPACE_REFRESH_INTERVAL,
  );
}
export function migrateSpaceRetryAt(
  retryAt: number,
  previousInterval = 2 * 60 * 60 * 1000,
) {
  // Older cached deadlines used a two-hour cadence. Extend them once, without
  // querying a provider or shortening a longer provider-requested wait.
  return retryAt > 0
    ? retryAt + Math.max(0, SPACE_REFRESH_INTERVAL - previousInterval)
    : 0;
}

export type SpaceType = 'payload' | 'rocket-body';
export const SPACE_TYPES: SpaceType[] = ['payload', 'rocket-body'];
export const SPACE_LABELS: Record<SpaceType, string> = {
  payload: 'Satellites / payloads',
  'rocket-body': 'Rocket bodies',
};
export const SPACE_COLORS = { payload: '#c3ed97', 'rocket-body': '#ffc16d' };
export const DEFAULT_SPACE_TYPES: Record<SpaceType, boolean> = {
  payload: true,
  'rocket-body': false,
};
export const SPACE_CACHE_KEY = 'openview-space-v2';
export const MAX_ELEMENT_AGE = 14 * 86400000;
export type SpaceObject = OMM & {
  objectType: SpaceType;
  catalog: Record<string, string>;
  catalogFetchedAt: number;
};

// CSV includes quoted commas, escaped quotes and occasionally embedded newlines.
// Yield records instead of retaining a second copy of the entire SATCAT.
export function* csvRecords(text: string): Generator<Record<string, string>> {
  let row: string[] = [],
    field = '',
    quoted = false;
  let headers: string[] | undefined;
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i] ?? '\n';
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (ch === ',' || ch === '\n' || ch === '\r')) {
      row.push(field);
      field = '';
      if (ch === ',') continue;
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (!headers) headers = row.map((s) => s.replace(/^\uFEFF/, '').trim());
      else if (row.some((s) => s !== '')) {
        if (row.length !== headers.length)
          throw Error('Malformed catalog CSV row.');
        yield Object.fromEntries(headers.map((key, j) => [key, row[j].trim()]));
      }
      row = [];
    } else field += ch;
  }
  if (quoted) throw Error('Unterminated catalog CSV field.');
  if (!headers?.includes('NORAD_CAT_ID'))
    throw Error('Unrecognized catalog format.');
}

export function catalogType(row: Record<string, unknown>): SpaceType | null {
  // Fail closed: never guess a type from the name or expose unknown/debris records.
  if (row.OBJECT_TYPE === 'PAY') return 'payload';
  if (row.OBJECT_TYPE === 'R/B') return 'rocket-body';
  return null;
}
export function onEarthOrbit(row: Record<string, string>) {
  return (
    !row.DECAY_DATE &&
    row.OPS_STATUS_CODE !== 'D' &&
    (row.ORBIT_CENTER === 'EA' || /^\d+$/.test(row.ORBIT_CENTER)) &&
    (row.ORBIT_TYPE === 'ORB' || row.ORBIT_TYPE === 'DOC')
  );
}
export function parseSpaceMetadata(csv: string) {
  const records = new Map<number, Record<string, string>>();
  for (const row of csvRecords(csv)) {
    const id = Number(row.NORAD_CAT_ID);
    if (
      Number.isSafeInteger(id) &&
      id > 0 &&
      catalogType(row) &&
      onEarthOrbit(row)
    )
      records.set(id, row);
  }
  if (!records.size)
    throw Error('No classified Earth-orbiting objects in SATCAT.');
  return records;
}
const NUMERIC_ELEMENTS = [
  'MEAN_MOTION',
  'ECCENTRICITY',
  'INCLINATION',
  'RA_OF_ASC_NODE',
  'ARG_OF_PERICENTER',
  'MEAN_ANOMALY',
  'BSTAR',
  'MEAN_MOTION_DOT',
  'MEAN_MOTION_DDOT',
  'EPHEMERIS_TYPE',
  'ELEMENT_SET_NO',
  'REV_AT_EPOCH',
] as const;
export function validElements(o: OMM) {
  return (
    typeof o.OBJECT_NAME === 'string' &&
    !!o.OBJECT_NAME &&
    Number.isSafeInteger(o.NORAD_CAT_ID) &&
    o.NORAD_CAT_ID > 0 &&
    typeof o.EPOCH === 'string' &&
    Number.isFinite(elementEpoch(o)) &&
    NUMERIC_ELEMENTS.slice(0, 9).every((k) => Number.isFinite(o[k])) &&
    o.MEAN_MOTION > 0 &&
    o.ECCENTRICITY >= 0 &&
    o.ECCENTRICITY < 1 &&
    o.INCLINATION >= 0 &&
    o.INCLINATION <= 180
  );
}
export function elementEpoch(o: OMM) {
  return Date.parse(o.EPOCH.endsWith('Z') ? o.EPOCH : o.EPOCH + 'Z');
}
export function isSpaceObject(value: unknown): value is SpaceObject {
  if (!value || typeof value !== 'object') return false;
  const o = value as SpaceObject;
  return (
    !!o.catalog &&
    catalogType(o.catalog) === o.objectType &&
    SPACE_TYPES.includes(o.objectType) &&
    onEarthOrbit(o.catalog) &&
    Number(o.catalog.NORAD_CAT_ID) === o.NORAD_CAT_ID &&
    Number.isFinite(o.catalogFetchedAt) &&
    validElements(o)
  );
}
export function parseSpaceOrbits(
  csv: string,
  metadata: Map<number, Record<string, string>>,
  catalogFetchedAt: number,
) {
  const objects = new Map<number, SpaceObject>();
  for (const row of csvRecords(csv)) {
    const id = Number(row.NORAD_CAT_ID),
      catalog = metadata.get(id);
    if (!catalog) continue;
    const objectType = catalogType(catalog);
    if (!objectType) continue;
    const o = {
      ...row,
      NORAD_CAT_ID: id,
      objectType,
      catalog,
      catalogFetchedAt,
    } as unknown as SpaceObject;
    for (const key of NUMERIC_ELEMENTS)
      if (row[key]?.trim()) o[key] = Number(row[key]);
    if (!validElements(o)) continue;
    const previous = objects.get(id);
    if (!previous || elementEpoch(o) > elementEpoch(previous))
      objects.set(id, o);
  }
  if (!objects.size)
    throw Error('No valid payload or rocket-body orbits in the catalog.');
  return [...objects.values()].sort((a, b) => a.NORAD_CAT_ID - b.NORAD_CAT_ID);
}
export function visibleSpaceObjects(
  objects: OMM[],
  types: Record<SpaceType, boolean>,
) {
  return objects.filter(
    (o): o is SpaceObject => isSpaceObject(o) && types[o.objectType],
  );
}
export const OPS_LABELS: Record<string, string> = {
  '+': 'Operational',
  '-': 'Non-operational',
  P: 'Partially operational',
  B: 'Backup / standby',
  S: 'Spare',
  X: 'Extended mission',
  D: 'Decayed',
  '?': 'Unknown',
};
