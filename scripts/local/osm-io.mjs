import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  open,
  stat,
  rename,
  mkdir,
  readFile,
  writeFile,
  rm,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await rename(temporary, path);
}
export async function jsonFile(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}
export async function hashFile(path, algorithm = 'sha256', signal) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path, { signal }))
    hash.update(chunk);
  return hash.digest('hex');
}
export async function boundedResponse(response, maximum) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Download service returned HTTP ${response.status}.`);
  }
  if (Number(response.headers.get('content-length')) > maximum) {
    await response.body?.cancel();
    throw new Error('Response exceeds its size limit.');
  }
  const chunks = [];
  let length = 0;
  if (!response.body) throw new Error('Empty response.');
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maximum) throw new Error('Response exceeds its size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}
export function validateSourceUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !['planet.openstreetmap.org', 'download.geofabrik.de'].includes(
      url.hostname,
    ) ||
    !/^\/[a-zA-Z0-9_./-]+\.osm\.pbf$/.test(url.pathname) ||
    url.pathname.includes('..') ||
    url.pathname.includes('full-history')
  )
    throw new Error('Choose an official current-state OSM PBF download.');
  return url.href;
}
export async function sourceMetadata(value, fetcher = fetch, signal) {
  const url = validateSourceUrl(value);
  const response = await fetcher(url, {
    method: 'HEAD',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000),
  });
  if (!response.ok || (response.url && !response.url.startsWith('https://')))
    throw new Error(`Cannot check download size (HTTP ${response.status}).`);
  const bytes = Number(response.headers.get('content-length'));
  if (!Number.isSafeInteger(bytes) || bytes <= 0)
    throw new Error(
      'The provider did not report a valid download size. Try again later.',
    );
  return {
    url,
    bytes,
    etag: response.headers.get('etag') || '',
    modified: response.headers.get('last-modified') || '',
  };
}
export async function downloadFile({
  url,
  path,
  bytes,
  etag = '',
  modified = '',
  signal,
  progress = () => {},
  fetcher = fetch,
}) {
  await mkdir(dirname(path), { recursive: true });
  let offset = await stat(path)
    .then((s) => s.size)
    .catch(() => 0);
  // A byte range may only be appended when tied to the same upstream representation.
  const validator = etag && !etag.startsWith('W/') ? etag : modified;
  if (offset > bytes || !validator) offset = 0;
  if (offset === bytes) return;
  const response = await fetcher(url, {
    signal,
    headers: offset ? { Range: `bytes=${offset}-`, 'If-Range': validator } : {},
  });
  if (response.url && !response.url.startsWith('https://')) {
    await response.body?.cancel();
    throw new Error('Download redirected away from HTTPS.');
  }
  if (offset && response.status === 200) offset = 0;
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Download returned HTTP ${response.status}.`);
  }
  if (
    offset &&
    response.headers.get('content-range') !==
      `bytes ${offset}-${bytes - 1}/${bytes}`
  ) {
    await response.body.cancel();
    throw new Error('Download resume returned an invalid byte range.');
  }
  if (!offset && response.status !== 200) {
    await response.body.cancel();
    throw new Error('Download did not return a complete file.');
  }
  const advertised = response.headers.get('content-length');
  if (advertised !== null && Number(advertised) !== bytes - offset) {
    await response.body.cancel();
    throw new Error('Download changed size. Check the source again.');
  }
  let total = offset;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > bytes)
        return callback(new Error('Download exceeded the advertised size.'));
      progress(total);
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body),
    meter,
    createWriteStream(path, { flags: offset ? 'a' : 'w' }),
    { signal },
  );
  if (total !== bytes)
    throw new Error('Download was incomplete. Resume to continue.');
}
export async function validatePbf(path) {
  if (!path.toLowerCase().endsWith('.osm.pbf'))
    throw new Error('Select an .osm.pbf file.');
  const info = await stat(path);
  if (!info.isFile() || info.size < 12)
    throw new Error('The selected file is not a valid OSM PBF.');
  const file = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(65540);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const length = bytes.readUInt32BE(0);
    if (length < 10 || length >= 65536 || length + 4 > bytesRead)
      throw new Error('The file does not have an OSM PBF header.');
    let position = 4,
      type = '',
      dataSize = 0;
    const end = 4 + length;
    const varint = () => {
      let value = 0,
        scale = 1;
      for (let count = 0; count < 10 && position < end; count++) {
        const byte = bytes[position++];
        value += (byte & 127) * scale;
        if (byte < 128 && Number.isSafeInteger(value)) return value;
        scale *= 128;
      }
      throw new Error('Invalid OSM PBF header encoding.');
    };
    while (position < end) {
      const field = varint(),
        wire = field % 8,
        number = Math.floor(field / 8);
      if (wire === 2) {
        const size = varint();
        if (position + size > end)
          throw new Error('Invalid OSM PBF header length.');
        if (number === 1)
          type = bytes.subarray(position, position + size).toString();
        position += size;
      } else if (wire === 0) {
        const value = varint();
        if (number === 3) dataSize = value;
      } else if (wire === 1) position += 8;
      else if (wire === 5) position += 4;
      else throw new Error('Invalid OSM PBF header field.');
    }
    if (
      position !== end ||
      type !== 'OSMHeader' ||
      dataSize < 1 ||
      dataSize > 32 * 1024 * 1024 ||
      end + dataSize > info.size
    )
      throw new Error('The file does not have a complete OSM PBF header.');
  } finally {
    await file.close();
  }
  return info;
}
export async function pmtilesHeader(path) {
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(127);
    const { bytesRead } = await file.read(header, 0, 127, 0);
    if (
      bytesRead !== 127 ||
      header.subarray(0, 7).toString() !== 'PMTiles' ||
      header[7] !== 3 ||
      header[99] !== 1
    )
      throw new Error('The converter did not produce valid vector PMTiles.');
    const minZoom = header[100],
      maxZoom = header[101];
    const bounds = [102, 106, 110, 114].map(
      (offset) => header.readInt32LE(offset) / 1e7,
    );
    if (
      minZoom > maxZoom ||
      maxZoom > 14 ||
      bounds.some((n) => !Number.isFinite(n))
    )
      throw new Error('Invalid prepared map bounds.');
    return { minZoom, maxZoom, bounds };
  } finally {
    await file.close();
  }
}
export function parseRange(value, size, maximum = 2 * 1024 * 1024) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(value || '');
  if (!match) throw new Error('A bounded byte range is required.');
  const start = Number(match[1]),
    end = Number(match[2]);
  if (
    ![start, end].every(Number.isSafeInteger) ||
    start < 0 ||
    end < start ||
    start >= size ||
    end - start + 1 > maximum
  )
    throw new Error('Invalid byte range.');
  return { start, end: Math.min(end, size - 1) };
}
export async function verifyDownload(path, expected, algorithm, signal) {
  if ((await hashFile(path, algorithm, signal)) !== expected.toLowerCase()) {
    await rm(path, { force: true });
    throw new Error(
      'Downloaded file failed checksum verification. Download it again.',
    );
  }
}
