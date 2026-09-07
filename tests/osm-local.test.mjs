import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  downloadFile,
  parseRange,
  validatePbf,
  validateSourceUrl,
  sourceMetadata,
  verifyDownload,
} from '../scripts/local/osm-io.mjs';
import { OsmManager } from '../scripts/local/osm-manager.mjs';
import { createLocalServer, sameOrigin } from '../scripts/local/server.mjs';
import { osmProfile, importArguments } from '../scripts/local/osm-profile.mjs';
import { browserWorkerUrls } from '../scripts/check-browser-workers.mjs';

test('production worker validation rejects file addresses that crash layer activation', () => {
  assert.deepEqual(
    browserWorkerUrls('new Worker("/_next/static/osm-worker-Abc.js")'),
    ['/_next/static/osm-worker-Abc.js'],
  );
  assert.deepEqual(
    browserWorkerUrls(
      'new Worker(new URL("../space-worker-Abc.js", import.meta.url))',
    ),
    ['/_next/static/space-worker-Abc.js'],
  );
  for (const base of [
    'file:///_next/static/chunks/page.js',
    'https://other.example/page.js',
  ])
    assert.throws(
      () =>
        browserWorkerUrls(
          `new Worker(new URL("/_next/static/osm-worker-Abc.js", ${JSON.stringify(base)}))`,
        ),
      /Invalid browser worker address/,
    );
});

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'openview-osm-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
function pbf() {
  const data = Buffer.alloc(64);
  data.writeUInt32BE(13);
  data[4] = 10;
  data[5] = 9;
  data.write('OSMHeader', 6);
  data[15] = 24;
  data[16] = 1;
  return data;
}
function pmtiles() {
  const data = Buffer.alloc(512);
  data.write('PMTiles');
  data[7] = 3;
  data[99] = 1;
  data[101] = 14;
  return data;
}
test('official source allowlist excludes arbitrary URLs, history and URL credentials', () => {
  assert.match(
    validateSourceUrl(
      'https://download.geofabrik.de/europe/monaco-latest.osm.pbf',
    ),
    /monaco/,
  );
  for (const url of [
    'http://planet.openstreetmap.org/pbf/planet-latest.osm.pbf',
    'https://example.com/a.osm.pbf',
    'https://planet.openstreetmap.org/pbf/full-history/history-latest.osm.pbf',
    'https://download.geofabrik.de/a.osm.pbf?x=1',
  ])
    assert.throws(() => validateSourceUrl(url));
});
test('large-file metadata and byte offsets remain exact beyond 4 GiB', async () => {
  const size = 94612383571;
  const metadata = await sourceMetadata(
    'https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf',
    async () =>
      new Response(null, { headers: { 'Content-Length': String(size) } }),
  );
  assert.equal(metadata.bytes, size);
  assert.deepEqual(parseRange('bytes=5000000000-5000000099', size), {
    start: 5000000000,
    end: 5000000099,
  });
  for (const value of [
    'bytes=0-',
    'bytes=-1-2',
    'bytes=0-999999999',
    'bytes=2-1',
    'bytes=0-1,3-4',
  ])
    assert.throws(() => parseRange(value, size));
});
test('regional catalog preserves provider IDs and URLs, exposes names and ISO codes, and caches all regions', async (t) => {
  const root = await directory(t);
  const features = [
    {
      id: 'north-america',
      name: 'North America',
      urls: {
        pbf: 'https://download.geofabrik.de/north-america-latest.osm.pbf',
      },
    },
    {
      id: 'us/maryland',
      parent: 'north-america',
      name: 'us/maryland',
      'iso3166-2': ['US-MD'],
      urls: {
        pbf: 'https://download.geofabrik.de/north-america/us/maryland-latest.osm.pbf',
      },
    },
    {
      id: 'canada',
      name: 'Canada',
      'iso3166-1:alpha2': ['CA'],
      urls: {
        pbf: 'https://download.geofabrik.de/north-america/canada-latest.osm.pbf',
      },
    },
    {
      id: 'quebec',
      name: 'Québec',
      'iso3166-2': ['CA-QC'],
      urls: {
        pbf: 'https://download.geofabrik.de/north-america/canada/quebec-latest.osm.pbf',
      },
    },
    {
      id: 'japan',
      name: 'Japan',
      'iso3166-1:alpha2': ['JP'],
      urls: { pbf: 'https://download.geofabrik.de/asia/japan-latest.osm.pbf' },
    },
    {
      id: 'invalid',
      name: 'Invalid source',
      urls: { pbf: 'https://example.com/invalid.osm.pbf' },
    },
  ].map((properties) => ({ properties }));
  let catalogRequests = 0;
  const manager = new OsmManager(root, resolve('app'), {
    fetcher: async (url, options) => {
      if (options.method === 'HEAD') {
        assert.equal(url, features[1].properties.urls.pbf);
        return new Response(null, {
          headers: { 'Content-Length': '176000000' },
        });
      }
      assert.equal(url, 'https://download.geofabrik.de/index-v1-nogeom.json');
      catalogRequests++;
      return Response.json({ features });
    },
  });
  await manager.initialize();
  t.after(() => manager.close());
  const regions = await manager.regions();
  assert.equal(regions.length, 5);
  const maryland = regions.find((region) => region.id === 'us/maryland');
  assert.deepEqual(maryland, {
    id: 'us/maryland',
    name: 'Maryland',
    parent: 'North America / United States',
    codes: ['US-MD'],
    url: features[1].properties.urls.pbf,
  });
  assert.equal(
    regions.find((region) => region.id === 'quebec').parent,
    'North America / Canada',
  );
  assert.deepEqual(regions.find((region) => region.id === 'japan').codes, [
    'JP',
  ]);
  const preview = await manager.inspect('us/maryland');
  assert.equal(preview.name, 'Maryland');
  assert.equal(preview.bytes, 176000000);
  assert.equal(catalogRequests, 1);
  await assert.rejects(manager.inspect(''), /Choose a region/);
});
test('an empty regional catalog reports a retryable error instead of an empty browser', async (t) => {
  const manager = new OsmManager(await directory(t), resolve('app'), {
    fetcher: async () => Response.json({ features: [] }),
  });
  await assert.rejects(manager.regions(), /no downloadable regions/);
  assert.equal(manager.catalog, null);
});
test('download appends only a validated range of the same representation', async (t) => {
  const root = await directory(t),
    path = join(root, 'part');
  await writeFile(path, 'abc');
  await downloadFile({
    url: 'https://example.invalid/source',
    path,
    bytes: 6,
    etag: '"v1"',
    fetcher: async (_url, options) => {
      assert.equal(options.headers.Range, 'bytes=3-');
      assert.equal(options.headers['If-Range'], '"v1"');
      return new Response('def', {
        status: 206,
        headers: { 'Content-Range': 'bytes 3-5/6', 'Content-Length': '3' },
      });
    },
  });
  assert.equal(await readFile(path, 'utf8'), 'abcdef');
});
test('download restarts instead of appending when If-Range returns a full response', async (t) => {
  const path = join(await directory(t), 'part');
  await writeFile(path, 'old');
  await downloadFile({
    url: 'https://example.invalid/source',
    path,
    bytes: 6,
    etag: '"old"',
    fetcher: async () =>
      new Response('newnew', { headers: { 'Content-Length': '6' } }),
  });
  assert.equal(await readFile(path, 'utf8'), 'newnew');
});
test('download rejects incorrect ranges and oversize streaming responses', async (t) => {
  const path = join(await directory(t), 'part');
  await writeFile(path, 'abc');
  await assert.rejects(
    downloadFile({
      url: 'https://example.invalid/source',
      path,
      bytes: 6,
      etag: '"a"',
      fetcher: async () =>
        new Response('xyz', {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-2/6' },
        }),
    }),
    /range/,
  );
  assert.equal(await readFile(path, 'utf8'), 'abc');
  await assert.rejects(
    downloadFile({
      url: 'https://example.invalid/source',
      path,
      bytes: 2,
      fetcher: async () => new Response('too long'),
    }),
    /exceeded/,
  );
});
test('a corrupt download is removed and never promoted to a source', async (t) => {
  const path = join(await directory(t), 'part');
  await writeFile(path, 'bad');
  await assert.rejects(verifyDownload(path, '0'.repeat(32), 'md5'), /checksum/);
  await assert.rejects(stat(path), /ENOENT/);
});
test('local PBF registration validates headers and removal preserves the supplied original', async (t) => {
  const root = await directory(t),
    path = join(root, 'my map.osm.pbf');
  await writeFile(path, pbf());
  const manager = new OsmManager(join(root, 'library'), resolve('.'));
  await manager.initialize();
  const dataset = await manager.addLocal(path);
  assert.equal(dataset.status, 'downloaded');
  assert.equal(dataset.enabled, false);
  assert.equal((await manager.addLocal(path)).id, dataset.id);
  await assert.rejects(manager.enable(dataset.id, true), /Prepare/);
  await manager.remove(dataset.id);
  assert.equal((await stat(path)).size, 64);
  await writeFile(path, '<html>not PBF</html>');
  await assert.rejects(validatePbf(path), /header/);
});
test('interrupted jobs are recovered without enabling unfinished data', async (t) => {
  const root = await directory(t),
    manager = new OsmManager(root, resolve('.'));
  await manager.initialize();
  manager.state.datasets = [
    { id: randomUUID(), status: 'preparing', enabled: true },
  ];
  await manager.save();
  const restarted = new OsmManager(root, resolve('.'));
  await restarted.initialize();
  assert.equal(restarted.state.datasets[0].status, 'interrupted');
  assert.equal(restarted.state.datasets[0].enabled, false);
});
test('preparation publishes only validated tiles and enables at most one dataset', async (t) => {
  const root = await directory(t),
    path = join(root, 'input.osm.pbf');
  await writeFile(path, pbf());
  const manager = new OsmManager(join(root, 'library'), resolve('.'), {
    ensureTools: async () => ({ java: 'fake-java', jar: 'fake.jar' }),
    runProcess: async (_command, args) => {
      await writeFile(
        args.find((a) => a.startsWith('--output=')).slice(9),
        pmtiles(),
      );
    },
  });
  await manager.initialize();
  const first = await manager.addLocal(path);
  manager.start(first.id, 'prepare');
  await manager.active.promise;
  assert.equal(first.status, 'ready', first.message);
  assert.equal(first.enabled, false);
  await manager.enable(first.id, true);
  const secondPath = join(root, 'other.osm.pbf');
  await writeFile(secondPath, pbf());
  const second = await manager.addLocal(secondPath);
  manager.start(second.id, 'prepare');
  await manager.active.promise;
  await manager.enable(second.id, true);
  assert.equal(first.enabled, false);
  assert.equal(second.enabled, true);
});
test('failed conversion preserves the source and records an actionable error', async (t) => {
  const root = await directory(t),
    path = join(root, 'input.osm.pbf');
  await writeFile(path, pbf());
  const manager = new OsmManager(join(root, 'library'), resolve('.'), {
    ensureTools: async () => {
      throw new Error('Tool download unavailable');
    },
  });
  await manager.initialize();
  const dataset = await manager.addLocal(path);
  manager.start(dataset.id, 'prepare');
  await manager.active.promise;
  assert.equal(dataset.status, 'error');
  assert.match(dataset.message, /Tool download/);
  assert.equal((await stat(path)).size, 64);
});
test('local service rejects foreign origins and unauthorized writes and streams bounded tiles', async (t) => {
  const root = await directory(t),
    manager = new OsmManager(root, resolve('.'));
  await manager.initialize();
  const id = randomUUID(),
    path = join(root, 'map.pmtiles');
  await writeFile(path, pmtiles());
  manager.state.datasets.push({
    id,
    status: 'ready',
    enabled: true,
    tilesPath: path,
    tilesBytes: 512,
    prepared: 'test',
  });
  const server = createLocalServer(manager, 1);
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal(
    (
      await fetch(`${base}/local-osm/status`, {
        headers: { Origin: 'https://foreign.example' },
      })
    ).status,
    403,
  );
  assert.equal(
    sameOrigin({ headers: { host: 'malicious.example:8787' } }),
    false,
  );
  const status = await (await fetch(`${base}/local-osm/status`)).json();
  assert.equal(status.nonce.length, 64);
  assert.equal(
    (
      await fetch(`${base}/local-osm/enable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, enabled: false }),
      })
    ).status,
    403,
  );
  const tile = await fetch(`${base}/local-osm/tiles/${id}.pmtiles`, {
    headers: { Range: 'bytes=0-126' },
  });
  assert.equal(tile.status, 206);
  assert.equal((await tile.arrayBuffer()).byteLength, 127);
  assert.equal(
    (await fetch(`${base}/local-osm/tiles/${id}.pmtiles`)).status,
    416,
  );
  const enabled = await fetch(`${base}/local-osm/enable`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-OpenView-Local': status.nonce,
    },
    body: JSON.stringify({ id, enabled: false }),
  });
  assert.equal(enabled.status, 200);
  assert.equal(
    (
      await fetch(`${base}/local-osm/tiles/${id}.pmtiles`, {
        headers: { Range: 'bytes=0-126' },
      })
    ).status,
    400,
  );
});
test('converter uses the OSM-only profile and disk-backed node/multipolygon indexes', () => {
  const profile = osmProfile('D:\\Maps\\planet.osm.pbf');
  assert.equal(profile.sources.osm.local_path, 'D:\\Maps\\planet.osm.pbf');
  assert.equal(profile.sources.osm.url, undefined);
  assert.equal(profile.layers.length, 6);
  const args = importArguments(
    'converter.jar',
    'source.osm.pbf',
    'out.pmtiles',
    'schema.yml',
    'tmp',
    2048,
    2,
  );
  assert.ok(args.includes('--nodemap-storage=mmap'));
  assert.ok(args.includes('--multipolygon-geometry-storage=mmap'));
  assert.ok(args.includes('--download=false'));
  assert.ok(args.includes('-Xmx2048m'));
});

test('PBF header fields may appear in any protobuf field order', async (t) => {
  const path = join(await directory(t), 'reordered.osm.pbf');
  const bytes = pbf();
  bytes[4] = 24;
  bytes[5] = 1;
  bytes[6] = 10;
  bytes[7] = 9;
  bytes.write('OSMHeader', 8);
  await writeFile(path, bytes);
  assert.equal((await validatePbf(path)).size, 64);
});

test('cancelled streaming downloads keep a usable partial file for later resume', async (t) => {
  const path = join(await directory(t), 'partial');
  const controller = new AbortController();
  const download = downloadFile({
    url: 'https://example.invalid/source',
    path,
    bytes: 100,
    etag: '"stable"',
    signal: controller.signal,
    fetcher: async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode('hello'));
          },
        }),
      ),
    progress: () => {
      setTimeout(() => controller.abort(), 20);
    },
  });
  await assert.rejects(download, /abort/i);
  assert.equal(await readFile(path, 'utf8'), 'hello');
});

test('stopping preparation leaves a retryable registration and the original source', async (t) => {
  const root = await directory(t),
    path = join(root, 'input.osm.pbf');
  await writeFile(path, pbf());
  const manager = new OsmManager(join(root, 'library'), resolve('.'), {
    ensureTools: async () => ({ java: 'fake', jar: 'fake' }),
    runProcess: async (_command, _args, { signal }) =>
      new Promise((_ok, reject) => {
        if (signal.aborted) reject(new Error('Aborted'));
        else
          signal.addEventListener('abort', () => reject(new Error('Aborted')), {
            once: true,
          });
      }),
  });
  await manager.initialize();
  const dataset = await manager.addLocal(path);
  manager.start(dataset.id, 'prepare');
  await manager.pause(dataset.id);
  assert.equal(dataset.status, 'interrupted');
  assert.equal(manager.active, null);
  assert.equal((await stat(path)).size, 64);
});
