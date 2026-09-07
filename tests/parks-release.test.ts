import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ParkArchive, parkHash } from '../lib/park-data';
import { parseParkManifest, parseParkRecords } from '../lib/park-model';

const root = resolve(process.cwd(), 'public/parks');
const fetchUrl = (input: RequestInfo | URL) =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
void test('prepared park release preserves scope, original identities, coverage and artifact integrity', async () => {
  const manifest = parseParkManifest(
    JSON.parse(readFileSync(resolve(root, 'latest.json'), 'utf8')),
  );
  for (const layer of manifest.layers) {
    const data = new Uint8Array(
      readFileSync(resolve(root, manifest.release, layer.file)),
    );
    assert.equal(data.length, layer.bytes);
    assert.equal(await parkHash(data), layer.sha256);
    const metadata = new Uint8Array(
      readFileSync(resolve(root, manifest.release, layer.records.file)),
    );
    assert.equal(metadata.length, layer.records.bytes);
    assert.equal(await parkHash(metadata), layer.records.sha256);
    const records = parseParkRecords(
      JSON.parse(new TextDecoder().decode(metadata)),
      layer,
    );
    if (layer.id === 'national') {
      assert.equal(records.size, 63);
      assert.equal(
        [...records.values()].reduce((n, r) => n + r.sourceIds.length, 0),
        70,
      );
      assert.deepEqual(records.get('nps:yell')?.states, ['ID', 'MT', 'WY']);
      assert.deepEqual(records.get('nps:npsa')?.states, ['AS']);
      assert.equal(records.get('nps:dena')?.sourceIds.length, 2);
      assert.ok(records.has('nps:neri'));
      assert.ok(!records.has('nps:wotr'));
    } else {
      assert.equal(records.size, 6169);
      const states = new Set([...records.values()].flatMap((r) => r.states));
      for (const state of 'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR VI'.split(
        ' ',
      ))
        assert.ok(states.has(state), state);
      for (const r of records.values()) {
        const s = r.sourceDetails!;
        assert.equal(r.designation, 'State Park');
        assert.equal(s.Des_Tp, 'SP');
        assert.ok(
          ['STAT', 'TERR'].includes(String(s.Mang_Type)) ||
            (s.Mang_Type === 'UNK' &&
              ['STAT', 'TERR'].includes(String(s.Own_Type))),
          r.id,
        );
      }
      assert.equal(
        records.get('padus-4.1-223795')?.sourceDetails?.Mang_Type,
        'UNK',
      );
    }
  }
});

void test('actual prepared vector tiles identify parks across states, Alaska, Hawaii and territories', async () => {
  const manifest = parseParkManifest(
    JSON.parse(readFileSync(resolve(root, 'latest.json'), 'utf8')),
  );
  const assets = new Map(
    manifest.layers.map((layer) => [
      `/parks/${manifest.release}/${layer.file}`,
      new Uint8Array(readFileSync(resolve(root, manifest.release, layer.file))),
    ]),
  );
  const old = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const data = assets.get(fetchUrl(url));
    assert.ok(data, 'Requests must use the selected local park archives only');
    const match = new Headers(options?.headers)
      .get('range')
      ?.match(/^bytes=(\d+)-(\d+)$/);
    assert.ok(match);
    const start = Number(match[1]),
      end = Number(match[2]);
    return new Response(data.slice(start, end + 1), {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${end}/${data.length}` },
    });
  };
  const archives = manifest.layers.map(
    (layer) =>
      new ParkArchive(`/parks/${manifest.release}/${layer.file}`, layer),
  );
  try {
    const national = archives.find((a) => a.layer.id === 'national')!,
      state = archives.find((a) => a.layer.id === 'state')!;
    await Promise.all(archives.map((a) => a.ready()));
    const samples: [ParkArchive, number, number, string][] = [
      [national, -110.5, 44.6, 'nps:yell'],
      [national, -155.286, 19.415, 'nps:havo'],
      [national, -170.686, -14.254, 'nps:npsa'],
      [national, -64.747, 18.344, 'nps:viis'],
      [national, -152.32801452468755, 62.545363506091945, 'nps:dena'],
      [national, -81.04326432840986, 37.89658688254645, 'nps:neri'],
      [state, -116.17834604368545, 33.31421037650947, 'padus-4.1-192846'],
      [state, -75.63357829443581, 35.962595607490954, 'padus-4.1-223795'],
      [state, -103.41882702601205, 43.74215484171141, 'padus-4.1-264305'],
      [state, -77.96726832032228, 42.65615552592723, 'padus-4.1-246519'],
      [state, -149.03061022358227, 61.21143427462788, 'padus-4.1-174774'],
      [state, -155.15369416396254, 19.854731663995448, 'padus-4.1-204318'],
      [state, -66.15859550315467, 17.948786352556848, 'padus-4.1-260859'],
      [state, -64.94038315464843, 18.35770990953367, 'padus-4.1-280295'],
    ];
    for (const [archive, lon, lat, id] of samples)
      assert.ok((await archive.identify(lon, lat)).includes(id), id);
    assert.deepEqual(
      await national.identify(-77.265, 38.938),
      [],
      'Wolf Trap is not a National Park designation',
    );
    const before = state.metrics.requests;
    await state.identify(-64.94038315464843, 18.35770990953367);
    assert.equal(
      state.metrics.requests,
      before,
      'Repeat clicks reuse bounded cached tiles',
    );
    assert.ok(
      state.metrics.rangeBytes < state.layer.bytes / 2,
      'Representative clicks do not download the nationwide archive',
    );
  } finally {
    archives.forEach((a) => a.close());
    globalThis.fetch = old;
  }
});

void test('park archives tolerate checksum-verified HTTP 200 responses when the host ignores byte ranges', async () => {
  const manifest = parseParkManifest(
    JSON.parse(readFileSync(resolve(root, 'latest.json'), 'utf8')),
  );
  const assets = new Map(
    manifest.layers.map((layer) => [
      `/parks/${manifest.release}/${layer.file}`,
      new Uint8Array(readFileSync(resolve(root, manifest.release, layer.file))),
    ]),
  );
  const old = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const data = assets.get(fetchUrl(url));
    assert.ok(data, 'Requests must use the selected local park archives only');
    assert.match(new Headers(options?.headers).get('range') ?? '', /^bytes=/);
    return new Response(data, {
      status: 200,
      headers: { 'content-length': String(data.length) },
    });
  };
  const archives = manifest.layers.map(
    (layer) =>
      new ParkArchive(`/parks/${manifest.release}/${layer.file}`, layer),
  );
  try {
    await Promise.all(archives.map((archive) => archive.ready()));
    const national = archives.find(
        (archive) => archive.layer.id === 'national',
      )!,
      state = archives.find((archive) => archive.layer.id === 'state')!;
    assert.ok((await national.identify(-110.5, 44.6)).includes('nps:yell'));
    assert.ok(
      (await state.identify(-155.15369416396254, 19.854731663995448)).includes(
        'padus-4.1-204318',
      ),
    );
    for (const archive of archives) {
      assert.equal(archive.metrics.requests, 1);
      assert.equal(archive.metrics.rangeBytes, archive.layer.bytes);
    }
  } finally {
    archives.forEach((archive) => archive.close());
    globalThis.fetch = old;
  }
});
