import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseParkManifest,
  parseParkRecords,
  parkContains,
  parkMayPick,
  parkPointTile,
  parkTileAddress,
  type ParkLayer,
} from '../lib/park-model';
import { ParkArchive, parkHash } from '../lib/park-data';

const hash = 'a'.repeat(64);
const layer = (id: 'national' | 'state'): ParkLayer => ({
  id,
  file: `${id}.pmtiles`,
  bytes: 100000,
  sha256: hash,
  chunkSize: 65536,
  chunks: [hash, hash],
  minZoom: 0,
  maxZoom: 10,
  records: { file: `${id}-records.json`, bytes: 100, sha256: hash },
  source: {
    name: 'Test source',
    url: 'https://www.nps.gov/',
    release: 'Test fixture',
    retrievedAt: '2026-09-06',
    attribution: 'Test attribution',
    filter: 'Test only',
    limitations: ['Not real park data'],
  },
  recordCount: 1,
});
void test('park manifests require both independent layers, bounded versioned archives, and source details', () => {
  const fixture = {
    schemaVersion: 1,
    release: 'parks-test',
    createdAt: '2026-09-06T00:00:00Z',
    layers: [layer('national'), layer('state')],
  };
  assert.equal(parseParkManifest(fixture).layers.length, 2);
  for (const change of [
    () => ({ ...fixture, layers: [layer('national')] }),
    () => ({ ...fixture, release: '../escape' }),
    () => ({
      ...fixture,
      layers: [layer('national'), { ...layer('state'), chunks: [] }],
    }),
    () => ({
      ...fixture,
      layers: [
        layer('national'),
        { ...layer('state'), file: 'https://untrusted.example/data' },
      ],
    }),
  ])
    assert.throws(() => parseParkManifest(change()));
  const record = {
    id: 'test:1',
    name: 'Test park',
    designation: 'State Park',
    states: ['CA', 'NV'],
    sourceIds: ['original1', 'original2'],
    category: 'Fee',
    source: 'Test',
    sourceUrl: 'https://www.usgs.gov/',
  };
  assert.deepEqual(
    parseParkRecords(
      { schemaVersion: 1, records: [record] },
      layer('state'),
    ).get('test:1')?.states,
    ['CA', 'NV'],
  );
  assert.throws(() =>
    parseParkRecords(
      { schemaVersion: 1, records: [{ ...record, sourceIds: [] }] },
      layer('state'),
    ),
  );
});
void test('park picking preserves holes, disjoint shells, and source boundary edges', () => {
  const ring = (a: number, b: number, c: number, d: number) => [
    { x: a, y: b },
    { x: c, y: b },
    { x: c, y: d },
    { x: a, y: d },
  ];
  const rings = [ring(0, 0, 10, 10), ring(3, 3, 7, 7), ring(20, 0, 30, 10)];
  assert.equal(parkContains(rings, 1, 1), true);
  assert.equal(parkContains(rings, 5, 5), false);
  assert.equal(parkContains(rings, 3, 5), true);
  assert.equal(parkContains(rings, 25, 5), true);
  assert.equal(parkContains(rings, 15, 5), false);
  for (const kind of [
    'satellite',
    'aircraft',
    'ships',
    'parcel',
    'address',
    'radio',
  ])
    assert.equal(parkMayPick(kind), false);
  assert.equal(parkMayPick(undefined), true);
});
void test('park overzoom preserves source coordinates and dateline wrap without world-spanning queries', () => {
  assert.deepEqual(parkTileAddress(12, 1234, 2100, 10), {
    z: 10,
    x: 308,
    y: 525,
    scale: 4,
    dx: 2,
    dy: 0,
  });
  assert.equal(parkPointTile(180, 52, 10).x, 0);
  assert.equal(parkPointTile(-179.9, 52, 10).x, 0);
  assert.equal(parkPointTile(179.9, 52, 10).x, 1023);
  assert.throws(() => parkPointTile(181, 0, 10));
  assert.throws(() => parkTileAddress(5, 32, 0, 10));
});
void test('park archive uses verified bounded ranges and coalesces repeated chunks', async () => {
  const bytes = new Uint8Array(100000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const descriptor = {
    ...layer('national'),
    chunks: [
      await parkHash(bytes.subarray(0, 65536)),
      await parkHash(bytes.subarray(65536)),
    ],
  };
  const old = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    const match = new Headers(options?.headers)
      .get('range')!
      .match(/bytes=(\d+)-(\d+)/)!;
    const start = Number(match[1]),
      end = Number(match[2]);
    return new Response(bytes.slice(start, end + 1), {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}` },
    });
  };
  const archive = new ParkArchive(
    '/parks/fixture/national.pmtiles',
    descriptor,
  );
  try {
    const [a, b] = await Promise.all([
      archive.range(65000, 1200),
      archive.range(0, 10),
    ]);
    assert.deepEqual(new Uint8Array(a.data), bytes.subarray(65000, 66200));
    assert.equal(b.data.byteLength, 10);
    assert.equal(calls, 2);
    await archive.range(12, 6);
    assert.equal(calls, 2);
    archive.close();
    await assert.rejects(() => archive.range(0, 10), { name: 'AbortError' });
  } finally {
    archive.close();
    globalThis.fetch = old;
  }
});
void test('park archive verifies and reuses a small whole-file fallback when ranges are unavailable', async () => {
  const bytes = new Uint8Array(100000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const descriptor = {
    ...layer('national'),
    sha256: await parkHash(bytes),
    chunks: [
      await parkHash(bytes.subarray(0, 65536)),
      await parkHash(bytes.subarray(65536)),
    ],
  };
  const old = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(bytes, { status: 200 });
  };
  const archive = new ParkArchive(
    '/parks/fixture/national.pmtiles',
    descriptor,
  );
  try {
    const first = await archive.range(65000, 1200);
    assert.deepEqual(new Uint8Array(first.data), bytes.subarray(65000, 66200));
    const second = await archive.range(12, 6);
    assert.deepEqual(new Uint8Array(second.data), bytes.subarray(12, 18));
    assert.equal(calls, 1);
    assert.equal(archive.metrics.rangeBytes, bytes.length);
  } finally {
    archive.close();
    globalThis.fetch = old;
  }
});
void test('park missing, truncated and corrupt archive responses remain errors', async () => {
  const old = globalThis.fetch;
  try {
    for (const response of [
      () => new Response('not found', { status: 404 }),
      () => new Response(new Uint8Array(100000), { status: 200 }),
      () =>
        new Response(new Uint8Array(100), {
          status: 206,
          headers: { 'content-range': 'bytes 0-65535/100000' },
        }),
      () =>
        new Response(new Uint8Array(65536), {
          status: 206,
          headers: { 'content-range': 'bytes 0-65535/100000' },
        }),
    ]) {
      globalThis.fetch = async () => response();
      const archive = new ParkArchive(
        '/parks/fixture/national.pmtiles',
        layer('national'),
      );
      await assert.rejects(() => archive.range(0, 10));
      archive.close();
    }
  } finally {
    globalThis.fetch = old;
  }
});
void test('park whole-file fallback stays bounded', async () => {
  const old = globalThis.fetch;
  globalThis.fetch = async () => new Response('ignored', { status: 200 });
  const archive = new ParkArchive('/parks/fixture/national.pmtiles', {
    ...layer('national'),
    bytes: 8 * 1024 * 1024 + 1,
  });
  try {
    await assert.rejects(() => archive.range(0, 10), /valid byte ranges/);
  } finally {
    archive.close();
    globalThis.fetch = old;
  }
});
