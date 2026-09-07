import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ringsToGeometry,
  geometryContains,
  geometryRings,
  pointInRing,
  ringArea,
} from '../lib/parcel-geometry';

// Clockwise shells match ArcGIS JSON convention; GeoJSON output reverses it.
const square = (west: number, south: number, east: number, north: number) => [
  [west, south],
  [west, north],
  [east, north],
  [east, south],
  [west, south],
];

void test('separate exterior rings touching at a vertex remain two filled polygons', () => {
  const a = square(0, 0, 1, 1);
  const b = [
    [0, 0],
    [0, -1],
    [-1, -1],
    [-1, 0],
    [0, 0],
  ];
  for (const input of [
    [a, b],
    [b, a],
  ]) {
    const result = ringsToGeometry(input)!;
    assert.equal(result.type, 'MultiPolygon');
    assert.equal(result.coordinates.length, 2);
    assert.equal(geometryContains(result, 0.5, 0.5), true);
    assert.equal(geometryContains(result, -0.5, -0.5), true);
    assert.equal(geometryContains(result, -0.5, 0.5), false);
  }
});

void test('adjacent exterior rings sharing an edge are not holes', () => {
  const result = ringsToGeometry([square(0, 0, 1, 1), square(-1, 0, 0, 1)])!;
  assert.equal(result.type, 'MultiPolygon');
  assert.equal(geometryContains(result, -0.5, 0.5), true);
  assert.equal(geometryContains(result, 0.5, 0.5), true);
  assert.equal(geometryContains(result, 0, 0.5), true);
});

void test('holes and nested islands survive arbitrary input order and ring winding', () => {
  const shell = square(0, 0, 10, 10),
    hole = square(2, 2, 8, 8).reverse();
  const island = square(3, 3, 7, 7),
    islandHole = square(4, 4, 6, 6).reverse();
  const inputs = [
    [shell, hole, island, islandHole],
    [islandHole, island, shell, hole],
    [hole, islandHole, island, shell].map((r) => [...r].reverse()),
  ];
  for (const input of inputs) {
    const result = ringsToGeometry(input)!;
    assert.equal(result.type, 'MultiPolygon');
    assert.equal(result.coordinates.length, 2);
    assert.equal(geometryRings(result).length, 4);
    assert.equal(geometryContains(result, 1, 1), true);
    assert.equal(geometryContains(result, 2.5, 2.5), false);
    assert.equal(geometryContains(result, 3.5, 3.5), true);
    assert.equal(geometryContains(result, 5, 5), false);
    for (const polygon of result.coordinates as number[][][][]) {
      assert.ok(
        ringArea(polygon[0]) > 0,
        'GeoJSON shell must be counterclockwise',
      );
      assert.ok(
        polygon.slice(1).every((r) => ringArea(r) < 0),
        'GeoJSON holes must be clockwise',
      );
    }
  }
});

void test('every exterior edge and vertex intersects; holes exclude only their interiors', () => {
  const result = ringsToGeometry([
    square(0, 0, 10, 10),
    square(2, 2, 8, 8).reverse(),
  ])!;
  for (const [x, y] of [
    [0, 5],
    [10, 5],
    [5, 0],
    [5, 10],
    [0, 0],
    [10, 10],
    [2, 5],
    [8, 5],
    [5, 2],
    [5, 8],
  ]) {
    assert.equal(
      geometryContains(result, x, y),
      true,
      `${x},${y} is a parcel boundary`,
    );
  }
  assert.equal(geometryContains(result, 5, 5), false);
  assert.equal(geometryContains(result, -1e-6, 5), false);
  assert.equal(pointInRing([10, 5], square(0, 0, 10, 10)), true);
});

void test('a hole can touch the shell while remaining correctly classified', () => {
  const shell = square(0, 0, 10, 10);
  const touchingHole = [
    [0, 5],
    [3, 3],
    [3, 7],
    [0, 5],
  ];
  const result = ringsToGeometry([touchingHole, shell])!;
  assert.equal(result.type, 'Polygon');
  assert.equal(result.coordinates.length, 2);
  assert.equal(geometryContains(result, 2, 5), false);
  assert.equal(geometryContains(result, 0, 5), true);
  assert.equal(geometryContains(result, 8, 5), true);
});

void test('all-boundary vertices do not hide an interior triangular hole', () => {
  const result = ringsToGeometry([
    square(0, 0, 10, 10),
    [
      [0, 0],
      [10, 0],
      [0, 10],
      [0, 0],
    ],
  ])!;
  assert.equal(result.type, 'Polygon');
  assert.equal(result.coordinates.length, 2);
  assert.equal(geometryContains(result, 2, 2), false);
  assert.equal(geometryContains(result, 9, 9), true);
});

void test('an edge crossing a concave exterior cannot make a contained hole', () => {
  // The narrow notch misses the midpoint of the candidate's long top edge.
  const shell = [
    [0, 0],
    [0, 10],
    [2, 10],
    [2, 4],
    [3, 4],
    [3, 10],
    [10, 10],
    [10, 0],
    [0, 0],
  ];
  const crossesNotch = [
    [1, 5],
    [9, 5],
    [9, 3],
    [1, 3],
    [1, 5],
  ];
  const result = ringsToGeometry([shell, crossesNotch])!;
  assert.equal(result.type, 'MultiPolygon');
  assert.equal(geometryContains(result, 2.5, 4.5), true);
});

void test('tiny real-world parcels retain area when longitude magnitude is large', () => {
  const ring = square(-118.2437, 34.0522, -118.2436999, 34.0522001);
  const result = ringsToGeometry([ring])!;
  assert.ok(result);
  assert.ok(Math.abs(ringArea(ring)) > 9e-15);
  assert.equal(geometryContains(result, -118.24369995, 34.05220005), true);
});

void test('normalize open rings and Z coordinates without mutating source, reject invalid rings', () => {
  const input = [
    [
      [0, 0, 12],
      [0, 1, 12],
      [1, 1, 12],
      [1, 0, 12],
    ],
  ];
  const before = JSON.stringify(input);
  const result = ringsToGeometry(input)!;
  assert.equal(JSON.stringify(input), before);
  const ring = geometryRings(result)[0];
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  assert.ok(ring.every((p) => p.length === 2));
  assert.equal(ringsToGeometry([]), null);
  assert.equal(
    ringsToGeometry([
      [
        [0, 0],
        [1, 1],
        [2, 2],
      ],
    ]),
    null,
  );
  assert.equal(
    ringsToGeometry([
      [
        [0, 0],
        [1, 1],
        [NaN, 2],
      ],
    ]),
    null,
  );
  assert.equal(
    ringsToGeometry([
      [
        [0, 0],
        [190, 1],
        [1, 2],
      ],
    ]),
    null,
  );
});

void test('identical rings with shifted starting vertices and reversed winding are deduplicated', () => {
  const shell = square(0, 0, 10, 10);
  const shifted = [
    [10, 10],
    [0, 10],
    [0, 0],
    [10, 0],
    [10, 10],
  ];
  const result = ringsToGeometry([shell, shifted])!;
  assert.equal(result.type, 'Polygon');
  assert.equal(geometryRings(result).length, 1);
});
