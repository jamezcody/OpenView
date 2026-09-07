type ParcelQuery = {
  objectIds?: Array<number | string> | null;
  features?: {
    attributes?: Record<string, unknown>;
    geometry?: { rings?: number[][][] };
  }[];
  exceededTransferLimit?: boolean;
  error?: { message?: string };
};
import { boundedJson } from './bounded-fetch';
import { cached, FeedError, cleanOwner } from './feeds';
import {
  adaptersForBounds,
  validateBounds,
  type ParcelAdapter,
  type LandParcelSnapshot,
  type LandParcelFeature,
  type PropertyEvidence,
  type SourceStatus,
} from './land-model';
import type { Bounds } from './model';
import { ringsToGeometry } from './parcel-geometry';
export const MAX_PARCELS = 2000;
export function valueText(value: unknown) {
  return typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
    ? String(value).trim()
    : '';
}
export function firstField(raw: Record<string, unknown>, keys: string[] = []) {
  return keys.map((k) => valueText(raw[k])).find(Boolean) || '';
}
export function situsAddress(raw: Record<string, unknown>, a: ParcelAdapter) {
  const fields = a.fields.address ?? [];
  if (a.id === 'tx-harris' || a.id === 'tx-dallas')
    return fields
      .map((f) => valueText(raw[f]))
      .filter(Boolean)
      .join(' ');
  if (a.id === 'ct')
    return [
      firstField(raw, ['Location_1', 'Location']),
      firstField(raw, ['Property_City']),
      firstField(raw, ['Property_Zip']),
    ]
      .filter(Boolean)
      .join(', ');
  if (a.id === 'wi')
    return [
      firstField(raw, ['SITEADRESS_STAND', 'SITEADRESS']),
      firstField(raw, ['PLACENAME']),
      firstField(raw, ['ZIPCODE']),
    ]
      .filter(Boolean)
      .join(', ');
  if (a.id === 'vt')
    return [
      firstField(raw, ['E911ADDR', 'LOCAPROP']),
      firstField(raw, ['TNAME']),
    ]
      .filter(Boolean)
      .join(', ');
  return fields
    .map((f) => valueText(raw[f]))
    .filter(Boolean)
    .join(', ');
}
export function ownerSuppressed(
  raw: Record<string, unknown>,
  a: ParcelAdapter,
) {
  const rule = a.suppressOwnerWhen;
  if (!rule) return false;
  if (rule.fields && rule.placeholderValues) {
    const placeholders = rule.placeholderValues.map((v) => v.toUpperCase());
    if (
      rule.fields.some((key) =>
        placeholders.includes(valueText(raw[key]).toUpperCase()),
      )
    )
      return true;
  }
  if (!rule.field) return false;
  const value = valueText(raw[rule.field]).toUpperCase();
  if (!value) return false;
  if (rule.trueValues?.map((v) => v.toUpperCase()).includes(value)) return true;
  return (
    !!rule.alsoSuppressUnknownNonemptyValues &&
    !rule.falseValues?.map((v) => v.toUpperCase()).includes(value)
  );
}
export async function parcelRequest(
  a: ParcelAdapter,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<ParcelQuery> {
  let last: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) throw new Error('Lookup cancelled.');
    try {
      const response = await fetch(
        `${a.url}/query?${new URLSearchParams({ f: 'json', ...params })}`,
        {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'OpenView/2.0',
            'Accept-Encoding': 'gzip',
          },
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(18000)])
            : AbortSignal.timeout(18000),
        },
      );
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new FeedError(
          'This source requires access that is not available.',
          403,
          300,
        );
      }
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        await response.body?.cancel();
        throw new FeedError(
          'This source is rate limited. Try again later.',
          429,
          Math.max(60, Number(retryAfter) || 60),
        );
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (attempt === 0 && response.status >= 500) {
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        throw new FeedError(`Source returned HTTP ${response.status}.`);
      }
      const result = await boundedJson<ParcelQuery>(response);
      if (result.error)
        throw new FeedError(
          `Parcel source: ${String(result.error.message ?? 'query failed')}`,
        );
      return result;
    } catch (e) {
      last = e instanceof Error ? e : new Error('Parcel source unavailable.');
      if (signal?.aborted || e instanceof FeedError) throw last;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw last || new Error('Parcel source unavailable.');
}
export function spatialParams(b: Bounds) {
  return {
    where: '1=1',
    geometry: [b.west, b.south, b.east, b.north].join(','),
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
  };
}
export async function sourceBoundaries(a: ParcelAdapter, b: Bounds) {
  return cached(
    `us-boundaries-v3-${a.id}-${Object.values(b)
      .map((n) => n.toFixed(5))
      .join(',')}`,
    3600,
    async () => {
      const deadline = AbortSignal.timeout(45000);
      const spatial = spatialParams(b),
        idResult = await parcelRequest(
          a,
          { ...spatial, returnIdsOnly: 'true', returnGeometry: 'false' },
          deadline,
        );
      if (idResult.objectIds === null) idResult.objectIds = [];
      if (!Array.isArray(idResult.objectIds))
        throw new FeedError('Source did not return a parcel ID list.');
      const ids = [
        ...new Set<string>(
          idResult.objectIds
            .map(String)
            .filter((id: string) => /^\d+$/.test(id)),
        ),
      ].sort((x, y) => Number(x) - Number(y));
      const selected = ids.slice(0, MAX_PARCELS),
        features: LandParcelFeature[] = [];
      const batch = Math.min(400, a.maxRecordCount || 200);
      for (let offset = 0; offset < selected.length; offset += batch) {
        const page = await parcelRequest(
          a,
          {
            objectIds: selected.slice(offset, offset + batch).join(','),
            outFields: a.boundaryOutFields,
            returnGeometry: 'true',
            outSR: '4326',
            geometryPrecision: '7',
          },
          deadline,
        );
        if (!Array.isArray(page.features))
          throw new FeedError('Source did not return parcel shapes.');
        for (const f of page.features) {
          if (!Array.isArray(f.geometry?.rings)) continue;
          const geometry = ringsToGeometry(f.geometry.rings);
          if (!geometry) continue;
          const raw = f.attributes ?? {},
            objectId = valueText(raw[a.objectIdField]);
          if (!objectId) continue;
          features.push({
            type: 'Feature',
            id: `${a.id}:${objectId}`,
            geometry,
            properties: {
              id: firstField(raw, a.fields.parcel),
              owner: 'Not requested',
              address: situsAddress(raw, a),
              locality: '',
              sourceDate: a.dataLastEdited,
              source: a.name,
              sourceUrl: a.sourceUrl,
              sourceId: a.id,
              objectId,
            },
          });
        }
      }
      return {
        features,
        truncated:
          ids.length > selected.length || features.length < selected.length,
        total: ids.length,
        fetchedAt: Date.now(),
      };
    },
  );
}
export async function usBoundaries(b: Bounds): Promise<LandParcelSnapshot> {
  validateBounds(b, 0.08);
  const sources = adaptersForBounds(b);
  const features: LandParcelFeature[] = [],
    statuses: SourceStatus[] = [];
  if (!sources.length)
    statuses.push({
      id: 'coverage',
      name: 'U.S. parcel coverage',
      status: 'unsupported',
      count: 0,
      url: 'https://www.nconemap.gov/pages/parcels',
      message:
        'No connected public parcel service covers this view. This does not mean parcels do not exist. Choose an area from the coverage list.',
    });
  for (let i = 0; i < sources.length; i += 3) {
    const results = await Promise.allSettled(
      sources.slice(i, i + 3).map(async (a) => {
        const clipped = {
          west: Math.max(b.west, a.bounds[0]),
          south: Math.max(b.south, a.bounds[1]),
          east: Math.min(b.east, a.bounds[2]),
          north: Math.min(b.north, a.bounds[3]),
        };
        return { a, result: await sourceBoundaries(a, clipped) };
      }),
    );
    results.forEach((r, index) => {
      const a = sources[i + index];
      if (r.status === 'rejected') {
        statuses.push({
          id: a.id,
          name: a.name,
          status: 'failed',
          count: 0,
          url: a.sourceUrl,
          message:
            r.reason instanceof Error ? r.reason.message : 'Source unavailable',
        });
        return;
      }
      features.push(...r.value.result.features);
      statuses.push({
        id: a.id,
        name: a.name,
        status: r.value.result.features.length ? 'success' : 'empty',
        count: r.value.result.features.length,
        url: a.sourceUrl,
        truncated: r.value.result.truncated,
        message: a.coverage,
      });
    });
  }
  return {
    data: { type: 'FeatureCollection', features },
    featureCount: features.length,
    fetchedAt: Date.now(),
    bounds: b,
    source: 'Public U.S. parcel sources',
    sourceUrl: 'https://www.nconemap.gov/pages/parcels',
    truncated: statuses.some((s) => s.truncated || s.status === 'failed'),
    sources: statuses,
  };
}
export function normalizeEvidence(
  raw: Record<string, unknown>,
  a: ParcelAdapter,
  lat: number,
  lon: number,
): PropertyEvidence {
  const suppressed = ownerSuppressed(raw, a),
    owners = suppressed
      ? []
      : [
          ...new Set(
            (a.fields.owner ?? [])
              .map((f) => cleanOwner(raw[f]))
              .filter(
                (o) =>
                  o !== 'Owner unavailable' &&
                  !/^(withheld|redacted|confidential|exempt)$/i.test(o),
              ),
          ),
        ];
  const notes = [
    a.notes || '',
    suppressed
      ? 'Owner details withheld by the source privacy flag or placeholder.'
      : '',
    a.ownerRole === 'taxpayer'
      ? 'Taxpayer names do not establish ownership.'
      : '',
    !owners.length ? 'No publishable owner names returned by this source.' : '',
  ].filter(Boolean);
  const facts: PropertyEvidence['facts'] = [];
  for (const key of new Set([
    ...(a.fields.parcel ?? []),
    ...(a.fields.address ?? []),
    ...(a.fields.dates ?? []),
    ...(a.fields.value ?? []),
    ...(a.fields.area ?? []),
  ])) {
    const value = raw[key];
    if (value === null || value === undefined || value === '') continue;
    let rendered = valueText(value);
    if (
      a.fieldTypes[key] === 'esriFieldTypeDate' &&
      typeof value === 'number' &&
      Number.isFinite(value)
    )
      rendered = new Date(value).toISOString();
    facts.push({ field: key, label: key.replace(/_/g, ' '), value: rendered });
  }
  const recordLinks = suppressed
    ? []
    : (a.fields.record ?? [])
        .map((f) => valueText(raw[f]))
        .filter((v) => /^https:\/\//i.test(v))
        .slice(0, 3);
  const pointQuery = new URLSearchParams({
    f: 'json',
    geometry: `${lon},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    outFields: suppressed ? a.boundaryOutFields : a.ownerDataOutFields,
    returnGeometry: 'false',
  });
  return {
    sourceId: a.id,
    source: a.name,
    sourceUrl: `${a.url}/query?${pointQuery}`,
    retrievedAt: Date.now(),
    match: 'point intersects parcel',
    parcelId: firstField(raw, a.fields.parcel),
    address: situsAddress(raw, a),
    ownerNames: owners,
    ownerRole: a.ownerRole || 'assessment owner',
    sourceDate: a.dataLastEdited,
    facts,
    recordLinks,
    notes,
  };
}
