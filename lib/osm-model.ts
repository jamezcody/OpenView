import {
  OSM_CATEGORIES,
  OSM_PROFILE_VERSION,
} from '../scripts/local/osm-catalog.mjs';
export { OSM_CATEGORIES, OSM_PROFILE_VERSION };
export type OsmLayer = (typeof OSM_CATEGORIES)[number]['id'];
export const OSM_LAYERS = OSM_CATEGORIES.map((category) => category.id);
export const OSM_STYLE = Object.fromEntries(
  OSM_CATEGORIES.map((category) => [category.id, category]),
) as Record<OsmLayer, (typeof OSM_CATEGORIES)[number]>;
export const OSM_GROUPS = [
  {
    name: 'Transport',
    ids: ['roads', 'railways', 'aerialways', 'aviation', 'transit', 'routes'],
  },
  {
    name: 'Water & outdoors',
    ids: [
      'water',
      'waterways',
      'landuse',
      'landcover',
      'natural',
      'leisure',
      'boundaries',
      'geology',
      'sports',
    ],
  },
  {
    name: 'Buildings & places',
    ids: ['buildings', 'places', 'addresses', 'entrances', 'indoor'],
  },
  {
    name: 'Services & destinations',
    ids: [
      'amenities',
      'shops',
      'healthcare',
      'tourism',
      'historic',
      'craft',
      'offices',
      'clubs',
    ],
  },
  {
    name: 'Infrastructure',
    ids: [
      'power',
      'telecom',
      'structures',
      'barriers',
      'emergency',
      'military',
      'advertising',
      'traffic',
    ],
  },
] satisfies { name: string; ids: OsmLayer[] }[];
export class OsmTileBudgetError extends Error {}
export function osmCategoryMatches(
  category: (typeof OSM_CATEGORIES)[number],
  layer: string,
  properties: Record<string, unknown>,
  geometry: number,
  zoom: number,
) {
  if (
    category.layer !== layer ||
    category.zoom > zoom ||
    (geometry === 1 && layer !== 'places' && zoom < 17)
  )
    return false;
  const tag = (key: string) =>
    properties[key] ??
    (properties.family === key ? properties.class : undefined);
  if (category.id === 'water')
    return Boolean(
      tag('water') ||
      tag('natural') === 'water' ||
      tag('waterway') === 'riverbank',
    );
  if (category.id === 'natural' && tag('natural') === 'water') return false;
  return category.keys.some(
    (key) => tag(key) !== undefined && tag(key) !== 'no',
  );
}
export function osmLayerMatches(layer: OsmLayer, query: string) {
  const category = OSM_STYLE[layer];
  const text = [category.name, category.description, ...category.keys]
    .join(' ')
    .toLowerCase();
  return query
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .every((term) => text.includes(term));
}
export const OSM_LIMITS = {
  cacheBytes: 32 * 1024 * 1024,
  rangeBytes: 2 * 1024 * 1024,
  tileBytes: 4 * 1024 * 1024,
  vertices: 75000,
  features: 6000,
  symbolsPerTile: 8,
  labelsPerTile: 6,
  concurrent: 2,
} as const;
export type OsmDataset = {
  id: string;
  name: string;
  sourcePath: string;
  sourceUrl: string;
  managedSource: boolean;
  sourceReady: boolean;
  directory: string;
  bytes: number;
  downloadedBytes: number;
  status:
    | 'downloading'
    | 'checking'
    | 'preparing'
    | 'paused'
    | 'interrupted'
    | 'error'
    | 'downloaded'
    | 'ready';
  enabled: boolean;
  message: string;
  profileVersion?: number;
  prepared?: string;
  tilesBytes?: number;
  minZoom?: number;
  maxZoom?: number;
  bounds?: number[];
};
export type OsmLibrary = {
  schemaVersion: number;
  storage: string;
  datasets: OsmDataset[];
  busy: boolean;
  activeId: string | null;
  nonce: string;
  freeMemoryBytes: number;
};
export type OsmSelection = {
  id: string;
  prepared: string;
  minZoom: number;
  maxZoom: number;
  layers: OsmLayer[];
};
export type OsmRegion = {
  id: string;
  name: string;
  parent: string;
  codes?: string[];
  url: string;
};
export function osmRegionMatches(region: OsmRegion, query: string) {
  const normalize = (value: string) =>
    value
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  const text = normalize(
    [region.name, region.parent, region.id, ...(region.codes || [])].join(' '),
  );
  return normalize(query)
    .split(/\s+/)
    .every((term) => text.includes(term));
}
export type OsmPreview = {
  selection: string;
  name: string;
  bytes: number;
  compressed: boolean;
  modified: string;
  estimatedWorkingBytes: number;
  freeDiskBytes: number;
};
export function osmBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}
export function osmTile(z: number, x: number, y: number, maximum: number) {
  if (
    ![z, x, y, maximum].every(Number.isInteger) ||
    z < 0 ||
    z > 20 ||
    maximum < 0 ||
    maximum > 14 ||
    x < 0 ||
    y < 0 ||
    x >= 2 ** z ||
    y >= 2 ** z
  )
    throw new Error('Invalid OSM tile coordinates.');
  const level = Math.min(z, maximum),
    scale = 2 ** (z - level);
  return {
    z: level,
    x: Math.floor(x / scale),
    y: Math.floor(y / scale),
    scale,
    dx: x % scale,
    dy: y % scale,
  };
}
export function osmVisibleLayers(layers: OsmLayer[], zoom: number) {
  return layers.filter((layer) => OSM_STYLE[layer].zoom <= zoom);
}
export class OsmTileCache {
  private entries = new Map<string, ArrayBuffer>();
  bytes = 0;
  constructor(readonly maximum: number = OSM_LIMITS.cacheBytes) {}
  get(key: string) {
    const value = this.entries.get(key);
    if (value) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }
  set(key: string, value: ArrayBuffer) {
    const old = this.entries.get(key);
    if (old) {
      this.bytes -= old.byteLength;
      this.entries.delete(key);
    }
    if (value.byteLength > this.maximum) return;
    while (this.bytes + value.byteLength > this.maximum && this.entries.size) {
      const first = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(first)!.byteLength;
      this.entries.delete(first);
    }
    this.entries.set(key, value);
    this.bytes += value.byteLength;
  }
}
