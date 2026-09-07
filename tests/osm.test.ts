import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PbfWriter } from 'pbf';
import {
  OSM_LAYERS,
  OSM_LIMITS,
  OsmTileCache,
  osmTile,
  osmVisibleLayers,
  osmRegionMatches,
  OSM_CATEGORIES,
  OSM_GROUPS,
  osmCategoryMatches,
  osmLayerMatches,
} from '../lib/osm-model';
import { osmGeometryCounts } from '../lib/osm-geometry-budget';
import { osmFeatureInfo, osmGeometryHit } from '../lib/osm-pick';
import { paintOsmTile } from '../lib/osm-render';
void test('regional search accepts subdivision codes, accents and multi-part locations', () => {
  const maryland = {
    id: 'us/maryland',
    name: 'Maryland',
    parent: 'North America / United States',
    codes: ['US-MD'],
    url: '',
  };
  for (const query of [
    'MD',
    'US-MD',
    'Maryland',
    ' maryLAND ',
    'United States Maryland',
  ])
    assert.equal(osmRegionMatches(maryland, query), true, query);
  for (const query of ['DE', 'no such region'])
    assert.equal(osmRegionMatches(maryland, query), false, query);
  assert.equal(
    osmRegionMatches(
      {
        id: 'ile-de-france',
        name: 'Île-de-France',
        parent: 'Europe / France',
        url: '',
      },
      'ile de france',
    ),
    true,
  );
  assert.equal(
    osmRegionMatches(
      {
        id: 'quebec',
        name: 'Québec',
        parent: 'North America / Canada',
        codes: ['CA-QC'],
        url: '',
      },
      'QC',
    ),
    true,
  );
  assert.equal(
    osmRegionMatches(
      { id: 'japan', name: 'Japan', parent: 'Asia', codes: ['JP'], url: '' },
      'JP',
    ),
    true,
  );
});
function vectorTile(
  name: string,
  type: number,
  geometry: number[],
  featureCount = 1,
  properties: Record<string, string> = {
    family:
      name === 'buildings'
        ? 'building'
        : name === 'details'
          ? 'amenity'
          : 'highway',
    class: name === 'buildings' ? 'yes' : 'cafe',
  },
) {
  const out = new PbfWriter();
  out.writeMessage(
    3,
    (_: null, layer: PbfWriter) => {
      layer.writeStringField(1, name);
      layer.writeVarintField(5, 4096);
      layer.writeVarintField(15, 2);
      const entries = Object.entries(properties);
      for (const [key, value] of entries) {
        layer.writeStringField(3, key);
        layer.writeMessage(
          4,
          (_: null, val: PbfWriter) => val.writeStringField(1, value),
          null,
        );
      }
      for (let index = 0; index < featureCount; index++)
        layer.writeMessage(
          2,
          (_: null, f: PbfWriter) => {
            f.writePackedVarint(
              2,
              entries.flatMap((_entry, index) => [index, index]),
            );
            f.writeVarintField(3, type);
            f.writePackedVarint(4, geometry);
          },
          null,
        );
    },
    null,
  );
  return Uint8Array.from(out.finish()).buffer;
}
void test('OSM detail becomes visible only at the configured map scales', () => {
  assert.ok(!osmVisibleLayers([...OSM_LAYERS], 15).includes('buildings'));
  assert.ok(osmVisibleLayers([...OSM_LAYERS], 16).includes('buildings'));
  assert.ok(!osmVisibleLayers([...OSM_LAYERS], 16).includes('amenities'));
  assert.ok(osmVisibleLayers([...OSM_LAYERS], 17).includes('amenities'));
  assert.deepEqual(osmVisibleLayers([], 19), []);
});
void test('an oversized OSM tile is omitted without preventing the next tile from rendering', () => {
  const calls: string[] = [];
  const context = new Proxy(
    {},
    {
      get:
        (_target, key) =>
        (..._args: unknown[]) => {
          calls.push(String(key));
        },
      set: () => true,
    },
  );
  const canvas = { getContext: () => context } as unknown as OffscreenCanvas;
  const dense = vectorTile('details', 1, [9, 0, 0], 30001);
  assert.ok(dense.byteLength < OSM_LIMITS.tileBytes);
  assert.deepEqual(paintOsmTile(canvas, dense, 17, 0, 0, 14, ['amenities']), {
    limited: true,
    features: 0,
    vertices: 0,
  });
  assert.deepEqual(
    paintOsmTile(
      canvas,
      new ArrayBuffer(OSM_LIMITS.tileBytes + 1),
      17,
      0,
      0,
      14,
      ['amenities'],
    ),
    { limited: true, features: 0, vertices: 0 },
  );
  const small = vectorTile('details', 1, [9, 0, 0]);
  assert.equal(
    paintOsmTile(canvas, small, 17, 0, 0, 14, ['amenities']).vertices,
    1,
  );
  assert.ok(calls.includes('arc'));
});
void test('OSM overzoom addresses the correct parent and child quadrant', () => {
  assert.deepEqual(osmTile(17, 65, 71, 14), {
    z: 14,
    x: 8,
    y: 8,
    scale: 8,
    dx: 1,
    dy: 7,
  });
  for (const args of [
    [-1, 0, 0, 14],
    [16, -1, 0, 14],
    [16, 0, 65536, 14],
    [30, 0, 0, 14],
  ])
    assert.throws(() => osmTile(...(args as [number, number, number, number])));
});
void test('OSM byte cache stays bounded and evicts least recently used tiles', () => {
  const cache = new OsmTileCache(12);
  cache.set('a', new ArrayBuffer(4));
  cache.set('b', new ArrayBuffer(4));
  cache.get('a');
  cache.set('c', new ArrayBuffer(8));
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.bytes, 12);
  cache.set('huge', new ArrayBuffer(13));
  assert.equal(cache.bytes, 12);
  assert.equal(cache.get('huge'), undefined);
  cache.set('a', new ArrayBuffer(1));
  assert.equal(cache.bytes, 9);
});
void test('OSM geometry counts reject allocation bombs before constructing points', () => {
  const huge = vectorTile('buildings', 3, [
    9,
    0,
    0,
    (OSM_LIMITS.vertices + 100) * 8 + 7,
  ]);
  assert.ok(osmGeometryCounts(huge).buildings[0] > OSM_LIMITS.vertices);
  assert.throws(
    () => osmGeometryCounts(vectorTile('roads', 2, [8, 0, 0])),
    /command/,
  );
});
void test('OSM rendering draws building rings only at detail zoom and skips oversized geometry', () => {
  const calls: string[] = [];
  const context = new Proxy(
    {},
    {
      get:
        (_target, key) =>
        (..._args: unknown[]) => {
          calls.push(String(key));
        },
      set: () => true,
    },
  );
  const canvas = { getContext: () => context } as unknown as OffscreenCanvas;
  const bytes = vectorTile(
    'buildings',
    3,
    [9, 2000, 2000, 18, 1000, 0, 0, 1000, 15],
  );
  paintOsmTile(canvas, bytes, 15, 0, 0, 14, ['buildings']);
  assert.ok(!calls.includes('fill'));
  calls.length = 0;
  const result = paintOsmTile(canvas, bytes, 16, 0, 0, 14, ['buildings']);
  assert.ok(calls.includes('fill'));
  assert.equal(result.vertices, 4);
  const huge = vectorTile('buildings', 3, [
    9,
    0,
    0,
    (OSM_LIMITS.vertices + 100) * 8 + 7,
  ]);
  calls.length = 0;
  assert.equal(
    paintOsmTile(canvas, huge, 16, 0, 0, 14, ['buildings']).limited,
    true,
  );
  assert.ok(!calls.includes('fill'));
});
void test('every imported category is exposed once and multi-tag features can be selected independently', () => {
  assert.deepEqual(
    OSM_GROUPS.flatMap((group) => group.ids).sort(),
    [...OSM_LAYERS].sort(),
  );
  const shops = OSM_CATEGORIES.find((category) => category.id === 'shops')!;
  assert.equal(
    osmCategoryMatches(
      shops,
      'details',
      { family: 'amenity', class: 'cafe', shop: 'bakery' },
      1,
      17,
    ),
    true,
  );
  assert.equal(
    osmCategoryMatches(
      shops,
      'details',
      { family: 'shop', class: 'bakery' },
      1,
      17,
    ),
    true,
  );
  assert.equal(
    osmCategoryMatches(
      shops,
      'details',
      { family: 'amenity', class: 'cafe' },
      1,
      17,
    ),
    false,
  );
  assert.equal(
    osmCategoryMatches(shops, 'details', { shop: 'bakery' }, 1, 16),
    false,
  );
  assert.equal(osmLayerMatches('roads', 'trails'), true);
  assert.equal(osmLayerMatches('telecom', 'telecom'), true);
});
void test('selecting shops excludes unrelated amenities from painting and picking', () => {
  const context = new Proxy({}, { get: () => () => {}, set: () => true });
  const canvas = { getContext: () => context } as unknown as OffscreenCanvas;
  const bytes = vectorTile('details', 1, [9, 100, 100], 1, {
    family: 'shop',
    class: 'bakery',
    ov_id: '1234',
    ov_type: 'node',
    ov_tags: 'shop=bakery\nname=Local Bakery',
  });
  const pick = {
    x: 25,
    y: 25,
    features: [] as ReturnType<typeof osmFeatureInfo>[],
  };
  assert.equal(
    paintOsmTile(canvas, bytes, 17, 0, 0, 14, ['amenities'], pick).vertices,
    0,
  );
  assert.equal(pick.features.length, 0);
  paintOsmTile(canvas, bytes, 17, 0, 0, 14, ['shops'], pick);
  assert.equal(pick.features[0]?.name, 'Local Bakery');
  assert.equal(pick.features[0]?.sourceId, '1234');
});
void test('popup tags decode delimiters literally and reject untrusted source identifiers', () => {
  const feature = osmFeatureInfo('shops', {
    ov_tags: 'name=Hello%3Dworld%0Anext%25line\nnote=<script>alert(1)</script>',
    ov_id: 'javascript:evil',
    ov_type: 'script',
  });
  assert.deepEqual(feature.tags, [
    ['name', 'Hello=world\nnext%line'],
    ['note', '<script>alert(1)</script>'],
  ]);
  assert.equal(feature.complete, true);
  assert.equal(feature.sourceId, undefined);
  assert.equal(feature.sourceType, undefined);
  assert.equal(
    osmFeatureInfo('shops', { family: 'shop', class: 'bakery' }).complete,
    false,
  );
  assert.equal(
    osmFeatureInfo('shops', { ov_tags: 'note=' + 'x'.repeat(70000) }).complete,
    false,
  );
});
void test('OSM click geometry includes thin lines and excludes polygon holes', () => {
  const square = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];
  const hole = [
    { x: 30, y: 30 },
    { x: 70, y: 30 },
    { x: 70, y: 70 },
    { x: 30, y: 70 },
  ];
  assert.equal(osmGeometryHit([square, hole], 3, 15, 15), true);
  assert.equal(osmGeometryHit([square, hole], 3, 50, 50), false);
  assert.equal(
    osmGeometryHit(
      [
        [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
        ],
      ],
      2,
      50,
      5,
    ),
    true,
  );
  assert.equal(
    osmGeometryHit(
      [
        [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
        ],
      ],
      2,
      50,
      20,
    ),
    false,
  );
  assert.equal(osmGeometryHit([[{ x: 50, y: 50 }]], 1, 52, 52), true);
});

void test('large man-made icons use surveillance eyes or red hammers and their full area is clickable', () => {
  const calls: string[] = [],
    colors: unknown[] = [];
  const context = new Proxy(
    {},
    {
      get: (_target, key) => () => {
        calls.push(String(key));
      },
      set: (_target, key, value) => {
        if (key === 'fillStyle') colors.push(value);
        return true;
      },
    },
  );
  const canvas = { getContext: () => context } as unknown as OffscreenCanvas;
  for (const [properties, eye] of [
    [{ family: 'amenity', class: 'parking', man_made: 'surveillance' }, true],
    [{ family: 'man_made', class: 'surveillance' }, true],
    [{ family: 'man_made', class: 'tower' }, false],
  ] as const) {
    calls.length = colors.length = 0;
    const bytes = vectorTile('details', 1, [9, 100, 100], 1, properties);
    const pick = {
      x: 43,
      y: 25,
      features: [] as ReturnType<typeof osmFeatureInfo>[],
    };
    paintOsmTile(
      canvas,
      bytes,
      17,
      0,
      0,
      14,
      ['amenities', 'structures'],
      pick,
    );
    assert.equal(calls.includes('bezierCurveTo'), eye);
    assert.ok(colors.includes(eye ? '#bd75ff' : '#ff555f'));
    assert.equal(pick.features[0]?.category, 'structures');
    pick.x = 50;
    pick.features = [];
    paintOsmTile(canvas, bytes, 17, 0, 0, 14, ['structures'], pick);
    assert.equal(pick.features.length, 0);
  }
});
void test('large symbols crossing display-tile edges remain visible and clickable', () => {
  const context = new Proxy({}, { get: () => () => {}, set: () => true });
  const canvas = { getContext: () => context } as unknown as OffscreenCanvas;
  // The center lies 10 pixels beyond the left edge, but part of the icon is visible.
  const bytes = vectorTile('details', 1, [9, 39, 100], 1, {
    family: 'man_made',
    class: 'surveillance',
  });
  const pick = {
    x: 2,
    y: 25,
    features: [] as ReturnType<typeof osmFeatureInfo>[],
  };
  paintOsmTile(canvas, bytes, 17, 0, 0, 14, ['structures'], pick);
  assert.equal(pick.features[0]?.category, 'structures');
});
