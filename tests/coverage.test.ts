import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coverageManifest,
  coverageIndex,
  coverageTileStatus,
  coverageTileKey,
  boundedCoverageBytes,
} from '../lib/coverage-model';

const fixture = () => ({
  schemaVersion: 1,
  release: 'test-release',
  publishedAt: '2026-09-06T00:00:00Z',
  layers: [
    {
      id: 'test-layer',
      provider: { id: '123456', name: 'Synthetic test provider' },
      technology: 'LTE',
      downloadMbps: 5,
      uploadMbps: 1,
      environment: 'outdoor-stationary',
      reportingDate: '2025-12-31',
      acquiredAt: '2026-09-06T00:00:00Z',
      processedAt: '2026-09-06T00:00:00Z',
      sourceUrl: 'https://example.invalid/test',
      attribution: 'Synthetic test',
      ready: true,
      jurisdictions: [{ id: 'test', name: 'Test region', status: 'ready' }],
      regions: [{ id: 'test', rectangle: [-80, 30, -70, 40] }],
      tiles: {
        scheme: 'xyz-web-mercator',
        tileSize: 256,
        minZoom: 0,
        maxZoom: 9,
      },
      limits: ['Synthetic fixture only.'],
    },
  ],
});

void test('coverage rejects unready, inconsistent criteria, invalid dates and unsplit bounds', () => {
  assert.equal(coverageManifest(fixture()).layers[0].technology, 'LTE');
  const badReady = fixture();
  badReady.layers[0].ready = false;
  assert.throws(() => coverageManifest(badReady));
  const badSpeed = fixture();
  badSpeed.layers[0].downloadMbps = 35;
  assert.throws(() => coverageManifest(badSpeed));
  const badDate = fixture();
  badDate.layers[0].reportingDate = '2025-02-31';
  assert.throws(() => coverageManifest(badDate));
  const badBounds = fixture();
  badBounds.layers[0].regions[0].rectangle = [170, 30, -170, 40];
  assert.throws(() => coverageManifest(badBounds));
  const duplicate = fixture();
  duplicate.layers.push(duplicate.layers[0]);
  assert.throws(() => coverageManifest(duplicate));
});
void test('coverage keeps required objects, known empty tiles and unknown scope distinct', () => {
  const m = coverageManifest(fixture()),
    l = m.layers[0];
  const raw = {
    schemaVersion: 1,
    release: m.release,
    layerId: l.id,
    minZoom: 0,
    maxZoom: 9,
    tileSize: 256,
    present: {
      '3/2/3': {
        sha256: 'a'.repeat(64),
        bytes: 300,
        scope: 'partial',
        coverage: 'none',
      },
    },
    knownEmpty: { '3/3': [[3, 4]] },
  };
  const i = coverageIndex(raw, m.release, l);
  assert.equal(coverageTileStatus(i, 3, 2, 3), 'present');
  assert.equal(coverageTileStatus(i, 3, 3, 3), 'known-empty');
  assert.equal(coverageTileStatus(i, 3, 5, 3), 'unknown');
  assert.throws(() =>
    coverageIndex({ ...raw, release: 'old-release' }, m.release, l),
  );
  assert.throws(() =>
    coverageIndex(
      { ...raw, present: { '../secret': raw.present['3/2/3'] } },
      m.release,
      l,
    ),
  );
  assert.throws(() => coverageTileKey(3, 8, 0));
  assert.throws(() => coverageTileKey(3, -1, 0));
  assert.throws(() => coverageTileKey(3.5, 1, 1));
});
void test('coverage missing required files and oversized streams remain errors', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('missing', { status: 404 });
    await assert.rejects(
      boundedCoverageBytes('/test', new AbortController().signal, 100),
      /HTTP 404/,
    );
    globalThis.fetch = async () => new Response(new Uint8Array(101));
    await assert.rejects(
      boundedCoverageBytes('/test', new AbortController().signal, 100),
      /size limit/,
    );
    globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]));
    assert.deepEqual(
      Array.from(
        await boundedCoverageBytes('/test', new AbortController().signal, 100),
      ),
      [1, 2, 3],
    );
  } finally {
    globalThis.fetch = original;
  }
});
