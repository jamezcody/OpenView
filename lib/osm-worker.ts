/// <reference lib="webworker" />
import { PMTiles, ResolvedValueCache, Compression, type Source } from 'pmtiles';
import {
  OSM_LIMITS,
  OsmTileCache,
  OsmTileBudgetError,
  osmTile,
  osmVisibleLayers,
  type OsmLayer,
} from './osm-model';
import { paintOsmTile } from './osm-render';
import type { OsmFeatureInfo } from './osm-pick';
import { PbfReader } from 'pbf';
const scope = self as unknown as DedicatedWorkerGlobalScope;
const cache = new OsmTileCache();
let archive: PMTiles | null = null,
  maximum = 14,
  layers: OsmLayer[] = [],
  active = 0;
async function boundedStream(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes)
        throw new OsmTileBudgetError('OSM tile exceeds the memory budget.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes.buffer;
}
async function decompress(
  data: ArrayBuffer,
  compression: Compression,
): Promise<ArrayBuffer> {
  if (data.byteLength > OSM_LIMITS.tileBytes)
    throw new OsmTileBudgetError('OSM block exceeds the memory budget.');
  if (compression === Compression.None) return data;
  if (compression !== Compression.Gzip)
    throw new Error(
      'Unsupported OSM tile compression. Prepare the file again.',
    );
  return boundedStream(
    new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip')),
    OSM_LIMITS.tileBytes,
  );
}
type TileMessage = {
  type: 'tile';
  id: number;
  z: number;
  x: number;
  y: number;
};
type PickMessage = Omit<TileMessage, 'type'> & {
  type: 'pick';
  px: number;
  py: number;
};
type WorkerMessage =
  | TileMessage
  | PickMessage
  | { type: 'init'; url: string; maximum: number; layers: OsmLayer[] };
let pendingPick: PickMessage | null = null;
// One deferred click shares the same two-job and tile-cache budgets as painting.
function handleMessage(message: WorkerMessage) {
  if (message.type === 'init') {
    maximum = message.maximum;
    layers = message.layers;
    const source: Source = {
      getKey: () => message.url,
      async getBytes(offset, length) {
        if (
          !Number.isSafeInteger(offset) ||
          !Number.isSafeInteger(length) ||
          offset < 0 ||
          length < 1
        )
          throw new Error('Invalid OSM archive request.');
        if (length > OSM_LIMITS.rangeBytes)
          throw new OsmTileBudgetError(
            'OSM tile exceeds the archive read budget.',
          );
        const response = await fetch(message.url, {
          headers: { Range: `bytes=${offset}-${offset + length - 1}` },
          signal: AbortSignal.timeout(15000),
        });
        if (response.status !== 206 || !response.body) {
          await response.body?.cancel();
          throw new Error(
            'Prepared OSM tiles are unavailable. Re-enable the dataset to retry.',
          );
        }
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
          response.headers.get('content-range') || '',
        );
        if (
          !range ||
          Number(range[1]) !== offset ||
          Number(range[2]) - offset + 1 > length
        ) {
          await response.body.cancel();
          throw new Error('Invalid OSM byte range.');
        }
        return { data: await boundedStream(response.body, length) };
      },
    };
    const directoryDecompress = async (
      data: ArrayBuffer,
      compression: Compression,
    ) => {
      const result = await decompress(data, compression);
      if (
        result.byteLength > 512 * 1024 ||
        new PbfReader(result).readVarint() > 8192
      )
        throw new Error('OSM tile directory exceeds the memory budget.');
      return result;
    };
    archive = new PMTiles(
      source,
      new ResolvedValueCache(8, false, directoryDecompress),
      decompress,
    );
    return;
  }
  if (!['tile', 'pick'].includes(message.type) || !archive) return;
  if (active >= OSM_LIMITS.concurrent) {
    if (message.type === 'pick') {
      if (pendingPick)
        scope.postMessage({
          id: pendingPick.id,
          type: 'pick',
          error: 'A newer map click replaced this one.',
        });
      pendingPick = message;
    }
    return;
  }
  active++;
  void (async () => {
    const { id, z, x, y } = message;
    try {
      const source = osmTile(z, x, y, maximum),
        key = `${source.z}/${source.x}/${source.y}`;
      let data: ArrayBuffer | null = null;
      if (osmVisibleLayers(layers, z).length) {
        data = cache.get(key) || null;
        if (!data) {
          const tile = await archive!.getZxy(source.z, source.x, source.y);
          data = tile?.data || null;
          if (data) cache.set(key, data);
        }
      }
      const canvas = new OffscreenCanvas(256, 256);
      const features: OsmFeatureInfo[] = [];
      const picking = message.type === 'pick';
      if (
        picking &&
        (!Number.isFinite(message.px) ||
          !Number.isFinite(message.py) ||
          message.px < -8 ||
          message.py < -8 ||
          message.px > 264 ||
          message.py > 264)
      )
        throw new Error('Invalid OSM pick coordinates.');
      const metrics = paintOsmTile(
        canvas,
        data,
        z,
        x,
        y,
        maximum,
        layers,
        picking ? { x: message.px, y: message.py, features } : undefined,
      );
      if (picking) {
        const seen = new Set<string>();
        scope.postMessage({
          id,
          type: 'pick',
          limited: metrics.limited,
          features: features.filter((feature) => {
            const key = feature.sourceId
              ? `${feature.sourceType}/${feature.sourceId}`
              : `${feature.category}/${feature.name}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          }),
        });
        return;
      }
      const bitmap = canvas.transferToImageBitmap();
      scope.postMessage({ id, bitmap, limited: metrics.limited }, [bitmap]);
    } catch (error) {
      if (message.type === 'pick') {
        scope.postMessage({
          id,
          type: 'pick',
          features: [],
          limited: error instanceof OsmTileBudgetError,
          error:
            error instanceof OsmTileBudgetError
              ? undefined
              : error instanceof Error
                ? error.message
                : 'Feature lookup failed.',
        });
        return;
      }
      if (error instanceof OsmTileBudgetError) {
        const bitmap = new OffscreenCanvas(256, 256).transferToImageBitmap();
        scope.postMessage({ id, bitmap, limited: true }, [bitmap]);
        return;
      }
      scope.postMessage({
        id,
        error: error instanceof Error ? error.message : 'OSM rendering failed.',
      });
    } finally {
      active--;
      const next = pendingPick;
      pendingPick = null;
      if (next) handleMessage(next);
    }
  })();
}
scope.onmessage = (event: MessageEvent) => handleMessage(event.data);
