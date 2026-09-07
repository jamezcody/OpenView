import { PMTiles, SharedPromiseCache, type Source } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { readBounded } from './bounded-fetch';
import {
  parkContains,
  parkPointTile,
  parkTileAddress,
  type ParkLayer,
  type ParkPoint,
} from './park-model';

export async function parkHash(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>),
    ),
    (v) => v.toString(16).padStart(2, '0'),
  ).join('');
}
export async function parkJson(
  url: string,
  signal: AbortSignal,
  maxBytes: number,
  expectedHash?: string,
) {
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Park data returned HTTP ${response.status}.`);
  }
  const bytes = await readBounded(response, maxBytes);
  if (
    expectedHash &&
    (bytes.length !== maxBytes || (await parkHash(bytes)) !== expectedHash)
  )
    throw new Error('Park record checksum mismatch.');
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(
      'Park data is unavailable or was not valid JSON. Reload park layers to retry.',
    );
  }
}
export type ParkShape = { id: string; extent: number; rings: ParkPoint[][] };
export type ParkTile = {
  polygons: ParkShape[];
  lines: ParkShape[];
  bytes: number;
};
const PARK_WHOLE_ARCHIVE_FALLBACK_BYTES = 8 * 1024 * 1024;
export function decodeParkTile(data: ArrayBuffer): ParkTile {
  if (data.byteLength > 4 * 1024 * 1024)
    throw new Error('Park tile exceeds the decoding limit.');
  const tile = new VectorTile(new PbfReader(new Uint8Array(data))),
    output: ParkTile = { polygons: [], lines: [], bytes: data.byteLength };
  let vertices = 0;
  for (const [name, type, target] of [
    ['parks', 3, output.polygons],
    ['boundaries', 2, output.lines],
  ] as const) {
    const layer = tile.layers[name];
    if (!layer) continue;
    if (layer.length > 20000 || layer.extent !== 4096)
      throw new Error('Invalid park vector layer.');
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i),
        id = f.properties.id;
      if (f.type !== type || typeof id !== 'string' || id.length > 160)
        throw new Error('Invalid park tile feature.');
      const rings = f.loadGeometry();
      for (const ring of rings) {
        vertices += ring.length;
        if (
          vertices > 200000 ||
          ring.some(
            (p) =>
              !Number.isFinite(p.x) ||
              !Number.isFinite(p.y) ||
              Math.abs(p.x) > 8192 ||
              Math.abs(p.y) > 8192,
          )
        )
          throw new Error('Park geometry exceeds its display limit.');
      }
      target.push({ id, extent: f.extent, rings });
      // Account for decoded Point objects and arrays, not only the compressed wire size.
      output.bytes += rings.reduce(
        (n, ring) => n + 64 + ring.length * 48,
        128 + id.length * 2,
      );
    }
  }
  if (
    Object.keys(tile.layers).some((k) => !['parks', 'boundaries'].includes(k))
  )
    throw new Error('Unexpected park tile schema.');
  return output;
}
export class ParkArchive {
  readonly controller = new AbortController();
  readonly archive: PMTiles;
  readonly metrics = { requests: 0, rangeBytes: 0, tiles: 0 };
  private chunks = new Map<number, Uint8Array>();
  private chunkBytes = 0;
  private wholeArchive: Uint8Array | undefined;
  private wholeArchivePending: Promise<Uint8Array> | undefined;
  private tiles = new Map<string, ParkTile>();
  private tileBytes = 0;
  private pending = new Map<string, Promise<ParkTile>>();
  private chunkPending = new Map<number, Promise<Uint8Array>>();
  constructor(
    readonly url: string,
    readonly layer: ParkLayer,
  ) {
    const source: Source = {
      getKey: () => url,
      getBytes: (offset, length, signal) => this.range(offset, length, signal),
    };
    this.archive = new PMTiles(source, new SharedPromiseCache(24));
  }
  close() {
    this.controller.abort();
    this.chunks.clear();
    this.wholeArchive = undefined;
    this.wholeArchivePending = undefined;
    this.tiles.clear();
    this.chunkPending.clear();
    this.pending.clear();
  }
  private async chunk(index: number, signal?: AbortSignal) {
    const whole = this.wholeArchive;
    if (whole)
      return whole.subarray(
        index * this.layer.chunkSize,
        Math.min(this.layer.bytes, (index + 1) * this.layer.chunkSize),
      );
    const old = this.chunks.get(index);
    if (old) {
      this.chunks.delete(index);
      this.chunks.set(index, old);
      return old;
    }
    const inFlight = this.chunkPending.get(index);
    if (inFlight) return inFlight;
    const request = (async () => {
      const start = index * this.layer.chunkSize,
        end = Math.min(this.layer.bytes, start + this.layer.chunkSize) - 1;
      const response = await fetch(this.url, {
        headers: { Range: `bytes=${start}-${end}` },
        signal: AbortSignal.any([
          this.controller.signal,
          ...(signal ? [signal] : []),
          AbortSignal.timeout(20000),
        ]),
      });
      this.metrics.requests++;
      let data: Uint8Array;
      if (
        response.status === 206 &&
        response.headers.get('content-range') ===
          `bytes ${start}-${end}/${this.layer.bytes}`
      ) {
        data = await readBounded(response, end - start + 1);
        if (
          data.length !== end - start + 1 ||
          (await parkHash(data)) !== this.layer.chunks[index]
        )
          throw new Error('Park archive checksum mismatch.');
      } else if (
        response.status === 200 &&
        this.layer.bytes <= PARK_WHOLE_ARCHIVE_FALLBACK_BYTES
      ) {
        if (this.wholeArchivePending) {
          await response.body?.cancel();
          data = await this.wholeArchivePending;
        } else {
          const pending = (async () => {
            const archive = await readBounded(response, this.layer.bytes);
            if (
              archive.length !== this.layer.bytes ||
              (await parkHash(archive)) !== this.layer.sha256
            )
              throw new Error('Park archive checksum mismatch.');
            this.controller.signal.throwIfAborted();
            this.chunks.clear();
            this.chunkBytes = 0;
            this.wholeArchive = archive;
            this.metrics.rangeBytes += archive.length;
            return archive;
          })();
          this.wholeArchivePending = pending;
          try {
            data = await pending;
          } finally {
            if (this.wholeArchivePending === pending)
              this.wholeArchivePending = undefined;
          }
        }
        return data.subarray(start, end + 1);
      } else {
        await response.body?.cancel();
        throw new Error(
          `Park archive requires valid byte ranges (HTTP ${response.status}).`,
        );
      }
      this.controller.signal.throwIfAborted();
      while (
        this.chunkBytes + data.length > 6 * 1024 * 1024 &&
        this.chunks.size
      ) {
        const key = this.chunks.keys().next().value!;
        this.chunkBytes -= this.chunks.get(key)!.length;
        this.chunks.delete(key);
      }
      this.chunks.set(index, data);
      this.chunkBytes += data.length;
      this.metrics.rangeBytes += data.length;
      return data;
    })();
    this.chunkPending.set(index, request);
    try {
      return await request;
    } finally {
      this.chunkPending.delete(index);
    }
  }
  async range(offset: number, length: number, signal?: AbortSignal) {
    this.controller.signal.throwIfAborted();
    if (
      ![offset, length].every(Number.isSafeInteger) ||
      offset < 0 ||
      length <= 0 ||
      length > 4 * 1024 * 1024 ||
      offset >= this.layer.bytes
    )
      throw new Error('Invalid park archive range.');
    // The PMTiles reader initially requests 16KiB even for smaller archives.
    const end = Math.min(this.layer.bytes, offset + length),
      data = new Uint8Array(end - offset);
    for (
      let i = Math.floor(offset / 65536);
      i <= Math.floor((end - 1) / 65536);
      i++
    ) {
      const chunk = await this.chunk(i, signal),
        start = Math.max(offset, i * 65536),
        stop = Math.min(end, (i + 1) * 65536);
      data.set(
        chunk.subarray(start - i * 65536, stop - i * 65536),
        start - offset,
      );
    }
    return { data: data.buffer };
  }
  async ready() {
    const h = await this.archive.getHeader();
    if (
      h.tileType !== 1 ||
      h.minZoom !== this.layer.minZoom ||
      h.maxZoom !== this.layer.maxZoom
    )
      throw new Error('Park archive header does not match its manifest.');
  }
  async tile(z: number, x: number, y: number) {
    parkTileAddress(z, x, y, this.layer.maxZoom);
    if (z > this.layer.maxZoom)
      throw new Error('Requested park tile exceeds source zoom.');
    const key = `${z}/${x}/${y}`,
      cached = this.tiles.get(key);
    if (cached) {
      this.tiles.delete(key);
      this.tiles.set(key, cached);
      return cached;
    }
    const existing = this.pending.get(key);
    if (existing) return existing;
    const request = (async () => {
      const result = await this.archive.getZxy(z, x, y, this.controller.signal);
      this.controller.signal.throwIfAborted();
      const tile = result
        ? decodeParkTile(result.data)
        : { polygons: [], lines: [], bytes: 1 };
      while (
        (this.tileBytes + tile.bytes > 8 * 1024 * 1024 ||
          this.tiles.size >= 96) &&
        this.tiles.size
      ) {
        const old = this.tiles.keys().next().value!;
        this.tileBytes -= this.tiles.get(old)!.bytes;
        this.tiles.delete(old);
      }
      if (tile.bytes <= 8 * 1024 * 1024) {
        this.tiles.set(key, tile);
        this.tileBytes += tile.bytes;
      }
      this.metrics.tiles++;
      return tile;
    })();
    this.pending.set(key, request);
    try {
      return await request;
    } finally {
      this.pending.delete(key);
    }
  }
  async identify(lon: number, lat: number) {
    const p = parkPointTile(lon, lat, this.layer.maxZoom),
      tile = await this.tile(this.layer.maxZoom, p.x, p.y);
    return [
      ...new Set(
        tile.polygons
          .filter((f) => parkContains(f.rings, p.u * f.extent, p.v * f.extent))
          .map((f) => f.id),
      ),
    ];
  }
}
