import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import {
  OSM_LIMITS,
  OSM_STYLE,
  OSM_CATEGORIES,
  osmCategoryMatches,
  OsmTileBudgetError,
  osmTile,
  osmVisibleLayers,
  type OsmLayer,
} from './osm-model';
import {
  osmFeatureInfo,
  osmGeometryHit,
  type OsmFeatureInfo,
} from './osm-pick';
import {
  OSM_MAN_MADE_SYMBOL,
  osmManMadeSymbol,
  paintManMadeSymbol,
} from './osm-symbols';
import { osmGeometryCounts } from './osm-geometry-budget';
export function paintOsmTile(
  canvas: OffscreenCanvas,
  data: ArrayBuffer | null,
  z: number,
  x: number,
  y: number,
  maximum: number,
  enabled: OsmLayer[],
  pick?: { x: number; y: number; features: OsmFeatureInfo[] },
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OSM rendering needs a 2D canvas.');
  ctx.clearRect(0, 0, 256, 256);
  if (!data) return { limited: false, features: 0, vertices: 0 };
  if (data.byteLength > OSM_LIMITS.tileBytes)
    return { limited: true, features: 0, vertices: 0 };
  let counts: ReturnType<typeof osmGeometryCounts>;
  try {
    counts = osmGeometryCounts(data);
  } catch (error) {
    if (error instanceof OsmTileBudgetError)
      return { limited: true, features: 0, vertices: 0 };
    throw error;
  }
  const tile = new VectorTile(new PbfReader(new Uint8Array(data)));
  const address = osmTile(z, x, y, maximum);
  const visible = new Set(osmVisibleLayers(enabled, z));
  let features = 0,
    vertices = 0,
    symbols = 0,
    labels = 0,
    limited = false;
  const occupied = new Set<string>();
  const manMadeSymbols: {
    x: number;
    y: number;
    properties: Record<string, unknown>;
  }[] = [];
  const addManMadeSymbol = (
    px: number,
    py: number,
    properties: Record<string, unknown>,
  ) => {
    const margin = OSM_MAN_MADE_SYMBOL.hitRadius;
    if (
      px < -margin ||
      py < -margin ||
      px >= 256 + margin ||
      py >= 256 + margin
    )
      return;
    const cell = `${Math.floor(px / 64)}/${Math.floor(py / 48)}`;
    if (occupied.has(cell) || symbols >= OSM_LIMITS.symbolsPerTile) {
      limited = true;
      return;
    }
    occupied.add(cell);
    symbols++;
    manMadeSymbols.push({ x: px, y: py, properties });
  };
  const addPick = (category: OsmLayer, properties: Record<string, unknown>) => {
    if (!pick) return;
    pick.features.unshift(osmFeatureInfo(category, properties));
    if (pick.features.length > 8) pick.features.pop();
  };
  // Draw areas first, with detailed geometry and labels on top.
  for (const name of [
    'land',
    'water',
    'roads',
    'buildings',
    'details',
    'places',
  ] as const) {
    const categories = OSM_CATEGORIES.filter(
      (category) => category.layer === name && visible.has(category.id),
    );
    if (!categories.length) continue;
    const layer = tile.layers[name];
    if (!layer) continue;
    if (layer.extent <= 0 || layer.extent > 16384)
      throw new Error('Invalid OSM geometry extent.');
    for (let i = 0; i < layer.length; i++) {
      if (++features > OSM_LIMITS.features) {
        limited = true;
        break;
      }
      const feature = layer.feature(i);
      const matches = (candidate: (typeof OSM_CATEGORIES)[number]) =>
        osmCategoryMatches(
          candidate,
          name,
          feature.properties,
          feature.type,
          z,
        );
      const category =
        categories.find(
          (candidate) => candidate.id === 'structures' && matches(candidate),
        ) || categories.find(matches);
      if (!category) continue;
      if ((counts[name]?.[i] ?? Infinity) + vertices > OSM_LIMITS.vertices) {
        limited = true;
        continue;
      }
      const bounds = feature.bbox();
      const projectX = (value: number) =>
        (value / layer.extent) * 256 * address.scale - address.dx * 256;
      const projectY = (value: number) =>
        (value / layer.extent) * 256 * address.scale - address.dy * 256;
      const margin =
        category.id === 'structures' ? OSM_MAN_MADE_SYMBOL.hitRadius : 8;
      if (
        projectX(bounds[2]) < -margin ||
        projectY(bounds[3]) < -margin ||
        projectX(bounds[0]) > 256 + margin ||
        projectY(bounds[1]) > 256 + margin
      )
        continue;
      const geometry = feature.loadGeometry();
      const count = geometry.reduce((n, ring) => n + ring.length, 0);
      if (vertices + count > OSM_LIMITS.vertices) {
        limited = true;
        continue;
      }
      vertices += count;
      const color =
        category.id === 'structures'
          ? osmManMadeSymbol(feature.properties) === 'eye'
            ? OSM_MAN_MADE_SYMBOL.surveillance
            : OSM_MAN_MADE_SYMBOL.other
          : OSM_STYLE[category.id].color;
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      ctx.lineWidth = name === 'roads' ? 1.6 : 1;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.globalAlpha = 0.9;
      if (feature.type === 1) {
        const point = geometry[0]?.[0];
        if (!point) continue;
        const px = projectX(point.x),
          py = projectY(point.y);
        if (category.id === 'structures') {
          addManMadeSymbol(px, py, feature.properties);
          continue;
        }
        if (px < 0 || py < 0 || px >= 256 || py >= 256) continue;
        const cell = `${Math.floor(px / 64)}/${Math.floor(py / 48)}`;
        if (occupied.has(cell) || symbols >= OSM_LIMITS.symbolsPerTile) {
          limited = true;
          continue;
        }
        occupied.add(cell);
        symbols++;
        if (pick && osmGeometryHit([[{ x: px, y: py }]], 1, pick.x, pick.y))
          addPick(category.id, feature.properties);
        if (name !== 'places') {
          ctx.beginPath();
          ctx.arc(px, py, 3, 0, Math.PI * 2);
          ctx.fill();
        }
        const label =
          typeof feature.properties.name === 'string'
            ? feature.properties.name.slice(0, 32)
            : '';
        if (label && labels < OSM_LIMITS.labelsPerTile) {
          labels++;
          ctx.font = '12px sans-serif';
          ctx.lineWidth = 3;
          ctx.strokeStyle = '#13202b';
          ctx.strokeText(
            label,
            Math.min(190, Math.max(3, px + 5)),
            Math.max(13, py - 5),
          );
          ctx.fillText(
            label,
            Math.min(190, Math.max(3, px + 5)),
            Math.max(13, py - 5),
          );
        }
      } else if (feature.type === 2 || feature.type === 3) {
        if (category.id === 'structures') {
          const ring = geometry[0];
          const anchor = ring?.[Math.floor((ring.length - 1) / 2)];
          if (anchor)
            addManMadeSymbol(
              projectX(anchor.x),
              projectY(anchor.y),
              feature.properties,
            );
        }
        if (
          pick &&
          osmGeometryHit(
            geometry,
            feature.type,
            ((pick.x + address.dx * 256) * layer.extent) /
              (256 * address.scale),
            ((pick.y + address.dy * 256) * layer.extent) /
              (256 * address.scale),
            (7 * layer.extent) / (256 * address.scale),
          )
        )
          addPick(category.id, feature.properties);
        ctx.beginPath();
        for (const ring of geometry) {
          for (let j = 0; j < ring.length; j++) {
            const px = projectX(ring[j].x),
              py = projectY(ring[j].y);
            if (
              !Number.isFinite(px) ||
              !Number.isFinite(py) ||
              Math.abs(px) > 1e9 ||
              Math.abs(py) > 1e9
            )
              throw new Error('Invalid OSM coordinates.');
            if (j) ctx.lineTo(px, py);
            else ctx.moveTo(px, py);
          }
          if (feature.type === 3) ctx.closePath();
        }
        if (feature.type === 3) {
          ctx.globalAlpha = name === 'buildings' ? 0.35 : 0.2;
          ctx.fill('evenodd');
        }
        ctx.globalAlpha = 0.8;
        ctx.stroke();
      }
    }
    if (features > OSM_LIMITS.features) break;
  }
  for (const marker of manMadeSymbols) {
    paintManMadeSymbol(
      ctx,
      marker.x,
      marker.y,
      osmManMadeSymbol(marker.properties),
    );
    if (
      pick &&
      Math.hypot(pick.x - marker.x, pick.y - marker.y) <=
        OSM_MAN_MADE_SYMBOL.hitRadius
    )
      addPick('structures', marker.properties);
    const label =
      typeof marker.properties.name === 'string'
        ? marker.properties.name.slice(0, 32)
        : '';
    if (label && labels < OSM_LIMITS.labelsPerTile) {
      labels++;
      ctx.globalAlpha = 1;
      ctx.font = '12px sans-serif';
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#13202b';
      ctx.fillStyle =
        osmManMadeSymbol(marker.properties) === 'eye'
          ? OSM_MAN_MADE_SYMBOL.surveillance
          : OSM_MAN_MADE_SYMBOL.other;
      const labelX = Math.min(190, Math.max(3, marker.x - 15)),
        labelY = Math.max(13, marker.y - 25);
      ctx.strokeText(label, labelX, labelY);
      ctx.fillText(label, labelX, labelY);
    }
  }
  return { limited, features, vertices };
}
