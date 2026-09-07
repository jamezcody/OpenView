export type CoverageLayer = {
  id: string;
  provider: { id: string; name: string };
  technology: 'LTE' | '5G';
  downloadMbps: number;
  uploadMbps: number;
  environment: 'outdoor-stationary';
  reportingDate: string;
  acquiredAt: string;
  processedAt: string;
  sourceUrl: string;
  attribution: string;
  ready: true;
  jurisdictions: {
    id: string;
    name: string;
    status: 'ready' | 'excluded' | 'failed';
    reason?: string;
  }[];
  regions: { id: string; rectangle: [number, number, number, number] }[];
  tiles: {
    scheme: 'xyz-web-mercator';
    tileSize: 256;
    minZoom: number;
    maxZoom: number;
  };
  limits: string[];
};
export type CoverageManifest = {
  schemaVersion: 1;
  release: string;
  publishedAt: string;
  layers: CoverageLayer[];
};
export type CoverageIndex = {
  schemaVersion: 1;
  release: string;
  layerId: string;
  minZoom: number;
  maxZoom: number;
  tileSize: 256;
  present: Record<
    string,
    {
      sha256: string;
      bytes: number;
      scope: 'complete' | 'partial';
      coverage: 'present' | 'none';
    }
  >;
  knownEmpty: Record<string, [number, number][]>;
};
export type CoverageSelection = {
  release: string;
  layer: CoverageLayer;
  index: CoverageIndex;
};
export const coverageId = (s: unknown): s is string =>
  typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(s);
const check: (v: unknown, message: string) => asserts v = (v, message) => {
  if (!v) throw new Error(message);
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const timestamp = (v: unknown) =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T/.test(v) &&
  /(Z|[+-]\d{2}:\d{2})$/.test(v) &&
  Number.isFinite(Date.parse(v));
export function coverageManifest(raw: unknown): CoverageManifest {
  check(
    object(raw) && raw.schemaVersion === 1 && coverageId(raw.release),
    'Invalid coverage release.',
  );
  check(
    Array.isArray(raw.layers) &&
      raw.layers.length > 0 &&
      raw.layers.length <= 512,
    'No published coverage layers.',
  );
  check(timestamp(raw.publishedAt), 'Invalid coverage publication date.');
  const ids = new Set<string>();
  for (const item of raw.layers) {
    check(
      object(item) && coverageId(item.id) && !ids.has(item.id),
      'Invalid coverage layer identity.',
    );
    ids.add(item.id);
    check(
      item.ready === true &&
        object(item.provider) &&
        /^\d{6}$/.test(String(item.provider.id)) &&
        typeof item.provider.name === 'string',
      'Coverage source is not ready.',
    );
    check(
      item.environment === 'outdoor-stationary' &&
        ((item.technology === 'LTE' &&
          item.downloadMbps === 5 &&
          item.uploadMbps === 1) ||
          (item.technology === '5G' &&
            ((item.downloadMbps === 7 && item.uploadMbps === 1) ||
              (item.downloadMbps === 35 && item.uploadMbps === 3)))),
      'Inconsistent coverage criterion.',
    );
    check(
      typeof item.reportingDate === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(item.reportingDate) &&
        Number.isFinite(Date.parse(item.reportingDate)),
      'Missing reporting date.',
    );
    check(
      new Date(item.reportingDate).toISOString().slice(0, 10) ===
        item.reportingDate &&
        timestamp(item.acquiredAt) &&
        timestamp(item.processedAt),
      'Invalid coverage source dates.',
    );
    check(
      typeof item.sourceUrl === 'string' &&
        item.sourceUrl.startsWith('https://') &&
        typeof item.attribution === 'string',
      'Missing coverage provenance.',
    );
    check(
      Array.isArray(item.jurisdictions) &&
        item.jurisdictions.some(
          (j: unknown) => object(j) && j.status === 'ready',
        ),
      'No imported jurisdiction.',
    );
    for (const j of item.jurisdictions)
      check(
        object(j) &&
          typeof j.id === 'string' &&
          typeof j.name === 'string' &&
          ['ready', 'failed', 'excluded'].includes(String(j.status)) &&
          (j.status === 'ready' || typeof j.reason === 'string'),
        'Invalid jurisdiction status.',
      );
    check(
      Array.isArray(item.regions) &&
        item.regions.length > 0 &&
        item.regions.length <= 256,
      'Invalid coverage regions.',
    );
    for (const r of item.regions) {
      check(
        object(r) &&
          Array.isArray(r.rectangle) &&
          r.rectangle.length === 4 &&
          r.rectangle.every(Number.isFinite),
        'Invalid coverage bounds.',
      );
      const [w, s, e, n] = r.rectangle as number[];
      check(
        w >= -180 &&
          e <= 180 &&
          w < e &&
          s >= -85.051129 &&
          n <= 85.051129 &&
          s < n,
        'Coverage bounds exceed projection.',
      );
    }
    check(
      object(item.tiles) &&
        item.tiles.scheme === 'xyz-web-mercator' &&
        item.tiles.tileSize === 256 &&
        Number.isInteger(item.tiles.minZoom) &&
        Number.isInteger(item.tiles.maxZoom),
      'Invalid tile scheme.',
    );
    check(
      Number(item.tiles.minZoom) >= 0 &&
        Number(item.tiles.maxZoom) <= 16 &&
        Number(item.tiles.minZoom) <= Number(item.tiles.maxZoom),
      'Invalid native zoom range.',
    );
    check(
      Array.isArray(item.limits) &&
        item.limits.every((v: unknown) => typeof v === 'string'),
      'Missing interpretation limits.',
    );
  }
  return raw as CoverageManifest;
}
export function coverageTileKey(z: number, x: number, y: number) {
  check(
    [z, x, y].every(Number.isInteger) &&
      z >= 0 &&
      z <= 16 &&
      x >= 0 &&
      y >= 0 &&
      x < 2 ** z &&
      y < 2 ** z,
    'Invalid coverage tile coordinates.',
  );
  return `${z}/${x}/${y}`;
}
export function coverageIndex(
  raw: unknown,
  release: string,
  layer: CoverageLayer,
): CoverageIndex {
  check(
    object(raw) &&
      raw.schemaVersion === 1 &&
      raw.release === release &&
      raw.layerId === layer.id &&
      raw.minZoom === layer.tiles.minZoom &&
      raw.maxZoom === layer.tiles.maxZoom &&
      raw.tileSize === 256,
    'Coverage index does not match the selection.',
  );
  check(
    object(raw.present) &&
      object(raw.knownEmpty) &&
      Object.keys(raw.present).length <= 200000,
    'Invalid coverage index.',
  );
  for (const [key, v] of Object.entries(raw.present)) {
    check(
      /^\d+\/\d+\/\d+$/.test(key) && object(v),
      'Invalid coverage tile descriptor.',
    );
    const [z, x, y] = key.split('/').map(Number);
    coverageTileKey(z, x, y);
    check(
      z >= layer.tiles.minZoom &&
        z <= layer.tiles.maxZoom &&
        typeof v.sha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(v.sha256) &&
        Number.isInteger(v.bytes) &&
        Number(v.bytes) > 0 &&
        Number(v.bytes) <= 512 * 1024 &&
        ['complete', 'partial'].includes(String(v.scope)) &&
        ['present', 'none'].includes(String(v.coverage)),
      'Invalid coverage tile descriptor.',
    );
  }
  for (const [key, ranges] of Object.entries(raw.knownEmpty)) {
    check(
      /^\d+\/\d+$/.test(key) && Array.isArray(ranges),
      'Invalid empty-tile index.',
    );
    const [z, y] = key.split('/').map(Number);
    let end = -1;
    for (const range of ranges) {
      check(
        Array.isArray(range) && range.length === 2,
        'Invalid empty-tile interval.',
      );
      coverageTileKey(z, range[0], y);
      coverageTileKey(z, range[1], y);
      check(
        z >= layer.tiles.minZoom &&
          z <= layer.tiles.maxZoom &&
          range[0] > end &&
          range[1] >= range[0],
        'Overlapping empty-tile interval.',
      );
      end = range[1];
    }
  }
  return raw as CoverageIndex;
}
export function coverageTileStatus(
  index: CoverageIndex,
  z: number,
  x: number,
  y: number,
) {
  const key = coverageTileKey(z, x, y);
  if (index.present[key]) return 'present';
  if (index.knownEmpty[`${z}/${y}`]?.some(([a, b]) => a <= x && x <= b))
    return 'known-empty';
  return 'unknown';
}
export async function boundedCoverageBytes(
  url: string,
  signal: AbortSignal,
  max: number,
) {
  const response = await fetch(url, { signal });
  if (!response.ok)
    throw new Error(`Coverage data returned HTTP ${response.status}.`);
  if (Number(response.headers.get('content-length')) > max || !response.body)
    throw new Error('Coverage response exceeds its size limit.');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.length;
      if (size > max)
        throw new Error('Coverage response exceeds its size limit.');
      chunks.push(r.value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
