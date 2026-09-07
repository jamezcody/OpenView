import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  coordinateResult,
  coverageSearchItems,
  indexSearch,
  liveSearchItems,
  parsePhoton,
  searchMatches,
  type SearchResult,
} from '../lib/search-model';
import {
  parseSearchItems,
  parseSearchManifest,
  searchJson,
} from '../lib/search-data';
import { validateAddress } from '../lib/property-inquiry';
import { photonUrl, placeSearch } from '../lib/place-search';
import type { CoverageManifest } from '../lib/coverage-model';
import type { Snapshot, Track } from '../lib/model';

const fetchUrl = (input: RequestInfo | URL) =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
const result = (id: string, name: string, terms = ''): SearchResult => ({
  id,
  name,
  kind: 'place',
  terms,
  detail: '',
  lat: 30,
  lon: -80,
  height: 1500,
  source: 'Fixture',
  sourceUrl: '',
  target: { type: 'place' },
});
void test('unified search matches accents, all query words, IDs, and keeps same-name source identities', () => {
  const a = result('first', 'São Paulo VOR', '123.45 Brazil'),
    b = result('second', 'São Paulo VOR', '117.9 Brazil'),
    exact = result('third', 'São Paulo');
  assert.equal(
    searchMatches([indexSearch([a, b, exact])], 'sao paulo').items[0].id,
    'third',
  );
  assert.deepEqual(
    searchMatches([indexSearch([a, b])], 'paulo 123.45').items.map((r) => r.id),
    ['first'],
  );
  assert.equal(
    searchMatches([indexSearch([a, b]), indexSearch([a])], 'sao paulo').total,
    2,
  );
  assert.equal(searchMatches([indexSearch([a])], 'first').items[0].id, 'first');
  assert.equal(searchMatches([indexSearch([a, b])], 'nonexistent').total, 0);
});
void test('coordinate search requires two explicit valid numbers in latitude, longitude order', () => {
  assert.deepEqual(
    [
      coordinateResult(' -13.82, -171.77 ')?.lat,
      coordinateResult(' -13.82, -171.77 ')?.lon,
    ],
    [-13.82, -171.77],
  );
  for (const query of [
    ',',
    '0,',
    ' ,0',
    '91,0',
    '0,181',
    'Infinity,0',
    '1e2,3',
    '1,2,3',
    'Paris, France',
  ])
    assert.equal(coordinateResult(query), null, query);
  assert.ok(coordinateResult('0,0'));
  assert.ok(coordinateResult('90,180'));
});
const photon = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-78.6390989, 35.7803977] },
      properties: {
        osm_type: 'R',
        osm_id: 179052,
        name: 'Raleigh',
        state: 'North Carolina',
        country: 'United States',
        countrycode: 'US',
        extent: [-78.8189744, 35.970736, -78.4707917, 35.7082575],
      },
    },
    {
      geometry: { type: 'Point', coordinates: [13.38, 52.51] },
      properties: {
        osm_type: 'N',
        osm_id: 123456,
        name: 'Fixture address',
        housenumber: '10',
        street: 'Example Straße',
        city: 'Berlin',
        countrycode: 'DE',
        postcode: '10117',
      },
    },
  ],
};
void test('Photon schema keeps coordinates, source identity, address attributes and OSM provenance through Get data', () => {
  const items = parsePhoton(photon);
  assert.equal(items.length, 2);
  assert.equal(items[0].lon, -78.6390989);
  assert.equal(items[0].name, 'Raleigh');
  assert.equal(items[0].target.type, 'place');
  assert.equal(items[1].target.type, 'address');
  if (items[1].target.type !== 'address') return;
  const address = validateAddress(items[1].target.address);
  assert.equal(address.source, 'OpenStreetMap / Photon');
  assert.equal(address.number, '10');
  assert.equal(address.country, 'DE');
  assert.equal(items[1].sourceUrl, 'https://www.openstreetmap.org/node/123456');
  assert.equal(
    parsePhoton({
      ...photon,
      features: [photon.features[0], photon.features[0]],
    }).length,
    1,
  );
  assert.equal(
    parsePhoton({
      features: [
        {
          geometry: { type: 'Point', coordinates: [999, 0] },
          properties: { osm_id: 1, osm_type: 'N', name: 'Bad' },
        },
      ],
    }).length,
    0,
  );
  assert.throws(() => parsePhoton({ features: 'wrong' }));
});
void test('loaded traffic remains searchable without overlay visibility and supports boat/plane aliases and IDs', () => {
  const t: Track = {
    id: '230123456',
    name: 'Example Vessel',
    lat: 60,
    lon: 24,
    altitude: 0,
    speed: 3,
    heading: 40,
    observedAt: 1000,
    kind: 'ships',
  };
  const sea: Snapshot<Track> = {
    items: [t],
    source: 'Fixture AIS',
    sourceUrl: 'https://example.com',
    fetchedAt: 2000,
    nextRefreshAt: 3000,
  };
  const items = liveSearchItems({ orbits: null, air: null, sea });
  assert.equal(
    searchMatches([indexSearch(items)], 'boat 230123456').items[0].target.type,
    'track',
  );
  assert.equal(items[0].observedAt, 1000);
  assert.equal(items[0].lon, 24);
});
void test('FCC search only creates navigation results for imported jurisdictions', () => {
  const m = {
    release: 'test',
    layers: [
      {
        id: 'lte',
        provider: { name: 'Carrier' },
        technology: 'LTE',
        downloadMbps: 5,
        uploadMbps: 1,
        reportingDate: '2026-01-01',
        sourceUrl: 'https://example.com',
        jurisdictions: [
          { id: 'NC', name: 'North Carolina', status: 'ready' },
          { id: 'VA', name: 'Virginia', status: 'failed' },
        ],
        regions: [
          { id: 'NC', rectangle: [-84, 33, -75, 37] },
          { id: 'VA', rectangle: [-83, 36, -75, 40] },
        ],
      },
    ],
  } as unknown as CoverageManifest;
  const items = coverageSearchItems(m);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'Carrier LTE · North Carolina');
  assert.equal(items[0].target.type, 'coverage');
});
void test('search file reader verifies integrity and retains useful API failure messages', async () => {
  const old = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('{"ok":true}');
    const bytes = Buffer.from('{"ok":true}'),
      hash = createHash('sha256').update(bytes).digest('hex');
    assert.deepEqual(
      await searchJson(
        '/test',
        new AbortController().signal,
        bytes.length,
        hash,
      ),
      { ok: true },
    );
    await assert.rejects(
      searchJson(
        '/test',
        new AbortController().signal,
        bytes.length,
        'a'.repeat(64),
      ),
      /checksum/,
    );
    globalThis.fetch = async () =>
      Response.json({ error: 'Provider is busy; try again.' }, { status: 429 });
    await assert.rejects(
      searchJson('/test', new AbortController().signal, 1024),
      /Provider is busy/,
    );
  } finally {
    globalThis.fetch = old;
  }
});
void test('online lookup validates query, coalesces and caches identical requests, and limits provider parameters', async () => {
  await assert.rejects(placeSearch('ab'), /3–180/);
  const old = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (input) => {
      calls++;
      const url = new URL(fetchUrl(input));
      assert.equal(url.origin, 'https://photon.komoot.io');
      assert.equal(url.searchParams.get('limit'), '12');
      assert.equal(url.searchParams.has('lat'), false);
      return Response.json(photon);
    };
    const [first, second] = await Promise.all([
      placeSearch('OpenView fixture 2026'),
      placeSearch('OpenView fixture 2026'),
    ]);
    assert.equal(first.items.length, 2);
    assert.equal(second.items.length, 2);
    assert.equal(calls, 1);
    await placeSearch('OpenView fixture 2026');
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = old;
  }
});
void test('Photon overrides cannot carry credentials or opaque URL state', () => {
  const valid = photonUrl('https://search.example.test/photon', 'Yellowstone');
  assert.equal(valid.origin, 'https://search.example.test');
  assert.equal(valid.pathname, '/photon');
  assert.equal(valid.searchParams.get('q'), 'Yellowstone');

  const credentials = new URL('https://search.example.test/photon');
  credentials.username = 'fixture-user';
  credentials.password = 'fixture-password';
  const query = new URL('https://search.example.test/photon');
  query.searchParams.set('token', 'fixture-token');
  const fragment = new URL('https://search.example.test/photon');
  fragment.hash = 'fixture-fragment';
  for (const endpoint of [
    'http://search.example.test/photon',
    credentials.href,
    query.href,
    fragment.href,
    'not a URL',
  ])
    assert.throws(() => photonUrl(endpoint, 'Yellowstone'), /endpoint/);
});
void test('installed search release matches complete radio and park snapshots, checksums and exact record locators', () => {
  const root = resolve(process.cwd(), 'public'),
    m = parseSearchManifest(
      JSON.parse(readFileSync(resolve(root, 'search/latest.json'), 'utf8')),
    );
  assert.equal(
    m.radioVersion,
    JSON.parse(readFileSync(resolve(root, 'radio/latest.json'), 'utf8'))
      .version,
  );
  assert.equal(
    m.parkRelease,
    JSON.parse(readFileSync(resolve(root, 'parks/latest.json'), 'utf8'))
      .release,
  );
  const indexes = [];
  for (const f of m.files) {
    const bytes = readFileSync(resolve(root, 'search', m.version, f.file));
    assert.equal(bytes.length, f.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), f.sha256);
    const items = parseSearchItems(
      JSON.parse(bytes.toString()),
      f.kind,
      f.count,
      f.kind === 'radio' ? m.radioVersion : m.parkRelease,
    );
    assert.equal(new Set(items.map((i) => i.id)).size, f.count);
    indexes.push(indexSearch(items));
    if (f.kind === 'radio') {
      assert.equal(items.length, 36779);
      for (const i of items) {
        assert.equal(i.target.type, 'radio');
        if (i.target.type === 'radio')
          assert.ok(i.target.recordId.includes(':'));
      }
    } else {
      assert.equal(items.filter((i) => i.kind === 'national-park').length, 63);
      assert.equal(items.filter((i) => i.kind === 'state-park').length, 6169);
      const yellowstone = items.find(
        (i) => i.name === 'Yellowstone National Park',
      )!;
      assert.ok(
        yellowstone.lat !== null &&
          yellowstone.lon !== null &&
          yellowstone.lat > 44 &&
          yellowstone.lat < 46 &&
          yellowstone.lon < -109 &&
          yellowstone.lon > -112,
      );
    }
  }
  assert.ok(
    searchMatches(indexes, 'yellowstone').items.some(
      (i) => i.kind === 'national-park',
    ),
  );
  assert.ok(
    searchMatches(indexes, 'Jockey').items.some((i) => i.kind === 'state-park'),
  );
  assert.ok(
    searchMatches(indexes, 'Yle').items.some((i) => i.kind === 'transmitter'),
  );
  assert.throws(() => parseSearchManifest({ ...m, version: '../escape' }));
});
