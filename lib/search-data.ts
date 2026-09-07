import { readBounded } from './bounded-fetch';
import { indexSearch, type SearchResult } from './search-model';
type SearchFile = {
  kind: 'radio' | 'parks';
  file: string;
  bytes: number;
  sha256: string;
  count: number;
};
export type SearchManifest = {
  schemaVersion: 1;
  version: string;
  radioVersion: string;
  parkRelease: string;
  files: SearchFile[];
};
const safeId = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
export function parseSearchManifest(raw: unknown): SearchManifest {
  const m = raw as SearchManifest;
  if (
    !m ||
    m.schemaVersion !== 1 ||
    !safeId(m.version) ||
    !safeId(m.radioVersion) ||
    !safeId(m.parkRelease) ||
    !Array.isArray(m.files) ||
    m.files.length !== 2
  )
    throw new Error('Invalid search catalog.');
  if (new Set(m.files.map((f) => f.kind)).size !== 2)
    throw new Error('Duplicate search files.');
  for (const f of m.files)
    if (
      !['radio', 'parks'].includes(f.kind) ||
      f.file !== `${f.kind}.json` ||
      !Number.isInteger(f.bytes) ||
      f.bytes < 2 ||
      f.bytes > 12 * 1024 * 1024 ||
      !Number.isInteger(f.count) ||
      f.count < 1 ||
      f.count > 100000 ||
      !/^[a-f0-9]{64}$/.test(f.sha256)
    )
      throw new Error('Invalid search file descriptor.');
  return m;
}
export async function searchJson(
  url: string,
  signal: AbortSignal,
  max: number,
  hash?: string,
) {
  const r = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
  });
  if (!r.ok) {
    const bytes = await readBounded(r, 65536);
    let message = '';
    try {
      const data = JSON.parse(new TextDecoder().decode(bytes));
      if (typeof data.error === 'string') message = data.error.slice(0, 500);
    } catch {}
    throw new Error(message || `Search data returned HTTP ${r.status}.`);
  }
  const bytes = await readBounded(r, max);
  if (hash) {
    const digest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>),
      ),
      (v) => v.toString(16).padStart(2, '0'),
    ).join('');
    if (bytes.length !== max || digest !== hash)
      throw new Error('Search data checksum mismatch.');
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export function parseSearchItems(
  raw: unknown,
  kind: 'radio' | 'parks',
  count: number,
  release: string,
): SearchResult[] {
  const doc = raw as {
    schemaVersion: number;
    encoding?: string;
    items: unknown[];
    sources?: { name: string; url: string }[];
    details?: string[];
  };
  if (
    !doc ||
    doc.schemaVersion !== 1 ||
    !Array.isArray(doc.items) ||
    doc.items.length !== count
  )
    throw new Error('Invalid search index.');
  let items: SearchResult[];
  if (kind === 'radio') {
    if (
      doc.encoding !== 'radio-tuples-v1' ||
      !Array.isArray(doc.sources) ||
      !Array.isArray(doc.details)
    )
      throw new Error('Invalid radio search schema.');
    const categories = ['transmitters', 'receivers', 'candidates'] as const,
      kinds = ['transmitter', 'receiver', 'radio-candidate'] as const;
    items = doc.items.map((value) => {
      const row = value as [
        string,
        string,
        number,
        string,
        number,
        string,
        number,
        number,
        number,
      ];
      if (
        !Array.isArray(row) ||
        row.length !== 9 ||
        typeof row[0] !== 'string' ||
        typeof row[1] !== 'string' ||
        !Number.isInteger(row[2]) ||
        row[2] < 0 ||
        row[2] > 2 ||
        !Number.isInteger(row[4]) ||
        !Number.isInteger(row[8])
      )
        throw new Error('Invalid radio search row.');
      const source = doc.sources![row[8]],
        detail = doc.details![row[4]];
      if (!source || typeof detail !== 'string')
        throw new Error('Invalid search source.');
      return {
        id: `radio:${row[0]}`,
        kind: kinds[row[2]],
        name: row[3],
        detail,
        terms: row[5],
        lat: row[6],
        lon: row[7],
        height: 2500,
        source: source.name,
        sourceUrl: source.url,
        target: {
          type: 'radio',
          recordId: row[0],
          node: row[1],
          category: categories[row[2]],
        },
        release,
      };
    });
  } else items = doc.items.map((r) => ({ ...(r as SearchResult), release }));
  const ids = new Set<string>();
  for (const item of items) {
    if (
      !item ||
      typeof item.id !== 'string' ||
      ids.has(item.id) ||
      !['name', 'detail', 'terms', 'source', 'sourceUrl'].every(
        (k) => typeof item[k as keyof SearchResult] === 'string',
      ) ||
      !item.name ||
      !Number.isFinite(item.lat) ||
      !Number.isFinite(item.lon) ||
      item.lat === null ||
      item.lon === null ||
      Math.abs(item.lat) > 90 ||
      Math.abs(item.lon) > 180 ||
      !Number.isFinite(item.height) ||
      item.height < 120 ||
      item.height > 70000000
    )
      throw new Error('Invalid search record.');
    if (
      kind === 'parks' &&
      (!['national-park', 'state-park'].includes(item.kind) ||
        item.target?.type !== 'park' ||
        !['national', 'state'].includes(item.target.kind) ||
        typeof item.target.parkId !== 'string')
    )
      throw new Error('Invalid park search target.');
    ids.add(item.id);
  }
  return items as (SearchResult & { lat: number; lon: number })[];
}
export async function loadSearchFile(
  m: SearchManifest,
  f: SearchFile,
  signal: AbortSignal,
) {
  const raw = await searchJson(
    `/search/${m.version}/${f.file}`,
    signal,
    f.bytes,
    f.sha256,
  );
  signal.throwIfAborted();
  return indexSearch(
    parseSearchItems(
      raw,
      f.kind,
      f.count,
      f.kind === 'radio' ? m.radioVersion : m.parkRelease,
    ),
  );
}
