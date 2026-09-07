export type ParkKind = 'national' | 'state';
export type ParkRecord = {
  id: string;
  name: string;
  designation: string;
  states: string[];
  sourceIds: string[];
  category: string;
  source: string;
  sourceUrl: string;
  sourceDate?: string;
  boundaryMeaning?: string;
  sourceCategories?: string[];
  sourceDetails?: Record<string, unknown>;
};
export type ParkLayer = {
  id: ParkKind;
  file: string;
  bytes: number;
  sha256: string;
  chunkSize: 65536;
  chunks: string[];
  minZoom: number;
  maxZoom: number;
  records: { file: string; bytes: number; sha256: string };
  source: {
    name: string;
    url: string;
    release: string;
    retrievedAt: string;
    attribution: string;
    filter: string;
    limitations: string[];
  };
  recordCount: number;
};
export type ParkManifest = {
  schemaVersion: 1;
  release: string;
  createdAt: string;
  layers: ParkLayer[];
};
export const PARK_LABELS: Record<ParkKind, string> = {
  national: 'National parks',
  state: 'State parks',
};
export const PARK_COLORS: Record<ParkKind, string> = {
  national: '#f0ad72',
  state: '#bdb1ff',
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const check: (v: unknown, message: string) => asserts v = (v, message) => {
  if (!v) throw new Error(message);
};
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const label = (v: unknown) =>
  typeof v === 'string' && v.length > 0 && v.length <= 2000;
export const parkSourceUrl = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password
      ? u.href
      : undefined;
  } catch {
    return;
  }
};
export function parseParkManifest(raw: unknown): ParkManifest {
  check(
    object(raw) &&
      raw.schemaVersion === 1 &&
      typeof raw.release === 'string' &&
      /^[a-zA-Z0-9_-]{1,96}$/.test(raw.release),
    'Invalid park release.',
  );
  check(
    typeof raw.createdAt === 'string' &&
      Number.isFinite(Date.parse(raw.createdAt)),
    'Invalid park preparation date.',
  );
  check(
    Array.isArray(raw.layers) && raw.layers.length === 2,
    'Both park layers must be present.',
  );
  const seen = new Set();
  for (const l of raw.layers) {
    check(
      object(l) && (l.id === 'national' || l.id === 'state') && !seen.has(l.id),
      'Invalid park layer.',
    );
    seen.add(l.id);
    check(
      l.file === `${l.id}.pmtiles` &&
        hash(l.sha256) &&
        Number.isInteger(l.bytes) &&
        Number(l.bytes) > 127 &&
        Number(l.bytes) <= 512 * 1024 * 1024,
      'Invalid park archive.',
    );
    check(
      l.chunkSize === 65536 &&
        Array.isArray(l.chunks) &&
        l.chunks.length === Math.ceil(Number(l.bytes) / 65536) &&
        l.chunks.every(hash),
      'Invalid park integrity index.',
    );
    check(
      l.minZoom === 0 &&
        Number.isInteger(l.maxZoom) &&
        Number(l.maxZoom) >= 1 &&
        Number(l.maxZoom) <= 14,
      'Invalid park zoom range.',
    );
    check(
      object(l.records) &&
        l.records.file === `${l.id}-records.json` &&
        Number.isInteger(l.records.bytes) &&
        Number(l.records.bytes) > 0 &&
        Number(l.records.bytes) <= 8 * 1024 * 1024 &&
        hash(l.records.sha256),
      'Invalid park record index.',
    );
    check(
      Number.isInteger(l.recordCount) &&
        Number(l.recordCount) > 0 &&
        Number(l.recordCount) <= 30000,
      'Invalid park record count.',
    );
    check(
      object(l.source) &&
        label(l.source.name) &&
        parkSourceUrl(l.source.url) &&
        label(l.source.release) &&
        label(l.source.retrievedAt) &&
        label(l.source.attribution) &&
        label(l.source.filter) &&
        Array.isArray(l.source.limitations) &&
        l.source.limitations.every(label),
      'Park source metadata is incomplete.',
    );
  }
  return raw as ParkManifest;
}
export function parseParkRecords(raw: unknown, layer: ParkLayer) {
  check(
    object(raw) &&
      raw.schemaVersion === 1 &&
      Array.isArray(raw.records) &&
      raw.records.length === layer.recordCount,
    'Park records do not match the release.',
  );
  const records = new Map<string, ParkRecord>();
  for (const r of raw.records) {
    check(
      object(r) &&
        typeof r.id === 'string' &&
        /^[A-Za-z0-9_.:-]{1,160}$/.test(r.id) &&
        !records.has(r.id),
      'Invalid or duplicate park identity.',
    );
    check(
      label(r.name) &&
        label(r.designation) &&
        label(r.category) &&
        label(r.source) &&
        parkSourceUrl(r.sourceUrl),
      'Missing park details.',
    );
    check(
      Array.isArray(r.states) &&
        r.states.length <= 60 &&
        r.states.every((v) => typeof v === 'string' && v.length <= 80),
      'Invalid park state information.',
    );
    check(
      Array.isArray(r.sourceIds) &&
        r.sourceIds.length > 0 &&
        r.sourceIds.every((v) => typeof v === 'string' && v.length <= 200),
      'Missing original park identifiers.',
    );
    check(
      r.boundaryMeaning === undefined || label(r.boundaryMeaning),
      'Invalid boundary description.',
    );
    records.set(r.id, r as ParkRecord);
  }
  return records;
}
export function parkTileAddress(
  z: number,
  x: number,
  y: number,
  maxZoom: number,
) {
  check(
    [z, x, y, maxZoom].every(Number.isInteger) &&
      z >= 0 &&
      z <= 20 &&
      maxZoom >= 0 &&
      maxZoom <= 14 &&
      x >= 0 &&
      y >= 0 &&
      x < 2 ** z &&
      y < 2 ** z,
    'Invalid park tile coordinate.',
  );
  const level = Math.min(z, maxZoom),
    scale = 2 ** (z - level);
  return {
    z: level,
    x: Math.floor(x / scale),
    y: Math.floor(y / scale),
    scale,
    dx: x % scale,
    dy: y % scale,
  };
}
export function parkPointTile(lon: number, lat: number, z: number) {
  check(
    Number.isFinite(lon) &&
      Number.isFinite(lat) &&
      Math.abs(lon) <= 180 &&
      Math.abs(lat) <= 85.05112878 &&
      Number.isInteger(z) &&
      z >= 0 &&
      z <= 14,
    'Location is outside the park tile projection.',
  );
  const n = 2 ** z,
    gx = (((lon === 180 ? -180 : lon) + 180) / 360) * n,
    gy = Math.min(
      n - 1e-10,
      Math.max(
        0,
        ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n,
      ),
    );
  return {
    x: Math.floor(gx),
    y: Math.floor(gy),
    u: gx - Math.floor(gx),
    v: gy - Math.floor(gy),
  };
}
export type ParkPoint = { x: number; y: number };
/** Even/odd ring containment; ring edges (including holes) count as boundaries. */
export function parkContains(rings: ParkPoint[][], x: number, y: number) {
  let inside = false;
  for (const ring of rings)
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j],
        b = ring[i],
        dx = b.x - a.x,
        dy = b.y - a.y;
      if (
        Math.abs(dx * (y - a.y) - dy * (x - a.x)) <= 1e-7 &&
        x >= Math.min(a.x, b.x) - 1e-9 &&
        x <= Math.max(a.x, b.x) + 1e-9 &&
        y >= Math.min(a.y, b.y) - 1e-9 &&
        y <= Math.max(a.y, b.y) + 1e-9
      )
        return true;
      if (
        a.y > y !== b.y > y &&
        x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x
      )
        inside = !inside;
    }
  return inside;
}
export function parkMayPick(existingKind: unknown) {
  return ![
    'satellite',
    'aircraft',
    'ships',
    'parcel',
    'address',
    'radio',
    'cells',
    'camping',
    'search',
  ].includes(String(existingKind));
}
