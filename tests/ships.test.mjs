import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShipService } from '../scripts/local/ship-service.mjs';
import {
  normalizeAisMessage,
  mergeShips,
} from '../scripts/local/ship-model.mjs';
import { SHIP_INTERVAL_MS } from '../scripts/local/ship-policy.mjs';
import { readShipKey } from '../scripts/local/ship-credential.mjs';

test('source credentials are consumed before child runtimes start, including when AISStream is disabled', async () => {
  const previousKey = process.env.AISSTREAM_API_KEY;
  const previousEnabled = process.env.AISSTREAM_ENABLED;
  try {
    process.env.AISSTREAM_API_KEY = ' placeholder ';
    process.env.AISSTREAM_ENABLED = 'true';
    assert.equal(await readShipKey(), 'placeholder');
    assert.equal(process.env.AISSTREAM_API_KEY, undefined);
    process.env.AISSTREAM_API_KEY = 'placeholder';
    process.env.AISSTREAM_ENABLED = 'false';
    assert.equal(await readShipKey(), '');
    assert.equal(process.env.AISSTREAM_API_KEY, undefined);
  } finally {
    if (previousKey === undefined) delete process.env.AISSTREAM_API_KEY;
    else process.env.AISSTREAM_API_KEY = previousKey;
    if (previousEnabled === undefined) delete process.env.AISSTREAM_ENABLED;
    else process.env.AISSTREAM_ENABLED = previousEnabled;
  }
});

const epoch = Date.UTC(2026, 8, 7, 12);
const report = (at = epoch, type = 'PositionReport', values = {}) => ({
  MessageType: type,
  MetaData: {
    MMSI: 123456789,
    ShipName: 'TEST SHIP',
    time_utc: new Date(at).toISOString(),
  },
  Message: {
    [type]: {
      Latitude: 35,
      Longitude: -75,
      Sog: 12,
      Cog: 90,
      TrueHeading: 100,
      Timestamp: 42,
      Valid: true,
      ...values,
    },
  },
});
function socketHarness(getMessages) {
  const sockets = [];
  return {
    sockets,
    factory: (_url, options) => {
      assert.equal(options.perMessageDeflate, true);
      const socket = new EventEmitter();
      socket.terminated = false;
      socket.terminate = () => {
        socket.terminated = true;
        socket.emit('close');
      };
      socket.send = (subscription) => {
        assert.equal(JSON.parse(subscription).BoundingBoxes.length, 1);
        socket.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              MessageType: 'SubscriptionConfirmation',
              Message: { CompressionEnabled: true },
            }),
          ),
        );
        for (const message of getMessages())
          socket.emit('message', Buffer.from(JSON.stringify(message)));
      };
      sockets.push(socket);
      setImmediate(() => socket.emit('open'));
      return socket;
    },
  };
}

test('AIS Class A and B positions preserve receiver time, course and heading independently', () => {
  for (const type of [
    'PositionReport',
    'StandardClassBPositionReport',
    'ExtendedClassBPositionReport',
  ]) {
    const row = normalizeAisMessage(report(epoch - 3000, type), epoch).position;
    assert.equal(row.observedAt, epoch - 3000);
    assert.equal(row.heading, 90);
    assert.equal(row.trueHeading, 100);
    assert.equal(row.source, 'AISStream');
  }
  const input = report();
  input.MetaData.time_utc = '2026-09-07 12:00:00.123456 +0000 UTC';
  assert.equal(
    normalizeAisMessage(input, epoch + 1000).position.observedAt,
    epoch + 123,
  );
  delete input.MetaData.time_utc;
  assert.equal(
    normalizeAisMessage(input, epoch).position.timestampBasis,
    'received',
  );
});

test('AIS validation rejects bad coordinates/times and does not invent missing movement', () => {
  for (const values of [
    { Latitude: 91 },
    { Longitude: 181 },
    { Latitude: null },
    { Valid: false },
  ])
    assert.equal(
      normalizeAisMessage(report(epoch, 'PositionReport', values), epoch),
      null,
    );
  assert.equal(normalizeAisMessage(report(epoch - 86400001), epoch), null);
  assert.equal(normalizeAisMessage(report(epoch + 60001), epoch), null);
  const row = normalizeAisMessage(
    report(epoch, 'PositionReport', { Sog: 102.3, Cog: 360, TrueHeading: 511 }),
    epoch,
  ).position;
  assert.equal(row.speed, null);
  assert.equal(row.heading, null);
  assert.equal(row.trueHeading, null);
  const staticData = normalizeAisMessage(
    report(epoch, 'ShipStaticData', {
      Name: 'NEW NAME',
      Destination: 'US NYC',
    }),
    epoch,
  );
  assert.equal(staticData.position, undefined);
  assert.equal(staticData.details.name, 'NEW NAME');
});

test('newest position wins across providers and old reports expire only when building a snapshot', () => {
  const latest = normalizeAisMessage(report(), epoch).position;
  const older = {
    ...latest,
    lat: 20,
    observedAt: epoch - 1000,
    source: 'Digitraffic',
  };
  const merged = mergeShips([latest], [older, latest], epoch, 100);
  assert.equal(merged.items.length, 1);
  assert.equal(merged.items[0].lat, 35);
  assert.equal(mergeShips([latest], [], epoch + 86400001, 100).items.length, 0);
});

test('one shared 30-second-style window per ten minutes publishes atomically and never streams markers', async () => {
  let now = epoch;
  const harness = socketHarness(() => [report(now)]);
  const service = new ShipService({
    key: 'placeholder',
    now: () => now,
    windowMs: 40,
    socketFactory: harness.factory,
    fallback: async () => ({ items: [] }),
  });
  const first = service.snapshot();
  const second = service.snapshot();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    service.published,
    null,
    'individual messages must not be published',
  );
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a.items, b.items);
  assert.equal(harness.sockets.length, 1);
  assert.ok(harness.sockets[0].terminated);
  assert.equal(a.items.length, 1);
  now += SHIP_INTERVAL_MS - 1;
  assert.deepEqual((await service.snapshot()).items, a.items);
  assert.equal(harness.sockets.length, 1);
  now++;
  await service.snapshot();
  assert.equal(harness.sockets.length, 2);
  assert.ok(!JSON.stringify(await service.snapshot()).includes('placeholder'));
  await service.close();
});

test('cooldown survives restart and failure retains a timestamped earlier position', async () => {
  let now = epoch;
  const folder = await mkdtemp(join(tmpdir(), 'openview-ship-test-'));
  const snapshotPath = join(folder, 'snapshot.json');
  const harness = socketHarness(() => [report(now)]);
  const first = new ShipService({
    key: 'placeholder',
    snapshotPath,
    now: () => now,
    windowMs: 10,
    socketFactory: harness.factory,
    fallback: async () => ({ items: [] }),
  });
  const saved = await first.snapshot();
  await first.close();
  const next = new ShipService({
    key: 'placeholder',
    snapshotPath,
    now: () => now,
    socketFactory: () => {
      throw Error('offline');
    },
    fallback: async () => {
      throw Error('offline');
    },
  });
  await next.initialize();
  assert.deepEqual((await next.snapshot()).items, saved.items);
  now += SHIP_INTERVAL_MS;
  const failed = await next.snapshot();
  assert.deepEqual(failed.items, saved.items);
  assert.equal(failed.items[0].observedAt, epoch);
  assert.match(failed.warning, /could not be opened/);
  assert.equal(failed.nextRefreshAt, now + SHIP_INTERVAL_MS);
  await next.close();
});

test('stopping during the disk checkpoint does not open an upstream connection', async () => {
  let releaseCheckpoint;
  const checkpoint = new Promise((resolve) => {
    releaseCheckpoint = resolve;
  });
  let connections = 0;
  const service = new ShipService({
    key: 'placeholder',
    now: () => epoch,
    socketFactory: () => {
      connections++;
      throw Error('unexpected');
    },
    fallback: async () => {
      connections++;
      return { items: [] };
    },
  });
  service.persist = () => checkpoint;
  const pending = service.snapshot();
  const stopped = service.close();
  releaseCheckpoint();
  await Promise.all([pending, stopped]);
  assert.equal(connections, 0);
  await assert.rejects(service.snapshot(), /stopped/);
});
