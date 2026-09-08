import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RadioData, RadioInspection, RadioBudget } from '../lib/radio-data';
import type { RadioFile, RadioNode, RadioMarker } from '../lib/radio-model';
import {
  DEFAULT_RADIO_FILTERS,
  matchesRadio,
  radioFilterError,
  intersectsRadio,
  validateRadioManifest,
  validateRadioNode,
  radioFrequency,
  type RadioGroup,
} from '../lib/radio-model';

const signal = () => new AbortController().signal;
const root = resolve('public/radio');
const fetchUrl = (input: RequestInfo | URL) =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
const assetFetch: typeof fetch = async (input) => {
  const path = fetchUrl(input).replace(/^\/radio\//, '');
  assert.ok(!path.includes('..'));
  try {
    return new Response(await readFile(resolve(root, path)), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    return new Response('missing', { status: 404 });
  }
};
const world = { west: -180, south: -90, east: 180, north: 90 };
const group: RadioGroup = {
  category: 'transmitters',
  source: 's',
  country: '',
  service: 'FM',
  status: 'unknown',
  frequency_mhz: null,
  frequency_upper_mhz: null,
  count: 1,
  lat: 1,
  lon: 2,
};
void test('radio inspection resumes after a summary budget boundary instead of rescanning forever', async () => {
  const summaryPages = Array.from({ length: 70 }, (_, i) => ({
    file: `summary/p${i}.json`,
    bytes: 1,
    sha256: 'a'.repeat(64),
  }));
  const recordPage = {
    file: 'records/p.json',
    bytes: 1,
    sha256: 'b'.repeat(64),
  };
  class LargeSummary extends RadioData {
    async node(
      _v: string,
      id: string,
      _s: AbortSignal,
      b: RadioBudget,
    ): Promise<RadioNode> {
      b.request();
      return {
        id,
        bounds: [-180, -90, 180, 90],
        children: [],
        summaryPages,
        recordPages: [recordPage],
      };
    }
    async page(
      _v: string,
      f: RadioFile,
      _s: AbortSignal,
      b: RadioBudget,
    ): Promise<unknown[]> {
      b.request();
      if (f.file === recordPage.file)
        return [
          {
            ...group,
            category: 'receivers',
            id: 'receivers:one',
            record_id: 'one',
          },
        ];
      return [
        {
          ...group,
          category:
            f.file === summaryPages[65].file ? 'receivers' : 'transmitters',
        },
      ];
    }
  }
  const marker: RadioMarker = {
    id: 'r:receivers',
    node: 'r',
    category: 'receivers',
    lat: 0,
    lon: 0,
    count: 1,
    bounds: [-180, -90, 180, 90],
  };
  const inspection = new RadioInspection(
    new LargeSummary(),
    'v1',
    marker,
    DEFAULT_RADIO_FILTERS,
  );
  const first = await inspection.next(signal());
  assert.equal(first.limited, true);
  assert.equal(first.records.length, 0);
  const next = await inspection.next(signal());
  assert.equal(next.records[0].id, 'receivers:one');
  assert.equal(next.more, false);
});
void test('radio filters keep unknown frequencies and countries explicit, match ranges by overlap', () => {
  assert.ok(matchesRadio(group, DEFAULT_RADIO_FILTERS));
  assert.ok(
    matchesRadio(group, {
      ...DEFAULT_RADIO_FILTERS,
      country: '',
      frequency: 'unknown',
    }),
  );
  assert.ok(!matchesRadio(group, { ...DEFAULT_RADIO_FILTERS, minMHz: '88' }));
  assert.ok(
    matchesRadio(
      { ...group, frequency_mhz: 88, frequency_upper_mhz: 108 },
      { ...DEFAULT_RADIO_FILTERS, minMHz: '100', maxMHz: '110' },
    ),
  );
  assert.ok(
    !matchesRadio(group, {
      ...DEFAULT_RADIO_FILTERS,
      categories: ['receivers'],
    }),
  );
  assert.match(
    radioFrequency({
      ...group,
      category: 'receivers',
      frequency_mhz: 100,
      frequency_upper_mhz: 200,
    }),
    /receive range/,
  );
  assert.ok(
    radioFilterError({
      ...DEFAULT_RADIO_FILTERS,
      minMHz: '120',
      maxMHz: '100',
    }),
  );
});
void test('radio spatial validation preserves dateline and poles and rejects traversal and bad bounds', () => {
  assert.ok(
    intersectsRadio([170, 80, 180, 90], {
      west: 175,
      south: 85,
      east: -175,
      north: 90,
    }),
  );
  assert.ok(
    intersectsRadio([-180, 80, -170, 90], {
      west: 175,
      south: 85,
      east: -175,
      north: 90,
    }),
  );
  assert.ok(
    !intersectsRadio([0, 80, 20, 90], {
      west: 175,
      south: 85,
      east: -175,
      north: 90,
    }),
  );
  assert.throws(() =>
    validateRadioNode(
      {
        id: 'r',
        bounds: [0, 0, 200, 90],
        children: [],
        summaryPages: [],
        recordPages: [],
      },
      'r',
    ),
  );
  assert.throws(() =>
    validateRadioNode(
      {
        id: 'r',
        bounds: [-180, -90, 180, 90],
        children: ['../r'],
        summaryPages: [],
        recordPages: [],
      },
      'r',
    ),
  );
});
void test('real radio release categories and exact aggregate counts survive prepared loading', async () => {
  const data = new RadioData(assetFetch),
    m = await data.manifest(signal());
  // Additive FCC snapshots must preserve the original selected sources.
  const baselineCounts = {
    fi_traficom: 3396,
    pl_uke: 4,
    cl_subtel: 9085,
    global_ourairports: 14490,
    global_hfcc: 3322,
    global_osm: 292,
    global_satnogs: 6190,
  };
  for (const [id, expected] of Object.entries(baselineCounts)) {
    const source = m.sources.find((item) => item.id === id)!;
    assert.equal(source.status, 'complete');
    assert.equal(
      ['transmitters', 'candidates', 'receivers'].reduce(
        (total, category) => total + (source.counts?.[category] || 0),
        0,
      ),
      expected,
    );
  }
  assert.equal(m.counts.receivers, 6190);
  assert.equal(m.sources.length, 24);
  for (const category of ['transmitters', 'candidates', 'receivers'] as const)
    assert.equal(
      m.counts[category],
      m.sources.reduce(
        (total, source) => total + (source.counts?.[category] || 0),
        0,
      ),
    );
  assert.throws(() =>
    validateRadioManifest({ ...m, counts: { ...m.counts, receivers: -1 } }),
  );
  const v = await data.view(m, world, 2, DEFAULT_RADIO_FILTERS, signal());
  assert.equal(v.limited, false);
  assert.equal(
    v.markers.reduce((s, p) => s + p.count, 0),
    Object.values(m.counts).reduce((total, count) => total + count, 0),
  );
  for (const category of ['transmitters', 'candidates', 'receivers'] as const)
    assert.equal(
      v.markers
        .filter((p) => p.category === category)
        .reduce((s, p) => s + p.count, 0),
      m.counts[category],
    );
  console.log(
    `Radio world view: ${v.requests} bounded files, ${v.bytes} uncompressed bytes, ${v.markers.length} display groups.`,
  );
  const unknown = await data.view(
    m,
    { west: -180, south: -90, east: -0.001, north: -0.001 },
    2,
    {
      ...DEFAULT_RADIO_FILTERS,
      categories: ['transmitters'],
      source: 'cl_subtel',
      frequency: 'unknown',
    },
    signal(),
  );
  assert.equal(
    unknown.markers.reduce((s, p) => s + p.count, 0),
    9085,
  );
  assert.equal(unknown.limited, false);
});
void test('radio inspection paginates real identities without duplicates and keeps receivers separate', async () => {
  const data = new RadioData(assetFetch),
    m = await data.manifest(signal());
  const f = { ...DEFAULT_RADIO_FILTERS, categories: ['receivers'] as const };
  const filters = { ...f, categories: [...f.categories] };
  const v = await data.view(m, world, 2, filters, signal());
  const marker = v.markers.find((p) => p.count > 100)!;
  const inspector = new RadioInspection(data, m.version, marker, filters);
  const rows = [];
  for (let page = 0; page < 20 && rows.length < 100; page++) {
    const next = await inspector.next(signal());
    assert.ok(next.records.length <= 50);
    rows.push(...next.records);
    if (!next.more) break;
  }
  assert.ok(rows.length >= 100);
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
  assert.ok(
    rows.every(
      (r) => r.category === 'receivers' && r.transmission_kind === 'receive',
    ),
  );
  assert.ok(rows.every((r) => r.coordinate_note && r.retrieved_at));
});
void test('radio missing assets, corrupted pages and cancelled responses are errors, never empty coverage', async () => {
  const real = new RadioData(assetFetch),
    m = await real.manifest(signal());
  const node = await real.node(m.version, 'r', signal(), new RadioBudget());
  const missing = new RadioData(
    async () => new Response('missing', { status: 404 }),
  );
  await assert.rejects(
    missing.view(m, world, 2, DEFAULT_RADIO_FILTERS, signal()),
    /HTTP 404/,
  );
  const broken = new RadioData(async () => new Response('[]'));
  await assert.rejects(
    broken.page(m.version, node.summaryPages[0], signal(), new RadioBudget()),
    /integrity/,
  );
  const controller = new AbortController();
  const cancelled = new RadioData(async (...args) => {
    controller.abort();
    return assetFetch(...args);
  });
  await assert.rejects(cancelled.manifest(controller.signal), {
    name: 'AbortError',
  });
});
void test('close radio view resolves actual points and inspection retains coincident record identities', async () => {
  const data = new RadioData(assetFetch),
    m = await data.manifest(signal());
  const v = await data.view(
    m,
    { west: 7.05, east: 7.15, south: 50.68, north: 50.75 },
    12,
    { ...DEFAULT_RADIO_FILTERS, categories: ['candidates'] },
    signal(),
  );
  assert.ok(v.markers.length > 0);
  assert.ok(v.markers.every((p) => p.recordIds?.length === p.count));
  const p = v.markers[0],
    inspector = new RadioInspection(data, m.version, p, {
      ...DEFAULT_RADIO_FILTERS,
      categories: ['candidates'],
    });
  const page = await inspector.next(signal());
  assert.deepEqual(
    page.records.map((r) => r.id).sort(),
    [...p.recordIds!].sort(),
  );
  console.log(
    `Radio close view: ${v.requests} bounded files, ${v.bytes} uncompressed bytes, ${v.markers.length} positions.`,
  );
});
