import type { ParcelFeature } from './model';

// The services return WGS84 coordinates. This tolerance is about 0.01 mm
// at the equator, below the precision of the source parcel geometry.
const EPSILON = 1e-10;
type Point = number[];
type Ring = number[][];
type Location = -1 | 0 | 1; // outside, boundary, inside
type Box = [number, number, number, number];

function cross(ax: number, ay: number, bx: number, by: number) {
  return ax * by - ay * bx;
}

function onSegment(point: Point, a: Point, b: Point) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length <= EPSILON)
    return Math.hypot(point[0] - a[0], point[1] - a[1]) <= EPSILON;
  if (
    point[0] < Math.min(a[0], b[0]) - EPSILON ||
    point[0] > Math.max(a[0], b[0]) + EPSILON ||
    point[1] < Math.min(a[1], b[1]) - EPSILON ||
    point[1] > Math.max(a[1], b[1]) + EPSILON
  )
    return false;
  return (
    Math.abs(cross(point[0] - a[0], point[1] - a[1], dx, dy)) <=
    EPSILON * length
  );
}

function locate(point: Point, ring: Ring): Location {
  if (
    ring.length < 3 ||
    !Number.isFinite(point[0]) ||
    !Number.isFinite(point[1])
  )
    return -1;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j],
      b = ring[i];
    if (onSegment(point, a, b)) return 0;
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < a[0] + ((point[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1])
    )
      inside = !inside;
  }
  return inside ? 1 : -1;
}

// Boundary inclusion matches ArcGIS esriSpatialRelIntersects.
export function pointInRing(point: number[], ring: number[][]) {
  return locate(point, ring) >= 0;
}

export function ringArea(ring: number[][]) {
  if (ring.length < 3) return 0;
  const [ox, oy] = ring[0];
  let sum = 0;
  // Translate before multiplying: tiny parcels at longitudes near +/-180
  // otherwise lose precision when subtracting large coordinate products.
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length];
    sum += cross(a[0] - ox, a[1] - oy, b[0] - ox, b[1] - oy);
  }
  return sum / 2;
}

function box(ring: Ring): Box {
  let west = Infinity,
    south = Infinity,
    east = -Infinity,
    north = -Infinity;
  for (const [x, y] of ring) {
    west = Math.min(west, x);
    south = Math.min(south, y);
    east = Math.max(east, x);
    north = Math.max(north, y);
  }
  return [west, south, east, north];
}

function boxContains(outer: Box, inner: Box) {
  return (
    inner[0] >= outer[0] - EPSILON &&
    inner[1] >= outer[1] - EPSILON &&
    inner[2] <= outer[2] + EPSILON &&
    inner[3] <= outer[3] + EPSILON
  );
}

function intersectionParameters(
  a: Point,
  b: Point,
  c: Point,
  d: Point,
): number[] {
  const rx = b[0] - a[0],
    ry = b[1] - a[1];
  const sx = d[0] - c[0],
    sy = d[1] - c[1];
  const qx = c[0] - a[0],
    qy = c[1] - a[1];
  const lengthR = Math.hypot(rx, ry),
    lengthS = Math.hypot(sx, sy);
  if (!lengthR || !lengthS) return [];
  const denominator = cross(rx, ry, sx, sy);
  const parallelTolerance = Number.EPSILON * 16 * lengthR * lengthS;
  const clamp = (t: number) => Math.max(0, Math.min(1, t));
  if (Math.abs(denominator) > parallelTolerance) {
    const t = cross(qx, qy, sx, sy) / denominator;
    const u = cross(qx, qy, rx, ry) / denominator;
    if (
      t >= -EPSILON / lengthR &&
      t <= 1 + EPSILON / lengthR &&
      u >= -EPSILON / lengthS &&
      u <= 1 + EPSILON / lengthS
    )
      return [clamp(t)];
    return [];
  }
  if (Math.abs(cross(qx, qy, rx, ry)) > EPSILON * lengthR) return [];
  const squareLength = rx * rx + ry * ry;
  const t1 = (qx * rx + qy * ry) / squareLength;
  const t2 = ((d[0] - a[0]) * rx + (d[1] - a[1]) * ry) / squareLength;
  if (Math.max(t1, t2) < 0 || Math.min(t1, t2) > 1) return [];
  return [clamp(t1), clamp(t2)];
}

// A single vertex is insufficient: distinct exterior rings can touch there.
// Check whole edges, split at parent-boundary intersections. Each resulting
// interval has a constant inside/outside classification for simple GIS rings.
function containsRing(outer: Ring, inner: Ring) {
  let hasInterior = false;
  for (let i = 0; i < inner.length - 1; i++) {
    const a = inner[i],
      b = inner[i + 1];
    const atVertex = locate(a, outer);
    if (atVertex === -1) return false;
    if (atVertex === 1) hasInterior = true;
    const breaks = [0, 1];
    for (let j = 0; j < outer.length - 1; j++)
      breaks.push(...intersectionParameters(a, b, outer[j], outer[j + 1]));
    breaks.sort((x, y) => x - y);
    for (let j = 1; j < breaks.length; j++) {
      if (breaks[j] <= breaks[j - 1]) continue;
      const t = (breaks[j] + breaks[j - 1]) / 2;
      const location = locate(
        [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])],
        outer,
      );
      if (location === -1) return false;
      if (location === 1) hasInterior = true;
    }
  }
  return hasInterior;
}

function oriented(ring: Ring, counterclockwise: boolean): Ring {
  return ringArea(ring) > 0 === counterclockwise ? ring : [...ring].reverse();
}

function ringKey(ring: Ring) {
  const points = oriented(ring, true).slice(0, -1);
  let start = 0;
  for (let i = 1; i < points.length; i++) {
    if (
      points[i][0] < points[start][0] ||
      (points[i][0] === points[start][0] && points[i][1] < points[start][1])
    )
      start = i;
  }
  return [...points.slice(start), ...points.slice(0, start)]
    .map((p) => `${p[0]},${p[1]}`)
    .join(';');
}

export function ringsToGeometry(
  raw: number[][][],
): ParcelFeature['geometry'] | null {
  if (!Array.isArray(raw)) return null;
  const unique = new Set<string>();
  const nodes: {
    ring: Ring;
    box: Box;
    area: number;
    depth: number;
    polygon: number;
  }[] = [];
  for (const source of raw) {
    if (
      !Array.isArray(source) ||
      source.length < 3 ||
      source.some(
        (p) =>
          !Array.isArray(p) ||
          p.length < 2 ||
          !Number.isFinite(p[0]) ||
          !Number.isFinite(p[1]) ||
          Math.abs(p[0]) > 180 ||
          Math.abs(p[1]) > 90,
      )
    )
      continue;
    const ring: Ring = [];
    for (const p of source) {
      const last = ring[ring.length - 1];
      if (!last || p[0] !== last[0] || p[1] !== last[1])
        ring.push([p[0], p[1]]);
    }
    if (ring.length < 3) continue;
    const first = ring[0],
      last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
    const area = Math.abs(ringArea(ring));
    if (ring.length < 4 || area <= EPSILON * EPSILON) continue;
    const key = ringKey(ring);
    if (unique.has(key)) continue;
    unique.add(key);
    nodes.push({ ring, box: box(ring), area, depth: 0, polygon: -1 });
  }
  nodes.sort((a, b) => b.area - a.area);
  const polygons: number[][][][] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    let parent: typeof node | undefined;
    // Descending areas guarantee the first enclosing candidate encountered
    // in reverse order is the immediate (smallest) container.
    for (let j = i - 1; j >= 0; j--) {
      const candidate = nodes[j];
      if (
        candidate.area > node.area &&
        boxContains(candidate.box, node.box) &&
        containsRing(candidate.ring, node.ring)
      ) {
        parent = candidate;
        break;
      }
    }
    node.depth = parent ? parent.depth + 1 : 0;
    if (node.depth % 2 === 0) {
      node.polygon = polygons.length;
      polygons.push([oriented(node.ring, true)]);
    } else {
      node.polygon = parent!.polygon;
      polygons[node.polygon].push(oriented(node.ring, false));
    }
  }
  return !polygons.length
    ? null
    : polygons.length === 1
      ? { type: 'Polygon', coordinates: polygons[0] }
      : { type: 'MultiPolygon', coordinates: polygons };
}

export function geometryRings(
  geometry: ParcelFeature['geometry'],
): number[][][] {
  return geometry.type === 'Polygon'
    ? (geometry.coordinates as number[][][])
    : (geometry.coordinates as number[][][][]).flat();
}

export function geometryContains(
  geometry: ParcelFeature['geometry'],
  lon: number,
  lat: number,
) {
  const polygons =
    geometry.type === 'Polygon'
      ? [geometry.coordinates as number[][][]]
      : (geometry.coordinates as number[][][][]);
  const point = [lon, lat];
  return polygons.some(
    (p) =>
      p.length > 0 &&
      locate(point, p[0]) >= 0 &&
      // A hole interior is excluded; its boundary still intersects the parcel.
      !p.slice(1).some((hole) => locate(point, hole) === 1),
  );
}
