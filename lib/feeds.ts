import {
  REGIONS,
  type OMM,
  type Track,
  type Snapshot,
  type Bounds,
  type ParcelFeature,
  type ParcelProperties,
} from './model';
import { BodyTooLargeError, boundedJson } from './bounded-fetch';
export class FeedError extends Error {
  constructor(
    message: string,
    public status = 502,
    public retryAfter = 60,
  ) {
    super(message);
  }
}
type Stored = {
  expires: number;
  value: unknown;
  error?: { message: string; status: number; retryAfter: number };
};
const memory = new Map<string, Stored>(),
  pending = new Map<string, Promise<unknown>>();
// Keep response objects below a conservative budget in a 128 MB worker isolate.
const sizes = new Map(),
  MEMORY_BUDGET = 12 * 1024 * 1024;
let memoryBytes = 0;
function remember(key: string, item: Stored) {
  const bytes = JSON.stringify(item).length * 3;
  if (sizes.has(key)) {
    memoryBytes -= sizes.get(key);
    sizes.delete(key);
    memory.delete(key);
  }
  if (bytes > 4 * 1024 * 1024) return;
  while (memory.size >= 24 || memoryBytes + bytes > MEMORY_BUDGET) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memoryBytes -= sizes.get(oldest) || 0;
    sizes.delete(oldest);
    memory.delete(oldest);
  }
  memory.set(key, item);
  sizes.set(key, bytes);
  memoryBytes += bytes;
}
function edgeCache() {
  return typeof caches === 'undefined'
    ? undefined
    : (caches as CacheStorage & { default?: Cache }).default;
}
export async function cached<T>(
  key: string,
  ttl: number | ((value: T) => number),
  loader: () => Promise<T>,
): Promise<T & { cached: boolean }> {
  const now = Date.now();
  let entry = memory.get(key);
  const cache = edgeCache();
  const request = new Request(
    `https://openview-cache.invalid/${encodeURIComponent(key)}`,
  );
  if (!entry && cache) {
    const hit = await cache.match(request).catch(() => undefined);
    if (hit) entry = (await hit.json().catch(() => undefined)) as Stored;
  }
  if (entry && entry.expires > now) {
    if (entry.error)
      throw new FeedError(
        entry.error.message,
        entry.error.status,
        Math.ceil((entry.expires - now) / 1000),
      );
    return { ...(entry.value as T), cached: true };
  }
  if (pending.has(key))
    return (await pending.get(key)) as T & { cached: boolean };
  const job = (async () => {
    try {
      const value = await loader();
      const duration = typeof ttl === 'function' ? ttl(value) : ttl;
      const item: Stored = { expires: Date.now() + duration * 1000, value };
      remember(key, item);
      if (cache)
        await cache
          .put(
            request,
            new Response(JSON.stringify(item), {
              headers: { 'Cache-Control': `max-age=${duration}` },
            }),
          )
          .catch(() => {});
      return { ...value, cached: false };
    } catch (e) {
      if (
        e instanceof Error &&
        (e.name === 'AbortError' || e.name === 'TimeoutError')
      )
        throw e;
      const err =
        e instanceof FeedError
          ? e
          : new FeedError(
              'The provider could not be reached. Please try again later.',
            );
      const cooldown = key.startsWith('orbits') ? 7200 : err.retryAfter;
      const item: Stored = {
        expires: Date.now() + cooldown * 1000,
        value: null,
        error: {
          message: err.message,
          status: err.status,
          retryAfter: cooldown,
        },
      };
      remember(key, item);
      if (cache)
        await cache
          .put(
            request,
            new Response(JSON.stringify(item), {
              headers: { 'Cache-Control': `max-age=${cooldown}` },
            }),
          )
          .catch(() => {});
      throw new FeedError(err.message, err.status, cooldown);
    } finally {
      pending.delete(key);
      if (memory.size > 120) memory.delete(memory.keys().next().value!);
    }
  })();
  pending.set(key, job);
  return await job;
}
export async function upstream<T = unknown>(
  url: string,
  headers: Record<string, string> = {},
  maxBytes = 16 * 1024 * 1024,
): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'OpenView/0.1.1',
        'Accept-Encoding': 'gzip',
        ...headers,
      },
      signal: AbortSignal.timeout(25000),
    });
  } catch {
    throw new FeedError(
      'The data source timed out or is unavailable. Existing data has been kept.',
    );
  }
  if (!r.ok) {
    const wait = r.headers.get('Retry-After');
    const seconds = wait
      ? Number(wait) || Math.ceil((Date.parse(wait) - Date.now()) / 1000)
      : 60;
    await r.body?.cancel();
    throw new FeedError(
      `The data source returned HTTP ${r.status}. Existing data has been kept.`,
      r.status === 429 ? 429 : 502,
      Math.max(60, Number.isFinite(seconds) ? seconds : 60),
    );
  }
  try {
    return await boundedJson<T>(r, maxBytes);
  } catch (error) {
    if (error instanceof BodyTooLargeError)
      throw new FeedError(
        'The provider response exceeded the safe size limit.',
      );
    throw new FeedError('The provider returned an unreadable response.');
  }
}
export async function satellites(): Promise<Snapshot<OMM>> {
  return cached('orbits-stations', 7200, async () => {
    const url =
      'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=JSON';
    const data = await upstream<unknown>(url, {}, 2 * 1024 * 1024);
    if (!Array.isArray(data))
      throw new FeedError('The orbital source did not return a catalog.');
    const items = data
      .filter(
        (v: OMM) =>
          v.OBJECT_NAME &&
          Number.isFinite(Number(v.NORAD_CAT_ID)) &&
          [
            'MEAN_MOTION',
            'ECCENTRICITY',
            'INCLINATION',
            'RA_OF_ASC_NODE',
            'ARG_OF_PERICENTER',
            'MEAN_ANOMALY',
            'BSTAR',
            'MEAN_MOTION_DOT',
            'MEAN_MOTION_DDOT',
          ].every((k) => Number.isFinite(v[k])) &&
          Number.isFinite(Date.parse(v.EPOCH)) &&
          v.MEAN_MOTION > 0 &&
          v.ECCENTRICITY >= 0 &&
          v.ECCENTRICITY < 1,
      )
      .slice(0, 150);
    if (!items.length)
      throw new FeedError('No valid orbital elements were returned.');
    const fetchedAt = Date.now();
    return {
      items,
      fetchedAt,
      nextRefreshAt: fetchedAt + 7200000,
      source: 'CelesTrak · space stations and associated objects',
      sourceUrl: 'https://celestrak.org/NORAD/elements/',
      coverage: 'Earth-orbiting station catalog',
    };
  });
}
const finite = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);
const scalarText = (value: unknown): string => {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return String(value);
  return '';
};
const position = (lat: unknown, lon: unknown) =>
  finite(lat) && finite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
export function normalizeAircraft(
  data: { now: number; ac: Record<string, unknown>[] },
  now = Date.now(),
): Track[] {
  if (!finite(data.now) || !Array.isArray(data.ac))
    throw new FeedError('The aircraft feed has an unexpected format.');
  return data.ac.flatMap((a) => {
    if (!position(a.lat, a.lon) || !finite(a.seen_pos)) return [];
    const observedAt = data.now - a.seen_pos * 1000;
    if (observedAt < now - 300000 || observedAt > now + 60000) return [];
    const alt = finite(a.alt_geom) ? a.alt_geom : a.alt_baro;
    const id = scalarText(a.hex),
      registration = scalarText(a.r),
      name = scalarText(a.flight) || registration || id;
    if (!id) return [];
    return [
      {
        id,
        name: name.trim(),
        registration,
        lat: a.lat as number,
        lon: a.lon as number,
        altitude: finite(alt) ? Math.max(0, alt * 0.3048) : 0,
        altitudeKnown: finite(alt) || alt === 'ground',
        speed: finite(a.gs) ? a.gs : null,
        heading:
          finite(a.track) && a.track >= 0 && a.track < 360 ? a.track : null,
        observedAt,
        kind: 'aircraft' as const,
      },
    ];
  });
}
export async function aircraft(lat: number, lon: number) {
  lat = Math.round(lat * 20) / 20;
  lon = Math.round(lon * 20) / 20;
  return cached(`aircraft-${lat}-${lon}`, 15, async () => {
    const data = await upstream<{
      now: number;
      ac: Record<string, unknown>[];
    }>(
      `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/250`,
      {},
      12 * 1024 * 1024,
    );
    const fetchedAt = Date.now(),
      items = normalizeAircraft(data, fetchedAt);
    return {
      items,
      fetchedAt,
      nextRefreshAt: fetchedAt + 15000,
      source: 'ADSB.lol · ODbL',
      sourceUrl: 'https://www.adsb.lol/',
      coverage: `Within 250 nautical miles of ${lat.toFixed(2)}°, ${lon.toFixed(2)}°`,
      omitted: data.ac.length - items.length,
    };
  });
}
export function normalizeShips(
  data: {
    features: {
      geometry?: { coordinates: number[] };
      properties: Record<string, unknown>;
    }[];
  },
  names: Map<string, string>,
  now = Date.now(),
): Track[] {
  if (!Array.isArray(data.features))
    throw new FeedError('The ship feed has an unexpected format.');
  return data.features.flatMap((f) => {
    const [lon, lat] = f.geometry?.coordinates ?? [],
      p = f.properties;
    if (
      !p ||
      !position(lat, lon) ||
      !finite(p.timestampExternal) ||
      p.timestampExternal < now - 86400000 ||
      p.timestampExternal > now + 60000
    )
      return [];
    const mmsi = scalarText(p.mmsi);
    if (!mmsi) return [];
    return [
      {
        id: mmsi,
        name: names.get(mmsi) || `MMSI ${mmsi}`,
        lat,
        lon,
        altitude: 8,
        speed: finite(p.sog) && p.sog >= 0 && p.sog < 102.3 ? p.sog : null,
        heading: finite(p.cog) && p.cog >= 0 && p.cog < 360 ? p.cog : null,
        observedAt: p.timestampExternal,
        kind: 'ships' as const,
      },
    ];
  });
}
export async function ships() {
  return cached('ships-baltic', 60, async () => {
    const h = { 'Digitraffic-User': 'OpenView/0.1.1' };
    const [data, metadata] = await Promise.all([
      upstream<{
        features: {
          geometry?: { coordinates: number[] };
          properties: Record<string, unknown>;
        }[];
      }>(
        'https://meri.digitraffic.fi/api/ais/v1/locations',
        h,
        24 * 1024 * 1024,
      ),
      cached('ship-names', 3600, async () => ({
        items: await upstream<{ mmsi: number; name: string }[]>(
          'https://meri.digitraffic.fi/api/ais/v1/vessels',
          h,
          16 * 1024 * 1024,
        ),
      })).catch(() => ({ items: [] })),
    ]);
    const rows = Array.isArray(metadata.items) ? metadata.items : [];
    const names = new Map<string, string>(
      rows.map((r: { mmsi: number; name: string }) => [
        String(r.mmsi),
        r.name?.trim(),
      ]),
    );
    const fetchedAt = Date.now(),
      items = normalizeShips(data, names, fetchedAt);
    return {
      items,
      fetchedAt,
      nextRefreshAt: fetchedAt + 60000,
      source: 'Fintraffic / Digitraffic · CC BY 4.0',
      sourceUrl: 'https://www.digitraffic.fi/en/marine-traffic/',
      coverage: 'Finnish coastal waters and Baltic AIS receiver coverage',
      omitted: data.features.length - items.length,
    };
  });
}
export function cleanOwner(value: unknown) {
  const v = scalarText(value).trim();
  return !v || /^(current (co-)?owner|unknown|n\/a|null)$/i.test(v)
    ? 'Owner unavailable'
    : v;
}
export function parcelProperties(
  raw: Record<string, unknown>,
  region: (typeof REGIONS)[number],
): ParcelProperties {
  const text = (v: unknown) => scalarText(v).trim();
  const first = (...values: unknown[]) => values.map(text).find(Boolean) || '';
  const sourceDate = raw.revisedate ?? raw.Source_Date;
  const owners = [
    ...new Set(
      [raw.ownname, raw.ownname2, raw.OWNER_NAME, raw.Owner, raw.Co_Owner]
        .map(cleanOwner)
        .filter((v) => v !== 'Owner unavailable'),
    ),
  ];
  return {
    id: first(raw.parno, raw.APN, raw.Parcel_ID),
    owner: owners.join(' / ') || 'Owner unavailable',
    address: first(
      raw.siteadd,
      raw.PHYSICAL_ADDRESS,
      raw.Location_1,
      raw.Location,
    ),
    locality: first(raw.scity, raw.PHYSICAL_CITY, raw.Town_Name),
    sourceDate: sourceDate
      ? typeof sourceDate === 'number' && Number.isFinite(sourceDate)
        ? new Date(sourceDate).toISOString()
        : scalarText(sourceDate)
      : null,
    source: region.source,
    sourceUrl: region.url,
  };
}
export async function parcels(regionId: string, bounds: Bounds) {
  const region = REGIONS.find((r) => r.id === regionId);
  if (!region)
    throw new FeedError('Choose a supported parcel jurisdiction.', 400);
  const { west, south, east, north } = bounds;
  if (
    !Object.values(bounds).every(finite) ||
    west >= east ||
    south >= north ||
    east - west > 0.12 ||
    north - south > 0.12 ||
    west < region.bounds[0] ||
    east > region.bounds[2] ||
    south < region.bounds[1] ||
    north > region.bounds[3]
  )
    throw new FeedError(
      'Zoom closer within a supported jurisdiction before updating parcels.',
      400,
    );
  return cached(
    `parcels-${regionId}-${Object.values(bounds)
      .map((n) => n.toFixed(5))
      .join(',')}`,
    300,
    async () => {
      const query = new URLSearchParams({
        f: 'geojson',
        where: '1=1',
        geometry: `${west},${south},${east},${north}`,
        geometryType: 'esriGeometryEnvelope',
        inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        outFields: region.fields,
        returnGeometry: 'true',
        outSR: '4326',
        resultRecordCount: '250',
        geometryPrecision: '6',
      });
      const data = await upstream<{
        error?: unknown;
        features: {
          geometry: ParcelFeature['geometry'];
          properties: Record<string, unknown>;
        }[];
        exceededTransferLimit?: boolean;
      }>(`${region.url}/query?${query}`, {}, 8 * 1024 * 1024);
      if (data.error || !Array.isArray(data.features))
        throw new FeedError(
          'The parcel source did not return usable boundaries.',
        );
      const features: ParcelFeature[] = data.features
        .filter(
          (f) =>
            f.geometry && ['Polygon', 'MultiPolygon'].includes(f.geometry.type),
        )
        .map(
          (
            f: {
              geometry: ParcelFeature['geometry'];
              properties: Record<string, unknown>;
            },
            i: number,
          ) => ({
            type: 'Feature',
            id: `${region.id}-${i}-${scalarText(
              f.properties.objectid ?? f.properties.OBJECTID,
            )}`,
            geometry: f.geometry,
            properties: parcelProperties(f.properties, region),
          }),
        );
      return {
        data: { type: 'FeatureCollection' as const, features },
        fetchedAt: Date.now(),
        source: region.source,
        sourceUrl: region.url,
        truncated: !!data.exceededTransferLimit || data.features.length >= 250,
        bounds,
      };
    },
  );
}
