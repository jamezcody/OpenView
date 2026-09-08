import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { RadioData, RadioInspection } from '../lib/radio-data';
import {
  DEFAULT_RADIO_FILTERS,
  validateRadioNode,
  type RadioFile,
  type RadioFilters,
  type RadioGroup,
  type RadioManifest,
  type RadioMarker,
  type RadioNode,
} from '../lib/radio-model';

const signal = () => new AbortController().signal;
const bounds = [-180, -90, 180, 90];
const world = { west: -180, south: -90, east: 180, north: 90 };
const manifest: RadioManifest = {
  schemaVersion: 1,
  version: 'overview-test',
  createdAt: '2026-09-07T00:00:00Z',
  builderRun: 'test',
  dbSha256: '',
  reportSha256: '',
  counts: { transmitters: 0, receivers: 0, candidates: 0 },
  sources: [],
  facets: { sources: [], countries: [], services: [], statuses: [] },
};
const group: RadioGroup = {
  category: 'transmitters',
  source: 'us_uls',
  country: 'US',
  service: 'FM',
  network: 'plmn:310:260',
  status: 'active',
  frequency_mhz: 100,
  frequency_upper_mhz: null,
  count: 1,
  lat: 5,
  lon: 10,
};
const overview = (r: RadioGroup): RadioGroup => ({
  ...r,
  frequency_mhz: null,
  frequency_upper_mhz: null,
});

function fixture() {
  const assets = new Map<string, string>();
  const requested: string[] = [];
  const prefix = `/radio/versions/${manifest.version}/`;
  const data = new RadioData(async (input) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    requested.push(url);
    const value = assets.get(url);
    return new Response(value ?? 'missing fixture', {
      status: value === undefined ? 404 : 200,
    });
  });
  return {
    data,
    requested,
    page(file: string, rows: unknown[]): RadioFile {
      const value = JSON.stringify(rows);
      assets.set(prefix + file, value);
      return {
        file,
        bytes: Buffer.byteLength(value),
        sha256: createHash('sha256').update(value).digest('hex'),
      };
    },
    node(node: RadioNode) {
      assets.set(prefix + `nodes/${node.id}.json`, JSON.stringify(node));
    },
  };
}

void test('frequency-free world view skips exact summaries larger than the view budget', async () => {
  const f = fixture();
  const exact = Array.from({ length: 30 }, (_, index) =>
    f.page(`summary/f${index}.json`, [
      { ...group, frequency_mhz: 100 + index, detail: 'x'.repeat(200000) },
    ]),
  );
  assert.ok(
    exact.reduce((total, page) => total + page.bytes, 0) > 4 * 1024 * 1024,
  );
  f.node({
    id: 'r',
    bounds,
    children: ['r0'],
    summaryPages: exact,
    overviewPages: [
      f.page('overview/r.json', [overview({ ...group, count: 30 })]),
    ],
    recordPages: [],
  });
  const result = await f.data.view(
    manifest,
    world,
    0,
    DEFAULT_RADIO_FILTERS,
    signal(),
  );
  assert.equal(result.limited, false);
  assert.equal(result.markers.length, 1);
  assert.equal(result.markers[0].count, 30);
  assert.equal(result.markers[0].lat, group.lat);
  assert.equal(result.requests, 2);
  assert.ok(result.bytes < 10000);
  assert.ok(f.requested.every((url) => !url.includes('/summary/')));
});

void test('overview preserves source, country, service, status, network and category filters', async () => {
  const f = fixture();
  const rows = [
    { ...group, count: 3 },
    { ...group, source: 'us_lms', count: 50 },
    { ...group, country: 'CA', count: 60 },
    { ...group, service: 'AM', count: 70 },
    { ...group, status: 'expired', count: 80 },
    { ...group, network: 'plmn:310:410', count: 90 },
    { ...group, category: 'receivers' as const, count: 100 },
  ];
  f.node({
    id: 'r',
    bounds,
    children: ['r0'],
    summaryPages: [f.page('summary/r.json', rows)],
    overviewPages: [f.page('overview/r.json', rows.map(overview))],
    recordPages: [],
  });
  const filters: RadioFilters = {
    ...DEFAULT_RADIO_FILTERS,
    categories: ['transmitters'],
    source: 'us_uls',
    country: 'US',
    service: 'FM',
    status: 'active',
    network: 'plmn:310:260',
  };
  const result = await f.data.view(manifest, world, 0, filters, signal());
  assert.equal(result.markers[0].count, 3);
  assert.equal(result.markers[0].category, 'transmitters');
  assert.ok(f.requested.every((url) => !url.includes('/summary/')));
});

void test('known, unknown and bounded frequency queries always use exact summaries', async () => {
  for (const [settings, expected] of [
    [{ frequency: 'known' }, 5],
    [{ frequency: 'unknown' }, 7],
    [{ minMHz: '105' }, 3],
    [{ maxMHz: '95' }, 3],
    [{ minMHz: '101', maxMHz: '105' }, 3],
  ] as [Partial<RadioFilters>, number][]) {
    const f = fixture();
    const rows = [
      { ...group, count: 2 },
      { ...group, frequency_mhz: 90, frequency_upper_mhz: 110, count: 3 },
      { ...group, frequency_mhz: null, count: 7 },
    ];
    f.node({
      id: 'r',
      bounds,
      children: ['r0'],
      summaryPages: [f.page('summary/r.json', rows)],
      overviewPages: [
        f.page('overview/r.json', [overview({ ...group, count: 12 })]),
      ],
      recordPages: [],
    });
    const result = await f.data.view(
      manifest,
      world,
      0,
      { ...DEFAULT_RADIO_FILTERS, ...settings },
      signal(),
    );
    assert.equal(result.markers[0].count, expected, JSON.stringify(settings));
    assert.ok(f.requested.some((url) => url.includes('/summary/')));
    assert.ok(f.requested.every((url) => !url.includes('/overview/')));
  }
});

void test('older nodes without overview pages still load through exact summaries', async () => {
  const f = fixture();
  f.node({
    id: 'r',
    bounds,
    children: ['r0'],
    summaryPages: [f.page('summary/r.json', [{ ...group, count: 8 }])],
    recordPages: [],
  });
  const result = await f.data.view(
    manifest,
    world,
    0,
    DEFAULT_RADIO_FILTERS,
    signal(),
  );
  assert.equal(result.markers[0].count, 8);
  assert.ok(f.requested.some((url) => url.includes('/summary/')));
});

void test('overview inspection keeps receiver categories and returns original exact-frequency identities', async () => {
  const f = fixture();
  const receiver = {
    ...group,
    category: 'receivers' as const,
    frequency_mhz: 145,
  };
  const rows = [group, receiver];
  for (const id of ['r', 'r0']) {
    f.node({
      id,
      bounds,
      children: id === 'r' ? ['r0'] : [],
      summaryPages: [f.page(`summary/${id}.json`, rows)],
      overviewPages: [f.page(`overview/${id}.json`, rows.map(overview))],
      recordPages:
        id === 'r'
          ? []
          : [
              f.page(
                'records/r0.json',
                rows.map((r, index) => ({
                  ...r,
                  id: `${r.category}:${index}`,
                  record_id: String(index),
                })),
              ),
            ],
    });
  }
  const marker: RadioMarker = {
    id: 'r:receivers',
    node: 'r',
    bounds,
    category: 'receivers',
    lat: group.lat,
    lon: group.lon,
    count: 1,
  };
  const result = await new RadioInspection(
    f.data,
    manifest.version,
    marker,
    DEFAULT_RADIO_FILTERS,
  ).next(signal());
  assert.equal(result.limited, false);
  assert.equal(result.more, false);
  assert.deepEqual(
    result.records.map((r) => r.id),
    ['receivers:1'],
  );
  assert.equal(result.records[0].frequency_mhz, 145);
  assert.ok(
    f.requested.filter((url) => url.includes('/overview/')).length === 2,
  );
  assert.ok(f.requested.every((url) => !url.includes('/summary/')));
  f.requested.length = 0;
  const filtered = await new RadioInspection(f.data, manifest.version, marker, {
    ...DEFAULT_RADIO_FILTERS,
    frequency: 'unknown',
  }).next(signal());
  assert.deepEqual(filtered.records, []);
  assert.ok(f.requested.some((url) => url.includes('/summary/')));
  assert.ok(f.requested.every((url) => !url.includes('/overview/')));
});

void test('overview metadata uses the same bounded path and checksum validation as summaries', () => {
  const node = {
    id: 'r',
    bounds,
    children: [],
    summaryPages: [],
    recordPages: [],
  };
  const page = { file: 'overview/r.json', bytes: 120, sha256: 'a'.repeat(64) };
  assert.doesNotThrow(() => validateRadioNode(node, 'r'));
  assert.doesNotThrow(() =>
    validateRadioNode({ ...node, overviewPages: [page] }, 'r'),
  );
  for (const overviewPages of [
    null,
    {},
    [{ ...page, file: '../private.json' }],
    [{ ...page, bytes: 262145 }],
    [{ ...page, sha256: 'invalid' }],
  ]) {
    assert.throws(
      () => validateRadioNode({ ...node, overviewPages }, 'r'),
      /spatial index/,
    );
  }
});
