import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressTilesForBounds, normalizeAddress } from '../lib/address-tiles';
import {
  PARCEL_ADAPTERS,
  validateBounds,
  type ParcelAdapter,
} from '../lib/land-model';
import {
  sourceBoundaries,
  normalizeEvidence,
  ownerSuppressed,
  situsAddress,
} from '../lib/parcel-service';
import { readBounded } from '../lib/bounded-fetch';
import {
  validateAddress,
  directoryFor,
  approvedRecordUrl,
  runPropertyInquiry,
} from '../lib/property-inquiry';
import { clampOrbitPitch } from '../lib/camera-controls';

void test('address range selection uses actual z14 tiles and refuses global/dateline requests', () => {
  const tiles = addressTilesForBounds({
    west: 2.352,
    south: 48.856,
    east: 2.353,
    north: 48.857,
  });
  assert.ok(tiles.length >= 1 && tiles.length <= 4);
  assert.ok(tiles.every((t) => t.z === 14));
  assert.throws(() =>
    addressTilesForBounds({ west: -180, south: -85, east: 180, north: 85 }),
  );
  assert.throws(() =>
    addressTilesForBounds({ west: 179.9, south: 0, east: -179.9, north: 0.01 }),
  );
  assert.throws(() =>
    validateBounds({ west: 0, south: 0, east: NaN, north: 1 }),
  );
});
void test('address normalization preserves source attribution, units and unlabeled address levels', () => {
  const a = normalizeAddress(
    {
      id: 'unit-a',
      number: '12',
      street: 'Rue Test',
      unit: 'B',
      country: 'FR',
      postcode: '75001',
      address_levels: '[{"value":"Paris"}]',
      sources:
        '[{"dataset":"BAN","license":"Etalab-2.0","record_id":"sample"}]',
    },
    48.856,
    2.352,
  )!;
  assert.equal(a.unit, 'B');
  assert.equal(a.city, 'Paris');
  assert.ok(a.label.includes('Unit B'));
  assert.equal(a.sources[0].dataset, 'BAN');
  assert.equal(a.sources[0].license, 'Etalab-2.0');
  assert.equal(normalizeAddress({ id: 'invalid', number: 12 }, NaN, 0), null);
});
void test('privacy flags and placeholders suppress names and owner-field source links', () => {
  const harris = PARCEL_ADAPTERS.find((a) => a.id === 'tx-harris')!;
  for (const flag of ['Y', 'TRUE', 'unknown']) {
    const raw: Record<string, unknown> = { confidential_flag: flag };
    for (const field of harris.fields.owner) raw[field] = 'PRIVATE FIXTURE';
    const evidence = normalizeEvidence(raw, harris, 29.7, -95.3);
    assert.equal(ownerSuppressed(raw, harris), true);
    assert.deepEqual(evidence.ownerNames, []);
    assert.deepEqual(evidence.recordLinks, []);
    assert.equal(
      new URL(evidence.sourceUrl).searchParams.get('outFields'),
      harris.boundaryOutFields,
    );
    assert.ok(!JSON.stringify(evidence).includes('PRIVATE FIXTURE'));
  }
  const ct = PARCEL_ADAPTERS.find((a) => a.id === 'ct')!;
  assert.equal(ownerSuppressed({ Owner: 'Current Owner' }, ct), true);
  assert.deepEqual(
    normalizeEvidence(
      { Owner: 'Current Owner', Co_Owner: 'Current Co-Owner' },
      ct,
      41.7,
      -72.6,
    ).ownerNames,
    [],
  );
});
void test('Dallas taxpayers remain explicitly labeled and component addresses stay ordered', () => {
  const a = PARCEL_ADAPTERS.find((a) => a.id === 'tx-dallas')!;
  const raw = {
    TAXPANAME1: 'SYNTHETIC TAXPAYER',
    ST_NUM: '12',
    ST_DIR: 'N',
    ST_NAME: 'TEST',
    ST_TYPE: 'ST',
    UNITID: 'B',
    CITY: 'DALLAS',
  };
  const evidence = normalizeEvidence(raw, a, 32.77, -96.79);
  assert.equal(evidence.ownerRole, 'taxpayer');
  assert.ok(
    evidence.notes.some((n) => n.includes('do not establish ownership')),
  );
  assert.equal(situsAddress(raw, a), '12 N TEST ST B DALLAS');
});
void test('Arkansas record cap cannot silently drop the second half of a parcel batch', async () => {
  const original = globalThis.fetch;
  const adapter = {
    ...PARCEL_ADAPTERS.find((a) => a.id === 'ar')!,
    id: 'ar-test-cap',
  } as ParcelAdapter;
  const batches: number[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      ),
      q = url.searchParams;
    if (q.get('returnIdsOnly') === 'true')
      return Response.json({
        objectIds: Array.from({ length: 450 }, (_, i) => i + 1),
      });
    const ids = (q.get('objectIds') || '').split(',');
    batches.push(ids.length);
    return Response.json({
      features: ids.slice(0, 200).map((id) => ({
        attributes: { [adapter.objectIdField]: Number(id) },
        geometry: {
          rings: [
            [
              [0, 0],
              [0, 0.001],
              [0.001, 0.001],
              [0.001, 0],
              [0, 0],
            ],
          ],
        },
      })),
      exceededTransferLimit: ids.length > 200,
    });
  };
  try {
    const result = await sourceBoundaries(adapter, {
      west: 0,
      south: 0,
      east: 0.01,
      north: 0.01,
    });
    assert.equal(result.features.length, 450);
    assert.equal(result.truncated, false);
    assert.deepEqual(batches, [200, 200, 50]);
  } finally {
    globalThis.fetch = original;
  }
});
void test('bounded reads reject oversized chunked responses even without content length', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(15));
      c.enqueue(new Uint8Array(15));
      c.close();
    },
  });
  await assert.rejects(readBounded(new Response(stream), 20), /size limit/);
  await assert.rejects(
    readBounded(
      new Request('https://openview.invalid/property', {
        method: 'POST',
        body: new Uint8Array(30),
      }),
      20,
    ),
    /size limit/,
  );
});
void test('property input ignores caller supplied record URLs and invalid locations', () => {
  assert.throws(() => validateAddress({ lat: 91, lon: 0 }));
  const a = validateAddress({
    lat: 48.85,
    lon: 2.35,
    country: 'fr',
    number: '12',
    street: 'Test',
    sources: [{ dataset: 'https://evil.test' }],
  });
  assert.equal(a.country, 'FR');
  assert.deepEqual(a.sources, []);
  assert.equal(
    approvedRecordUrl('http://localhost/admin', 'https://county.gov'),
    false,
  );
  assert.equal(
    approvedRecordUrl('https://unrelated.gov/search', 'https://county.gov'),
    false,
  );
  assert.equal(
    approvedRecordUrl('https://county.gov/property/1', 'https://county.gov'),
    true,
  );
  assert.ok(directoryFor('FR').length > 0);
});
void test('unsupported international location returns honest coverage and registry links without remote querying', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('No automated provider is authorized here');
  };
  const events: import('../lib/land-model').InquiryEvent[] = [];
  try {
    const a = validateAddress({
      lat: 48.85,
      lon: 2.35,
      country: 'FR',
      street: 'Test',
    });
    const result = await runPropertyInquiry(
      a,
      (e) => events.push(e),
      new AbortController().signal,
    );
    assert.equal(result?.status, 'complete');
    assert.equal(result.evidence.length, 0);
    assert.ok(result.directory.length > 0);
    assert.ok(result.checks.some((c) => c.status === 'unsupported'));
    assert.equal(events.at(-1)?.type, 'complete');
  } finally {
    globalThis.fetch = original;
  }
});
void test('orbit tilt clamps only near-horizon pitch', () => {
  assert.equal(clampOrbitPitch(-Math.PI), (-Math.PI * 89.5) / 180);
  assert.equal(clampOrbitPitch(1), (-Math.PI * 5) / 180);
  assert.equal(clampOrbitPitch(-0.5), -0.5);
});
