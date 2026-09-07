import { readBounded } from './bounded-fetch';
import { PMTiles, ResolvedValueCache, type Source } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { cached, FeedError } from './feeds';
import {
  addressLabel,
  isInBounds,
  validateBounds,
  type AddressPoint,
  type AddressSnapshot,
} from './land-model';
import type { Bounds } from './model';
export const ADDRESS_RELEASE = '2026-08-19.0';
const URL_ADDRESS = `https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/${ADDRESS_RELEASE}/addresses.pmtiles`;
const source: Source = {
  getKey: () => URL_ADDRESS,
  async getBytes(offset, length, signal) {
    if (length > 8 * 1024 * 1024)
      throw new Error('Address range request exceeds the size limit.');
    const response = await fetch(URL_ADDRESS, {
      headers: { Range: `bytes=${offset}-${offset + length - 1}` },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(18000)])
        : AbortSignal.timeout(18000),
    });
    if (response.status !== 206) {
      await response.body?.cancel();
      throw new Error(
        `Address source did not return a byte range (HTTP ${response.status}).`,
      );
    }
    const data = (await readBounded(response, length)).buffer as ArrayBuffer;
    if (data.byteLength !== length)
      throw new Error('Address source returned an incomplete byte range.');
    return {
      data,
      etag: response.headers.get('etag') ?? undefined,
      cacheControl: response.headers.get('cache-control') ?? undefined,
    };
  },
};
const archive = new PMTiles(source, new ResolvedValueCache(16));
const clamp = (x: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, x));
export function addressTilesForBounds(bounds: Bounds) {
  validateBounds(bounds);
  const z = 14,
    n = 2 ** z;
  const x = (lon: number) =>
      clamp(Math.floor(((lon + 180) / 360) * n), 0, n - 1),
    y = (lat: number) =>
      clamp(
        Math.floor(
          ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n,
        ),
        0,
        n - 1,
      );
  const x0 = x(bounds.west),
    x1 = x(bounds.east),
    y0 = y(bounds.north),
    y1 = y(bounds.south);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 16)
    throw new FeedError(
      'This view spans too many address tiles. Zoom closer.',
      400,
    );
  const tiles = [];
  for (let tx = x0; tx <= x1; tx++)
    for (let ty = y0; ty <= y1; ty++) tiles.push({ z, x: tx, y: ty });
  return tiles;
}
export function normalizeAddress(
  properties: Record<string, unknown>,
  lat: number,
  lon: number,
): AddressPoint | null {
  const text = (v: unknown) =>
    typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 85 ||
    Math.abs(lon) > 180
  )
    return null;
  const id = text(properties.id);
  if (!id) return null;
  const number = text(properties.number),
    street = text(properties.street);
  if (!number && !street) return null;
  let levels = '';
  try {
    const list =
      typeof properties.address_levels === 'string'
        ? JSON.parse(properties.address_levels)
        : properties.address_levels;
    if (Array.isArray(list))
      levels = list
        .map((l) => text(l?.value))
        .filter(Boolean)
        .join(', ');
  } catch {}
  let sources: AddressPoint['sources'] = [];
  try {
    const parsed =
      typeof properties.sources === 'string'
        ? JSON.parse(properties.sources)
        : properties.sources;
    if (Array.isArray(parsed))
      sources = parsed
        .filter((s) => s && typeof s.dataset === 'string')
        .map((s) => ({
          dataset: s.dataset,
          license: typeof s.license === 'string' ? s.license : undefined,
          record_id: typeof s.record_id === 'string' ? s.record_id : undefined,
        }));
  } catch {}
  const address: AddressPoint = {
    id,
    lat,
    lon,
    number,
    street,
    unit: text(properties.unit),
    postcode: text(properties.postcode),
    city: text(properties.postal_city) || levels,
    country: text(properties.country),
    sources,
    source: 'Overture Maps',
    label: '',
  };
  address.label = addressLabel(address);
  return address;
}
export async function addresses(bounds: Bounds): Promise<AddressSnapshot> {
  const tiles = addressTilesForBounds(bounds),
    key = Object.values(bounds)
      .map((v) => v.toFixed(6))
      .join(',');
  return cached(
    `addresses-v2-${ADDRESS_RELEASE}-${key}`,
    (value) => (value.warnings.length ? 20 : 86400),
    async () => {
      const deadline = AbortSignal.timeout(45000),
        seen = new Set<string>();
      const items = new Map<string, AddressPoint>(),
        warnings: string[] = [];
      let totalInView = 0;
      for (let i = 0; i < tiles.length; i += 3) {
        const part = await Promise.allSettled(
          tiles.slice(i, i + 3).map(async ({ z, x, y }) => {
            const data = await archive.getZxy(z, x, y, deadline);
            if (!data) return [];
            const tile = new VectorTile(
                new PbfReader(new Uint8Array(data.data)),
              ),
              layer = tile.layers.address;
            if (!layer) return [];
            const points = [];
            for (let j = 0; j < layer.length; j++) {
              const f = layer.feature(j);
              if (f.type !== 1) continue;
              const geo = f.toGeoJSON(x, y, z);
              if (geo.geometry.type !== 'Point') continue;
              const [lon, lat] = geo.geometry.coordinates;
              if (!isInBounds(lat, lon, bounds)) continue;
              const a = normalizeAddress(f.properties, lat, lon);
              if (a) points.push(a);
            }
            return points;
          }),
        );
        for (const result of part) {
          if (result.status === 'rejected') {
            warnings.push(
              'An address tile failed to load; coverage is incomplete.',
            );
            continue;
          }
          for (const a of result.value) {
            if (seen.has(a.id)) continue;
            seen.add(a.id);
            totalInView++;
            if (items.size < 4000) items.set(a.id, a);
          }
        }
      }
      if (warnings.length === tiles.length)
        throw new FeedError(
          'The address tile source is currently unavailable. Try again shortly.',
        );
      return {
        items: [...items.values()],
        bounds,
        fetchedAt: Date.now(),
        release: ADDRESS_RELEASE,
        truncated: totalInView > 4000,
        totalInView,
        tiles: tiles.length,
        warnings: [...new Set(warnings)],
        source: 'Overture Maps Foundation / contributing address sources',
        sourceUrl: 'https://docs.overturemaps.org/guides/addresses/',
      };
    },
  );
}
