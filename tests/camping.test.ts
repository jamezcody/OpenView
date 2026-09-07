import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { CampingData, CampLimit, campRequest } from '../lib/camping-data';
import {
  campManifest,
  filterCampMarkers,
  campMapped,
  campUrl,
  campIntersects,
  campRecordResult,
  CAMP_BUDGET,
  type CampBounds,
  type CampFile,
  type CampManifest,
  type CampNode,
  type CampMarker,
} from '../lib/camping-model';

const root = resolve(process.cwd(), 'public');
const localFetch = (async (
  url: string | URL | Request,
  options?: RequestInit,
) => {
  options?.signal?.throwIfAborted();
  return new Response(
    readFileSync(
      resolve(
        root,
        (url instanceof Request ? url.url : String(url)).replace(/^\//, ''),
      ),
    ),
    { status: 200 },
  );
}) as typeof fetch;
const req = () => campRequest(new AbortController().signal);
const real = () => new CampingData(localFetch);

void test('camping accepts only screened map locations, validates links and crosses the dateline', () => {
  assert.equal(
    campMapped({ location: [0, 0], coordinate_quality: 'missing_or_invalid' }),
    false,
  );
  assert.equal(
    campMapped({
      location: [-120, 31],
      coordinate_quality: 'outside_generalized_us_state_polygons_review',
    }),
    false,
  );
  assert.equal(
    campMapped({
      location: null,
      coordinate_quality: 'within_us_state_polygon',
    }),
    false,
  );
  assert.equal(
    campMapped({
      location: [-119, 37],
      coordinate_quality: 'within_us_state_polygon',
    }),
    true,
  );
  assert.equal(campUrl('javascript:alert(1)'), null);
  assert.equal(
    campUrl('https://test-user:test-password@example.invalid'),
    null,
  );
  assert.equal(
    campUrl('https://www.recreation.gov/camping/'),
    'https://www.recreation.gov/camping/',
  );
  assert.ok(campIntersects([170, 50, -170, 72], [-180, 50, -175, 60]));
  assert.ok(campIntersects([170, 50, -170, 72], [175, 50, 180, 60]));
  assert.equal(
    campIntersects([170, 50, -170, 72], [-120, 30, -110, 40]),
    false,
  );
});

void test('real camping release retains payment classes, parent/site identities and unavailable coordinates', async () => {
  const data = real(),
    m = await data.manifest(req());
  assert.equal(m.stats.records, 274534);
  assert.equal(m.stats.mapped, 255304);
  assert.equal(m.stats.unmapped, 19230);
  assert.equal(m.stats.unresolvedParents, 80);
  assert.equal(m.stats.possibleDuplicatePairs, 8862);
  const site = (await data.record(m, 'ridb_campsite:1', req()))!;
  assert.equal(site.parent_id, 'ridb_facility:232446');
  assert.equal(site.payment_status, 'unclear');
  assert.equal(site.payment_evidence, '{}');
  const parent = (await data.record(m, site.parent_id!, req()))!;
  const links = await data.children(m, parent.id, 0, req());
  assert.ok(links.items.some((r) => r[0] === site.id));
  assert.equal(parent.children_count, 96);
  const first = await data.children(m, 'ridb_facility:258830', 0, req());
  const second = await data.children(m, 'ridb_facility:258830', 1, req());
  assert.equal(first.pages, 4);
  assert.equal(first.items.length, 100);
  assert.equal(second.items.length, 100);
  assert.equal(
    new Set([...first.items, ...second.items].map((r) => r[0])).size,
    200,
  );
  const linked = await data.record(m, second.items[0][0], req());
  assert.equal(linked?.parent_id, 'ridb_facility:258830');
  const hosmer = (await data.record(m, 'ridb_facility:10068557', req()))!;
  assert.equal(hosmer.name, 'Hosmer Grove Campground');
  assert.equal(hosmer.payment_status, 'pay');
  assert.equal(campRecordResult(hosmer, m.version).lat, null);
  assert.equal(campMapped(hosmer), false);
  const result = campRecordResult(site, m.version);
  assert.equal(result.target.type, 'camping');
  if (result.target.type === 'camping') {
    assert.equal(result.target.recordId, site.id);
    assert.equal(result.target.version, m.version);
  }
});

void test('camping searches the installed release in CA, AK, HI and unmapped records under budgets', async () => {
  const data = real();
  for (const [query, name] of [
    ['Wawona Campground', 'Wawona'],
    ['Denali AK', 'Denali'],
    ['Hosmer Grove', 'Hosmer'],
    ['osm:node/571276260', 'Hosmer'],
    ['ridb_campsite:1', '065'],
  ]) {
    const request = req(),
      result = await data.search(query, request);
    assert.ok(
      result.items.some((r) => r.name.includes(name)),
      `${query}: ${JSON.stringify(result)}`,
    );
    assert.ok(request.requests <= CAMP_BUDGET.requests);
    assert.ok(request.bytes <= CAMP_BUDGET.bytes);
    const picked = result.items[0];
    if (picked.target.type === 'camping') {
      const m = await data.manifest(req(), picked.target.version),
        r = await data.record(m, picked.target.recordId, req());
      assert.equal(r?.name, picked.name);
    }
  }
});

void test('actual CA, AK and HI views stay bounded and filter payments independently', async () => {
  const data = real(),
    m = await data.manifest(req());
  for (const bounds of [
    [-119.7, 37.53, -119.66, 37.58],
    [-150, 63, -149, 64],
    [-157, 20, -155, 22],
  ] as CampBounds[]) {
    const request = req(),
      result = await data.view(
        m,
        bounds,
        1800,
        ['campgrounds', 'sites'],
        ['pay'],
        request,
      );
    assert.ok(result.markers.length > 0);
    assert.ok(
      result.markers.every(
        (p) => p.payment === 'pay' && p.layer !== 'supplementary',
      ),
    );
    assert.ok(result.markers.length <= 360);
    assert.ok(request.requests <= 32);
    assert.ok(request.bytes <= CAMP_BUDGET.bytes);
  }
  const wide = await data.view(
    m,
    [-180, -90, 180, 90],
    20000000,
    ['campgrounds', 'sites'],
    ['pay', 'unclear', 'completely_free'],
    req(),
  );
  assert.ok(wide.markers.every((m) => m.cluster));
  assert.ok(wide.markers.length < 30);
  const closeSites = await data.view(
    m,
    [-112.1, 39.005, -112.08, 39.03],
    200,
    ['sites'],
    ['pay', 'unclear', 'completely_free'],
    req(),
  );
  assert.ok(closeSites.markers.length > 0);
  assert.ok(
    closeSites.markers.every(
      (marker) => marker.layer === 'sites' && !marker.cluster,
    ),
  );
  assert.deepEqual(
    (await data.view(m, [-180, -90, 180, 90], 1000, [], ['pay'], req()))
      .markers,
    [],
  );
});

function fixture() {
  const files = new Map<string, string>();
  const file = (name: string, value: unknown): CampFile => {
    const text = JSON.stringify(value);
    files.set(name, text);
    return {
      file: name,
      bytes: Buffer.byteLength(text),
      sha256: createHash('sha256').update(text).digest('hex'),
    };
  };
  const leaf = (b: CampBounds, id: string): CampNode => ({
    b,
    g: [['sites', 'unclear', 1, (b[0] + b[2]) / 2, 0]],
    r: [[id, id, 'sites', 'unclear', (b[0] + b[2]) / 2, 0]],
  });
  const node: CampNode = {
    b: [-180, -90, 180, 90],
    g: [['sites', 'unclear', 2, 0, 0]],
    c: [leaf([-180, -90, 0, 90], 'west'), leaf([0, -90, 180, 90], 'east')],
  };
  const m = {
    schema: 1,
    version: 'camping-00000000000000000000',
    snapshot: '2026-09-06',
    root: file('root.json', node),
    catalog: file('catalog.json', {}),
    stats: { records: 2 },
    attribution: 'OSM Â· ODbL',
  } as CampManifest;
  return { m, files };
}
void test('tile boundaries preserve records and pitches aggregate until close zoom', async () => {
  const { m, files } = fixture();
  const data = new CampingData(
    (async (url) =>
      new Response(
        files.get(
          (url instanceof Request ? url.url : String(url)).split('/').pop()!,
        ),
      )) as typeof fetch,
  );
  const east = await data.view(
    m,
    [0, -30, 180, 30],
    1000,
    ['sites'],
    ['unclear'],
    req(),
  );
  assert.deepEqual(
    east.markers.map((m) => m.recordId),
    ['east'],
  );
  const wide = await data.view(
    m,
    [-180, -90, 180, 90],
    50000,
    ['sites'],
    ['unclear'],
    req(),
  );
  assert.ok(wide.markers.every((m) => m.cluster));
  assert.equal(
    wide.markers.reduce((n, m) => n + m.count, 0),
    2,
  );
});
void test('camping markers remain visible during camera refreshes and narrow immediately with filters', () => {
  const markers: CampMarker[] = [
    {
      id: 'pay-site',
      recordId: 'pay-site',
      name: 'Paid site',
      layer: 'sites',
      payment: 'pay',
      lon: -112,
      lat: 39,
      count: 1,
      cluster: false,
      bounds: [-113, 38, -111, 40],
      version: 'camping-00000000000000000000',
    },
    {
      id: 'free-campground',
      recordId: 'free-campground',
      name: 'Free campground',
      layer: 'campgrounds',
      payment: 'completely_free',
      lon: -112,
      lat: 39,
      count: 1,
      cluster: false,
      bounds: [-113, 38, -111, 40],
      version: 'camping-00000000000000000000',
    },
  ];
  assert.strictEqual(
    filterCampMarkers(
      markers,
      'camping-00000000000000000000',
      ['sites', 'campgrounds'],
      ['pay', 'completely_free'],
    ),
    markers,
  );
  assert.deepEqual(
    filterCampMarkers(
      markers,
      'camping-00000000000000000000',
      ['sites'],
      ['pay'],
    ).map((marker) => marker.id),
    ['pay-site'],
  );
  assert.deepEqual(filterCampMarkers(markers, undefined, [], []), []);
});
void test('abort, HTTP failure, integrity failure and exhausted request budgets are explicit', async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const data = new CampingData((async () => {
    calls++;
    return new Response('{}');
  }) as typeof fetch);
  await assert.rejects(() => data.manifest(campRequest(controller.signal)), {
    name: 'AbortError',
  });
  assert.equal(calls, 0);
  const slow = new CampingData((async (_url, options) => {
    await new Promise<void>((_r, reject) =>
      options?.signal?.addEventListener('abort', () =>
        reject(options.signal!.reason),
      ),
    );
    return new Response('{}');
  }) as typeof fetch);
  const pending = new AbortController(),
    promise = slow.manifest(campRequest(pending.signal));
  pending.abort();
  await assert.rejects(() => promise, { name: 'AbortError' });
  await assert.rejects(
    () =>
      new CampingData(
        (async () => new Response('', { status: 503 })) as typeof fetch,
      ).manifest(req()),
    /HTTP 503/,
  );
  const { m } = fixture();
  await assert.rejects(() => data.file(m, m.root, req()), /integrity/);
  const exhausted = req();
  exhausted.requests = 32;
  await assert.rejects(() => data.manifest(exhausted), CampLimit);
  assert.throws(
    () => campManifest({ schema: 1, version: '../../private' }),
    /Invalid/,
  );
});

void test('camping cache evicts old assets at its byte budget', async () => {
  const bytes = JSON.stringify({ payload: 'x'.repeat(200000) });
  const hash = createHash('sha256').update(bytes).digest('hex');
  let calls = 0;
  const data = new CampingData((async () => {
    calls++;
    return new Response(bytes);
  }) as typeof fetch);
  const { m } = fixture();
  const ref = (i: number) => ({
    file: `page-${i}.json`,
    bytes: Buffer.byteLength(bytes),
    sha256: hash,
  });
  for (let i = 0; i < 45; i++) await data.file(m, ref(i), req());
  const before = calls;
  await data.file(m, ref(0), req());
  assert.equal(calls, before + 1);
});
