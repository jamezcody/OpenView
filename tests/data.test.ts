import { test } from 'node:test';
import assert from 'node:assert/strict';
import { twoline2satrec, propagate } from 'satellite.js';
import { predictedTrack, orbitPosition } from '../lib/orbits';
import {
  normalizeAircraft,
  normalizeShips,
  parcelProperties,
  cached,
  FeedError,
  parcels,
} from '../lib/feeds';
import { REGIONS, type Track } from '../lib/model';
const now = Date.UTC(2026, 8, 6, 12);
const track: Track = {
  id: 'test',
  name: 'Test fixture',
  lat: 0,
  lon: 179.99,
  altitude: 10000,
  speed: 450,
  heading: 90,
  observedAt: now,
  kind: 'aircraft',
};
void test('aircraft prediction crosses the dateline and freezes without jumping backward', () => {
  const a = predictedTrack(track, now + 60000),
    b = predictedTrack(track, now + 61000);
  assert.ok(a.lon < 0);
  assert.deepEqual(a, b);
  assert.deepEqual(b, predictedTrack(track, now + 3600000));
  assert.equal(a.altitude, 10000);
});
void test('missing speed or course does not invent motion', () => {
  assert.equal(
    predictedTrack({ ...track, heading: null }, now + 30000).lon,
    track.lon,
  );
  assert.equal(
    predictedTrack({ ...track, speed: null }, now + 30000).lon,
    track.lon,
  );
});
void test('ship markers and locate targets never extrapolate between snapshots', () => {
  const ship = { ...track, kind: 'ships' as const, altitude: 8, speed: 20 };
  for (const offset of [0, 15000, 60000, 120000, 599999, 600000, 86400000])
    assert.deepEqual(predictedTrack(ship, now + offset), {
      lat: ship.lat,
      lon: ship.lon,
      altitude: 8,
    });
  assert.deepEqual(predictedTrack({ ...ship, lon: 10 }, now + 600000), {
    lat: ship.lat,
    lon: 10,
    altitude: 8,
  });
});
void test('Vallado verification orbit propagates in physical altitude units', () => {
  const sat = twoline2satrec(
    '1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753',
    '2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667',
  );
  const date = new Date((sat.jdsatepoch - 2440587.5) * 86400000);
  const state = propagate(sat, date);
  assert.ok(state?.position);
  assert.ok(Math.abs(state.position.x - 7022.46529266) < 0.02);
  assert.ok(Math.abs(state.position.y + 1400.08296755) < 0.02);
  const p = orbitPosition(sat, date);
  assert.ok(p);
  assert.ok(p.altitude > 780000 && p.altitude < 800000);
  assert.ok(Math.abs(p.lat) < 0.01);
  assert.equal(orbitPosition(sat, new Date(NaN)), null);
});
void test('aircraft timestamps use milliseconds minus seen_pos seconds; reject stale and invalid', () => {
  const ac = [
    {
      hex: 'abc',
      flight: ' TEST1 ',
      lat: 40,
      lon: -74,
      alt_geom: 10000,
      gs: 200,
      track: 90,
      seen_pos: 3,
    },
    { hex: 'bad', lat: 95, lon: 20, seen_pos: 1 },
    { hex: 'old', lat: 40, lon: -74, seen_pos: 301 },
  ];
  const rows = normalizeAircraft({ now, ac }, now);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].observedAt, now - 3000);
  assert.equal(rows[0].altitude, 3048);
  assert.equal(rows[0].name, 'TEST1');
});
void test('AIS uses timestampExternal, excludes sentinel speed/course, drops day-old observations', () => {
  const feature = (time: number) => ({
    geometry: { coordinates: [24.9, 60.1] },
    properties: {
      mmsi: 123,
      timestamp: 42,
      timestampExternal: time,
      sog: 102.3,
      cog: 360,
    },
  });
  const rows = normalizeShips(
    { features: [feature(now - 5000), feature(now - 86400001)] },
    new Map([['123', 'TEST VESSEL']]),
    now,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].observedAt, now - 5000);
  assert.equal(rows[0].speed, null);
  assert.equal(rows[0].heading, null);
  assert.equal(rows[0].name, 'TEST VESSEL');
});
void test('property records retain co-owners, unavailable names and nonempty fallback addresses', () => {
  const p = parcelProperties(
    {
      Owner: 'Current Owner',
      Co_Owner: 'TEST PUBLIC ENTITY',
      Location_1: '',
      Location: '123 TEST ROAD',
      Parcel_ID: '00017',
    },
    REGIONS[1],
  );
  assert.equal(p.owner, 'TEST PUBLIC ENTITY');
  assert.equal(p.address, '123 TEST ROAD');
  assert.equal(p.id, '00017');
  assert.equal(
    parcelProperties({ ownname: 'A', ownname2: 'B' }, REGIONS[0]).owner,
    'A / B',
  );
  assert.equal(
    parcelProperties({ Owner: 'Current Owner' }, REGIONS[1]).owner,
    'Owner unavailable',
  );
});
void test('concurrent source requests coalesce and cached reads preserve acquisition time', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    return { fetchedAt: now };
  };
  await Promise.all([
    cached('test-coalesce', 60, fetcher),
    cached('test-coalesce', 60, fetcher),
  ]);
  const read = await cached('test-coalesce', 60, fetcher);
  assert.equal(calls, 1);
  assert.equal(read.cached, true);
  assert.equal(read.fetchedAt, now);
});
void test('provider errors are cooled down and do not cause a retry storm', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    throw new FeedError('Rate limited', 429, 60);
  };
  await assert.rejects(cached('test-failure', 60, fetcher));
  await assert.rejects(cached('test-failure', 60, fetcher));
  assert.equal(calls, 1);
});
void test('parcel queries reject excessive area and unsupported jurisdictions before networking', async () => {
  await assert.rejects(
    parcels('nc', { west: -80, south: 35, east: -79, north: 36 }),
    /Zoom closer/,
  );
  await assert.rejects(
    parcels('xx', { west: 0, south: 0, east: 0.01, north: 0.01 }),
    /supported/,
  );
});
