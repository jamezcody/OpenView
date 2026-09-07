import { existsSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LAYERS, MAP_FALLBACK } from '../lib/map-layers';

void test('every Natural Earth fallback tile declared by the release is bundled', () => {
  assert.equal(MAP_FALLBACK.max, 2);
  assert.match(MAP_FALLBACK.url, /\{reverseY\}/);
  const root = join(
    process.cwd(),
    'public',
    'cesium',
    'Assets',
    'Textures',
    'NaturalEarthII',
  );
  assert.ok(existsSync(join(root, 'tilemapresource.xml')));
  for (let z = 0; z <= MAP_FALLBACK.max; z++)
    for (let x = 0; x < 2 ** (z + 1); x++)
      for (let y = 0; y < 2 ** z; y++)
        assert.ok(existsSync(join(root, `${z}`, `${x}`, `${y}.jpg`)));
});

void test('remote map views retain native limits and Esri missing-tile sentinels', () => {
  assert.deepEqual(
    LAYERS.map(({ id, max }) => [id, max]),
    [
      ['satellite', 19],
      ['streets', 19],
      ['topographic', 17],
    ],
  );
  assert.equal(LAYERS.find(({ id }) => id === 'streets')!.missingTileUrl, null);
  for (const layer of LAYERS.filter(({ id }) => id !== 'streets')) {
    assert.match(layer.url, /MapServer\/tile\/\{z\}\/\{y\}\/\{x\}$/);
    assert.match(layer.missingTileUrl!, /MapServer\/tile\/23\/0\/0$/);
  }
});
