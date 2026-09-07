import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  csvRecords,
  parseSpaceMetadata,
  parseSpaceOrbits,
  isSpaceObject,
  visibleSpaceObjects,
  DEFAULT_SPACE_TYPES,
  SPACE_REFRESH_INTERVAL,
  spaceRefreshAt,
  type SpaceObject,
} from '../lib/space-data';
import {
  createSpaceFeed,
  GP_CATALOG_URL,
  SATCAT_URL,
  SpaceFeedError,
} from '../lib/space-feed';
import type { SpaceCache } from '../lib/space-cache';
import { parseFallbackOrbits } from '../lib/space-fallback';
import { propagate, twoline2satrec } from 'satellite.js';
import { liveSearchItems } from '../lib/search-model';
import { readSpaceCsv } from '../lib/feeds';
import { makeSatellite, orbitPosition } from '../lib/orbits';

const epoch = '2026-09-07T12:00:00.000000',
  time = Date.parse(epoch + 'Z');
const catHeader =
  'OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER,LAUNCH_DATE,LAUNCH_SITE,DECAY_DATE,PERIOD,INCLINATION,APOGEE,PERIGEE,RCS,DATA_STATUS_CODE,ORBIT_CENTER,ORBIT_TYPE';
const catalogRow = (id: number, type: string, status = '+', center = 'EA') =>
  `"Test, object ${id}",2026-001A,${id},${type},${status},US,2026-01-01,AFETR,,92,51.6,430,410,,,${center},ORB`;
const cat = [
  catHeader,
  catalogRow(100001, 'PAY'),
  catalogRow(100002, 'R/B', '-'),
  catalogRow(100003, 'DEB'),
  catalogRow(100004, 'UNK'),
  catalogRow(100005, 'PAY', 'D'),
  catalogRow(100006, 'PAY', '+', 'SU'),
  catalogRow(100007, 'PAY', '-'),
].join('\r\n');
const gpHeader =
  'OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,EPHEMERIS_TYPE,CLASSIFICATION_TYPE,NORAD_CAT_ID,ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT';
const gpRow = (id: number, date = epoch) =>
  `Test ${id},2026-001A,${date},15.49,0.0005,51.6,120,100,260,0,U,${id},999,1,0.0001,0.00001,0`;
const gp = [
  gpHeader,
  ...[100001, 100002, 100003, 100004, 100005, 100006, 100007, 100008].map(
    (id) => gpRow(id),
  ),
].join('\n');
const objects = () => parseSpaceOrbits(gp, parseSpaceMetadata(cat), time);

void test('HTTP acquisition accepts CelesTrak binary MIME type and validates both CSV catalogs', async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const accept = new Headers(init?.headers).get('accept') || '';
    const binaryAccepted = accept
      .split(',')
      .some((part) =>
        ['application/octet-stream', '*/*'].includes(part.trim().split(';')[0]),
      );
    // CelesTrak rejects a text/csv-only Accept even though the file is CSV.
    if (!binaryAccepted) return new Response('Not acceptable', { status: 406 });
    assert.equal(init?.redirect, 'manual');
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    calls.push(url);
    return new Response(url === SATCAT_URL ? cat : gp, {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  };
  try {
    const snapshot = await createSpaceFeed(readSpaceCsv, () => time)();
    assert.deepEqual(calls, [SATCAT_URL, GP_CATALOG_URL]);
    assert.deepEqual(
      snapshot.items.map((o) => o.NORAD_CAT_ID),
      [100001, 100002, 100007],
    );
    assert.ok(snapshot.items.every(isSpaceObject));
  } finally {
    globalThis.fetch = original;
  }
});

void test('CSV preserves names with commas, quotes, Unicode and embedded newlines', () => {
  const records = [
    ...csvRecords(
      '\uFEFFNORAD_CAT_ID,OBJECT_NAME,RCS\r\n100001,"A, ""β""\nB",\r\n',
    ),
  ];
  assert.deepEqual(records, [
    { NORAD_CAT_ID: '100001', OBJECT_NAME: 'A, "β"\nB', RCS: '' },
  ]);
  assert.throws(() => [...csvRecords('NORAD_CAT_ID,OBJECT_NAME\n1,"bad')]);
  assert.throws(() => [...csvRecords('<html>provider error</html>')]);
});
void test('only explicitly classified Earth-orbiting payloads and rocket bodies survive the join', () => {
  const all = objects();
  assert.deepEqual(
    all.map((o) => o.NORAD_CAT_ID),
    [100001, 100002, 100007],
  );
  assert.equal(all[0].catalog.OBJECT_NAME, 'Test, object 100001');
  assert.equal(all[0].catalog.RCS, '');
  assert.equal(all[2].catalog.OPS_STATUS_CODE, '-'); // Inactive payloads are still payloads.
  assert.ok(all.every(isSpaceObject));
  assert.ok(orbitPosition(makeSatellite(all[0]), new Date(time)));
});
void test('malformed orbits are rejected and duplicate IDs use the latest epoch without truncation', () => {
  const largeCat = [
    catHeader,
    ...Array.from({ length: 200 }, (_, i) => catalogRow(100000 + i, 'PAY')),
  ].join('\n');
  const largeGp = [
    gpHeader,
    ...Array.from({ length: 200 }, (_, i) => gpRow(100000 + i)),
    gpRow(100001, '2026-09-06T12:00:00'),
    gpRow(100002).replace(',15.49,', ',,'),
  ].join('\n');
  const all = parseSpaceOrbits(largeGp, parseSpaceMetadata(largeCat), time);
  assert.equal(all.length, 200);
  assert.equal(all.find((o) => o.NORAD_CAT_ID === 100001)?.EPOCH, epoch);
  assert.throws(() =>
    parseSpaceOrbits(
      gpHeader + '\n' + gpRow(100001).replace(',15.49,', ',NaN,'),
      parseSpaceMetadata(cat),
      time,
    ),
  );
});
void test('type toggles and search exclude debris even from stale or forged browser records', () => {
  const all = objects();
  const debris = {
    ...all[0],
    NORAD_CAT_ID: 100003,
    catalog: { ...all[0].catalog, NORAD_CAT_ID: '100003', OBJECT_TYPE: 'DEB' },
  } as SpaceObject;
  const oldStation = { ...all[0], catalog: undefined };
  const inputs = [...all, debris, oldStation];
  assert.deepEqual(
    visibleSpaceObjects(inputs, DEFAULT_SPACE_TYPES).map((o) => o.NORAD_CAT_ID),
    [100001, 100007],
  );
  assert.deepEqual(
    visibleSpaceObjects(inputs, { payload: false, 'rocket-body': true }).map(
      (o) => o.NORAD_CAT_ID,
    ),
    [100002],
  );
  assert.equal(
    visibleSpaceObjects(inputs, { payload: false, 'rocket-body': false })
      .length,
    0,
  );
  const results = liveSearchItems({
    orbits: {
      items: inputs,
      fetchedAt: time,
      nextRefreshAt: time,
      source: 'fixture',
      sourceUrl: 'https://example.com',
    },
    air: null,
    sea: null,
  });
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.id !== 'satellite:100003'));
});
void test('bulk feed shares concurrent requests, downloads orbital data and metadata at most once per day', async () => {
  let now = time;
  const calls: string[] = [];
  const feed = createSpaceFeed(
    async (url) => {
      calls.push(url);
      return url === SATCAT_URL ? cat : gp;
    },
    () => now,
  );
  const [a, b] = await Promise.all([feed(), feed()]);
  assert.equal(a, b);
  assert.deepEqual(calls, [SATCAT_URL, GP_CATALOG_URL]);
  assert.equal((await feed()).cached, true);
  now += SPACE_REFRESH_INTERVAL - 1;
  assert.equal((await feed()).cached, true);
  assert.deepEqual(calls, [SATCAT_URL, GP_CATALOG_URL]);
  now += 1;
  await feed();
  assert.equal(calls.filter((url) => url === SATCAT_URL).length, 2);
});
void test('provider failure stops further requests, preserves prior snapshot and honors cooldown', async () => {
  let now = time,
    blocked = false;
  const calls: string[] = [];
  const feed = createSpaceFeed(
    async (url) => {
      calls.push(url);
      if (blocked) throw Error('provider 403');
      return url === SATCAT_URL ? cat : gp;
    },
    () => now,
  );
  const saved = await feed();
  now += SPACE_REFRESH_INTERVAL + 1;
  blocked = true;
  assert.match((await feed()).warning || '', /403/);
  const count = calls.length;
  assert.match((await feed()).warning || '', /403/);
  assert.equal(calls.length, count);
  assert.equal(saved.items.length, 3);
  now += SPACE_REFRESH_INTERVAL + 1;
  blocked = false;
  assert.equal((await feed()).items.length, 3);
  let attempts = 0;
  const badMetadata = createSpaceFeed(
    async () => {
      attempts++;
      throw Error('metadata blocked');
    },
    () => now,
  );
  await assert.rejects(badMetadata, /metadata blocked/);
  assert.equal(attempts, 1); // Never request GP after metadata fails.
});

function storedCache() {
  const records = new Map<string, unknown>();
  const cache: SpaceCache = {
    async read<T>(key: string) {
      return structuredClone(records.get(key)) as T | undefined;
    },
    async write(key, value) {
      records.set(key, structuredClone(value));
    },
  };
  return cache;
}
const issTle = {
  norad_cat_id: 25544,
  tle1: '1 25544U 98067A   26250.17589239  .00004561  00000-0  90859-4 0  9990',
  tle2: '2 25544  51.6308 254.3052 0005021 115.4261 244.7248 15.49013499584467',
  tle_source: 'Space-Track.org',
  updated: '2026-09-07T11:19:16.440317Z',
};
void test('backup TLE conversion matches direct propagation and rejects debris, bad checksums, stale and mismatched IDs', () => {
  const metadata = parseSpaceMetadata(
    [catHeader, catalogRow(25544, 'PAY')].join('\n'),
  );
  const all = parseFallbackOrbits(
    [issTle, { ...issTle, norad_cat_id: 25545 }],
    metadata,
    time,
    time,
  );
  assert.equal(all.length, 1);
  assert.equal(all[0].elementSource, 'SatNOGS DB');
  const direct = propagate(
    twoline2satrec(issTle.tle1, issTle.tle2),
    new Date(time),
  )?.position;
  const converted = propagate(makeSatellite(all[0]), new Date(time))?.position;
  assert.ok(direct && converted);
  assert.ok(
    Math.hypot(
      direct.x - converted.x,
      direct.y - converted.y,
      direct.z - converted.z,
    ) < 0.02,
  );
  assert.throws(() =>
    parseFallbackOrbits(
      [{ ...issTle, tle1: issTle.tle1.slice(0, 68) + '1' }],
      metadata,
      time,
      time,
    ),
  );
  assert.throws(() =>
    parseFallbackOrbits([issTle], metadata, time, time + 15 * 86400000),
  );
  metadata.get(25544)!.OBJECT_TYPE = 'DEB';
  assert.throws(() => parseFallbackOrbits([issTle], metadata, time, time));
});
void test('source cooldown survives new server instances with a fixed deadline and no upstream retries', async () => {
  let now = time,
    calls = 0;
  const cache = storedCache();
  const read = async () => {
    calls++;
    throw Object.assign(Error('HTTP 403'), { retryAfter: 172800 });
  };
  const feed = createSpaceFeed(read, () => now, { cache });
  const deadline = time + 172800000;
  await assert.rejects(
    feed,
    (e) =>
      e instanceof SpaceFeedError &&
      e.retryAt === deadline &&
      /No saved/.test(e.message),
  );
  now += 60000;
  const restarted = createSpaceFeed(read, () => now, { cache });
  await assert.rejects(
    restarted,
    (e) => e instanceof SpaceFeedError && e.retryAt === deadline,
  );
  assert.equal(calls, 1);
  now = deadline;
  await assert.rejects(restarted);
  assert.equal(calls, 2);
});
void test('backup loads during a persisted CelesTrak block and preserves previously saved rocket bodies', async () => {
  const cache = storedCache();
  const retryAt = time + SPACE_REFRESH_INTERVAL;
  const metadata = parseSpaceMetadata(
    [catHeader, catalogRow(25544, 'PAY'), catalogRow(100002, 'R/B')].join('\n'),
  );
  await cache.write('metadata', { rows: [...metadata], fetchedAt: time });
  await cache.write('control', {
    retryAt,
    failure: 'HTTP 403',
    fallbackRetryAt: 0,
    refreshInterval: SPACE_REFRESH_INTERVAL,
  });
  await cache.write('snapshot', {
    items: objects().filter((o) => o.objectType === 'rocket-body'),
    fetchedAt: time - SPACE_REFRESH_INTERVAL - 1,
    nextRefreshAt: time - 1,
    source: 'CelesTrak',
    sourceUrl: '',
  });
  let primary = 0,
    backup = 0;
  const options = {
    cache,
    readFallback: async () => {
      backup++;
      return [issTle];
    },
  };
  const read = async () => {
    primary++;
    return '';
  };
  const a = await createSpaceFeed(read, () => time, options)();
  assert.equal(a.items.length, 2);
  assert.ok(a.items.every(isSpaceObject));
  assert.ok(a.items.some((o) => o.objectType === 'rocket-body'));
  assert.match(a.warning || '', /backup/);
  assert.equal(a.nextRefreshAt, retryAt);
  const b = await createSpaceFeed(
    read,
    () => time + SPACE_REFRESH_INTERVAL - 1,
    options,
  )();
  assert.equal(b.items.length, 2);
  assert.equal(b.cached, true);
  assert.equal(primary, 0);
  assert.equal(backup, 1);
});

void test('old two-hour snapshots and provider cooldowns migrate to daily without downloading or sliding on restart', async () => {
  const cache = storedCache();
  const old = {
    items: objects(),
    fetchedAt: time,
    nextRefreshAt: time + 7200000,
    source: 'fixture',
    sourceUrl: '',
  };
  assert.equal(spaceRefreshAt(old), time + SPACE_REFRESH_INTERVAL);
  await cache.write('snapshot', old);
  await cache.write('control', {
    retryAt: time + 7200000,
    fallbackRetryAt: time + 7200000,
    failure: 'HTTP 403',
  });
  let calls = 0;
  const read = async () => {
    calls++;
    return cat;
  };
  const a = await createSpaceFeed(read, () => time + 7200001, { cache })();
  assert.equal(a.nextRefreshAt, time + SPACE_REFRESH_INTERVAL);
  assert.equal(calls, 0);
  const control = await cache.read<{
    retryAt: number;
    fallbackRetryAt: number;
    refreshInterval: number;
  }>('control');
  assert.equal(control?.retryAt, time + SPACE_REFRESH_INTERVAL);
  assert.equal(control?.fallbackRetryAt, time + SPACE_REFRESH_INTERVAL);
  const b = await createSpaceFeed(
    read,
    () => time + SPACE_REFRESH_INTERVAL - 1,
    { cache },
  )();
  assert.equal(b.nextRefreshAt, a.nextRefreshAt);
  assert.equal(calls, 0);
});
