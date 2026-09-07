import { twoline2satrec } from 'satellite.js';
import {
  catalogType,
  elementEpoch,
  isSpaceObject,
  MAX_ELEMENT_AGE,
  type SpaceObject,
} from './space-data';

export const SATNOGS_TLE_URL = 'https://db.satnogs.org/api/tle/';
const ALPHA5 = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function tleId(value: string) {
  return /^\d{5}$/.test(value)
    ? Number(value)
    : /^[A-HJ-NP-Z]\d{4}$/.test(value)
      ? (ALPHA5.indexOf(value[0]) + 10) * 10000 + Number(value.slice(1))
      : NaN;
}
function checksum(line: string) {
  if (line.length !== 69 || !/^\d$/.test(line[68])) return false;
  let sum = 0;
  for (let i = 0; i < 68; i++) {
    const c = line[i];
    sum += /\d/.test(c) ? Number(c) : c === '-' ? 1 : 0;
  }
  return sum % 10 === Number(line[68]);
}
function exponent(value: string) {
  return /^[ +-]\d{5}[+-]\d$/.test(value)
    ? Number(
        `${value[0] === '-' ? '-' : ''}0.${value.slice(1, 6)}e${value.slice(6)}`,
      )
    : NaN;
}
export function parseFallbackOrbits(
  input: unknown,
  metadata: Map<number, Record<string, string>>,
  catalogFetchedAt: number,
  now: number,
) {
  if (!Array.isArray(input)) throw Error('Invalid SatNOGS catalog.');
  const objects = new Map<number, SpaceObject>();
  for (const row of input) {
    if (!row || typeof row !== 'object') continue;
    const { tle1: a, tle2: b, norad_cat_id: id } = row;
    const catalog = metadata.get(id);
    const objectType = catalog && catalogType(catalog);
    if (
      !catalog ||
      !objectType ||
      typeof a !== 'string' ||
      typeof b !== 'string' ||
      !a.startsWith('1 ') ||
      !b.startsWith('2 ') ||
      !checksum(a) ||
      !checksum(b) ||
      tleId(a.slice(2, 7)) !== id ||
      tleId(b.slice(2, 7)) !== id
    )
      continue;
    const year = Number(a.slice(18, 20)),
      day = Number(a.slice(20, 32));
    if (
      !Number.isInteger(year) ||
      !Number.isFinite(day) ||
      day < 1 ||
      day >= 367
    )
      continue;
    const epoch =
      Date.UTC(year < 57 ? 2000 + year : 1900 + year, 0, 1) +
      (day - 1) * 86400000;
    if (!Number.isFinite(epoch) || Math.abs(now - epoch) > MAX_ELEMENT_AGE)
      continue;
    const o: SpaceObject = {
      OBJECT_NAME: catalog.OBJECT_NAME,
      OBJECT_ID: catalog.OBJECT_ID,
      NORAD_CAT_ID: id,
      EPOCH: new Date(epoch).toISOString(),
      MEAN_MOTION: Number(b.slice(52, 63)),
      ECCENTRICITY: Number('0.' + b.slice(26, 33)),
      INCLINATION: Number(b.slice(8, 16)),
      RA_OF_ASC_NODE: Number(b.slice(17, 25)),
      ARG_OF_PERICENTER: Number(b.slice(34, 42)),
      MEAN_ANOMALY: Number(b.slice(43, 51)),
      BSTAR: exponent(a.slice(53, 61)),
      MEAN_MOTION_DOT: Number(a.slice(33, 43)),
      MEAN_MOTION_DDOT: exponent(a.slice(44, 52)),
      EPHEMERIS_TYPE: Number(a[62]),
      CLASSIFICATION_TYPE: a[7],
      ELEMENT_SET_NO: Number(a.slice(64, 68)),
      REV_AT_EPOCH: Number(b.slice(63, 68)),
      objectType,
      catalog,
      catalogFetchedAt,
      elementSource: 'SatNOGS DB',
      elementSourceUrl: SATNOGS_TLE_URL,
      elementLicense: 'CC BY-SA',
      TLE_SOURCE: typeof row.tle_source === 'string' ? row.tle_source : '',
      TLE_UPDATED: typeof row.updated === 'string' ? row.updated : '',
      TLE_LINE_1: a,
      TLE_LINE_2: b,
    };
    if (!isSpaceObject(o)) continue;
    // Reject malformed fixed-width numeric fields that the permissive parser
    // cannot initialize, even when they passed basic numeric validation.
    try {
      const sat = twoline2satrec(a, b);
      if (sat.error || !Number.isFinite(sat.no)) continue;
    } catch {
      continue;
    }
    const previous = objects.get(id);
    if (!previous || elementEpoch(o) > elementEpoch(previous))
      objects.set(id, o);
  }
  if (!objects.size)
    throw Error('No current, classified objects in the backup catalog.');
  return [...objects.values()].sort((a, b) => a.NORAD_CAT_ID - b.NORAD_CAT_ID);
}
