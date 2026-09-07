import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RadioData, RadioInspection } from '../lib/radio-data';
import {
  DEFAULT_RADIO_FILTERS,
  matchesRadio,
  validateRadioManifest,
  type RadioGroup,
} from '../lib/radio-model';
import { parkMayPick } from '../lib/park-model';

const world = { west: -180, south: -90, east: 180, north: 90 };
const signal = () => new AbortController().signal;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const fetchUrl = (input: RequestInfo | URL) =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
const fixture = () => {
  const files = new Map<string, string>();
  const put = (file: string, value: unknown) => {
    const text = JSON.stringify(value);
    files.set(file, text);
    return { file, bytes: Buffer.byteLength(text), sha256: sha(text) };
  };
  const rows = [
    ['plmn:310:010', 'LTE'],
    ['plmn:310:010', 'NR'],
    ['plmn:310:999', 'LTE'],
  ].map(([network, service], i) => ({
    category: 'candidates',
    source: 'global_opencellid',
    country: null,
    status: 'unknown',
    network,
    service,
    frequency_mhz: null,
    frequency_upper_mhz: null,
    lat: 40,
    lon: -74,
    id: `candidates:${i}`,
    record_id: String(i),
    source_record_id: `${service}:310:${network.slice(-3)}:123:${BigInt('9007199254740993') + BigInt(i)}`,
    cell: { cell: String(BigInt('9007199254740993') + BigInt(i)) },
  }));
  const summary = put(
    'summary/r.json',
    rows.map((r) => ({ ...r, count: 1 })),
  );
  const records = put('records/r0.json', rows);
  put('nodes/r.json', {
    id: 'r',
    bounds: [-180, -90, 180, 90],
    children: ['r0'],
    summaryPages: [summary],
    recordPages: [],
  });
  put('nodes/r0.json', {
    id: 'r0',
    bounds: [-180, -90, 180, 90],
    children: [],
    summaryPages: [summary],
    recordPages: [records],
  });
  const manifest = {
    schemaVersion: 1,
    version: 'fixture',
    createdAt: '2026-09-06T20:00:00Z',
    counts: { transmitters: 0, candidates: 3, receivers: 0 },
    sources: [],
    facets: {
      sources: ['global_opencellid'],
      countries: [''],
      statuses: ['unknown'],
      services: ['LTE', 'NR'],
      networks: ['plmn:310:010', 'plmn:310:999'],
    },
    datasetKind: 'cell-locations',
    networkLabels: {
      'plmn:310:010': 'Test assignee · 310-010',
      'plmn:310:999': 'MCC 310 / MNC 999',
    },
  };
  const m = put('manifest.json', manifest);
  const pointer = JSON.stringify({
    schemaVersion: 1,
    version: 'fixture',
    manifest: 'versions/fixture/manifest.json',
    sha256: m.sha256,
  });
  const fetcher: typeof fetch = async (input) => {
    const url = fetchUrl(input);
    const text = url.endsWith('/latest.json')
      ? pointer
      : files.get(url.replace(/^\/(?:radio|cells)\/versions\/fixture\//, ''));
    return new Response(text || 'missing', { status: text ? 200 : 404 });
  };
  return { files, fetcher, manifest, rows };
};
void test('cell network and technology filters agree in summaries, close views and inspection', async () => {
  const f = fixture(),
    data = new RadioData(f.fetcher, '/cells'),
    m = await data.manifest(signal());
  for (const [network, service, count] of [
    ['*', '*', 3],
    ['plmn:310:010', '*', 2],
    ['plmn:310:010', 'NR', 1],
    ['plmn:310:999', 'LTE', 1],
  ] as const) {
    const filters = { ...DEFAULT_RADIO_FILTERS, network, service };
    const far = await data.view(m, world, 0, filters, signal());
    const near = await data.view(m, world, 12, filters, signal());
    assert.equal(
      far.markers.reduce((n, p) => n + p.count, 0),
      count,
    );
    assert.equal(
      near.markers.reduce((n, p) => n + p.count, 0),
      count,
    );
    for (const view of [far, near]) {
      const page = await new RadioInspection(
        data,
        m.version,
        view.markers[0],
        filters,
      ).next(signal());
      assert.equal(page.records.length, count);
      assert.ok(page.records.every((r) => matchesRadio(r, filters)));
      assert.equal(typeof page.records[0].cell!.cell, 'string');
    }
  }
  assert.equal(
    (
      await new RadioInspection(
        data,
        m.version,
        (
          await data.view(m, world, 0, DEFAULT_RADIO_FILTERS, signal())
        ).markers[0],
        DEFAULT_RADIO_FILTERS,
      ).next(signal())
    ).records[0].cell!.cell,
    '9007199254740993',
  );
  assert.equal(parkMayPick('cells'), false);
});
void test('independent cell and radio caches isolate failures and retain valid cached pages', async () => {
  const f = fixture();
  let broken = false;
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = fetchUrl(input);
    calls.push(url);
    return broken && url.startsWith('/cells/')
      ? new Response('error', { status: 503 })
      : f.fetcher(input, init);
  };
  const radio = new RadioData(fetcher),
    cells = new RadioData(fetcher, '/cells');
  const rm = await radio.manifest(signal()),
    cm = await cells.manifest(signal());
  await cells.view(cm, world, 0, DEFAULT_RADIO_FILTERS, signal());
  broken = true;
  await assert.rejects(cells.manifest(signal()), /503/);
  assert.equal(
    (await cells.view(cm, world, 0, DEFAULT_RADIO_FILTERS, signal())).markers[0]
      .count,
    3,
  );
  assert.equal(
    (await radio.view(rm, world, 0, DEFAULT_RADIO_FILTERS, signal())).markers[0]
      .count,
    3,
  );
  assert.ok(calls.includes('/radio/versions/fixture/nodes/r.json'));
  assert.ok(calls.includes('/cells/versions/fixture/nodes/r.json'));
});
void test('cell checksum failures and invalid network facets are rejected', async () => {
  const f = fixture(),
    data = new RadioData(f.fetcher, '/cells'),
    m = await data.manifest(signal());
  f.files.set('summary/r.json', f.files.get('summary/r.json') + ' ');
  await assert.rejects(
    data.view(m, world, 0, DEFAULT_RADIO_FILTERS, signal()),
    /integrity/,
  );
  assert.throws(() =>
    validateRadioManifest({
      ...f.manifest,
      facets: { ...f.manifest.facets, networks: ['../unsafe'] },
    }),
  );
  assert.ok(
    matchesRadio(
      { ...f.rows[0], network: undefined } as unknown as RadioGroup,
      { ...DEFAULT_RADIO_FILTERS, network: '' },
    ),
  );
});
void test('real cell and previous radio releases remain independent and readable', async () => {
  const fetcher: typeof fetch = async (input) =>
    new Response(await readFile(resolve('public', `.${fetchUrl(input)}`)));
  const radio = await new RadioData(fetcher).manifest(signal());
  const data = new RadioData(fetcher, '/cells'),
    cells = await data.manifest(signal());
  assert.equal(radio.version, 'radio-42b565087e93ae452711');
  assert.deepEqual(radio.counts, {
    transmitters: 30297,
    candidates: 292,
    receivers: 6190,
  });
  assert.equal(cells.datasetKind, 'cell-locations');
  assert.equal(cells.counts.candidates, 694839);
  const view = await data.view(
    cells,
    world,
    0,
    DEFAULT_RADIO_FILTERS,
    signal(),
  );
  assert.equal(view.limited, false);
  assert.equal(
    view.markers.reduce((n, p) => n + p.count, 0),
    694839,
  );
});
