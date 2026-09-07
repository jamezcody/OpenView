import type { OsmLayer } from './osm-model';

export type OsmFeatureInfo = {
  category: OsmLayer;
  name: string;
  tags: [string, string][];
  sourceId?: string;
  sourceType?: string;
  complete: boolean;
};
export type OsmPickResult = { features: OsmFeatureInfo[]; limited: boolean };
export function osmFeatureInfo(
  category: OsmLayer,
  properties: Record<string, unknown>,
): OsmFeatureInfo {
  const text = (value: unknown) =>
    ['string', 'number', 'boolean'].includes(typeof value)
      ? `${value as string | number | boolean}`
      : '';
  const packed = properties.ov_tags;
  const decode = (value: string) =>
    value
      .replace(/%0A/g, '\n')
      .replace(/%0D/g, '\r')
      .replace(/%3D/g, '=')
      .replace(/%25/g, '%');
  const tags: [string, string][] = [];
  let complete = typeof packed === 'string' && packed.length <= 65536;
  if (typeof packed === 'string') {
    for (const line of packed.slice(0, 65536).split('\n')) {
      const separator = line.indexOf('=');
      if (separator < 1) {
        complete = false;
        continue;
      }
      const key = decode(line.slice(0, separator)),
        value = decode(line.slice(separator + 1));
      if (tags.length >= 256 || key.length > 256 || value.length > 4096)
        complete = false;
      if (tags.length < 256)
        tags.push([key.slice(0, 256), value.slice(0, 4096)]);
    }
  } else {
    if (typeof properties.family === 'string' && properties.class !== undefined)
      tags.push([properties.family, text(properties.class)]);
    if (typeof properties.name === 'string')
      tags.push(['name', properties.name.slice(0, 4096)]);
  }
  const sourceId =
    typeof properties.ov_id === 'string' && /^\d{1,20}$/.test(properties.ov_id)
      ? properties.ov_id
      : undefined;
  const sourceType =
    typeof properties.ov_type === 'string' &&
    ['node', 'way', 'relation'].includes(properties.ov_type)
      ? properties.ov_type
      : undefined;
  return {
    category,
    name: (
      tags.find(([key]) => key === 'name')?.[1] ||
      text(properties.name) ||
      text(properties.class) ||
      'Mapped feature'
    ).slice(0, 160),
    tags,
    sourceId,
    sourceType,
    complete,
  };
}

type Point = { x: number; y: number };
// Even/odd rings preserve holes; segment distance also selects thin lines and polygon edges.
export function osmGeometryHit(
  rings: Point[][],
  type: number,
  x: number,
  y: number,
  tolerance = 7,
) {
  let inside = false,
    distance = Infinity;
  for (const ring of rings) {
    for (let index = 0; index < ring.length; index++) {
      const a = ring[index],
        b = ring[(index + 1) % ring.length];
      if (type === 1) {
        distance = Math.min(distance, Math.hypot(x - a.x, y - a.y));
        continue;
      }
      if (type === 2 && index === ring.length - 1) continue;
      const dx = b.x - a.x,
        dy = b.y - a.y,
        length = dx * dx + dy * dy;
      const amount = length
        ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length))
        : 0;
      distance = Math.min(
        distance,
        Math.hypot(x - a.x - amount * dx, y - a.y - amount * dy),
      );
      if (
        type === 3 &&
        a.y > y !== b.y > y &&
        x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x
      )
        inside = !inside;
    }
  }
  return inside || distance <= tolerance;
}
