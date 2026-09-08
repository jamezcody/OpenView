import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { isAbsolute, relative, sep } from 'node:path';
import { finished } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function assertChildPath(path, parent, label = 'path') {
  const rel = relative(parent, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`Refusing to use an unsafe ${label}.`);
}

export function assertReleaseArchive(metadata, archive, stem, label) {
  if (
    metadata?.schemaVersion !== 1 ||
    typeof metadata.version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(metadata.version) ||
    metadata.tag !== `v${metadata.version}` ||
    typeof metadata.repository !== 'string' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(metadata.repository)
  )
    throw new Error('The release manifest identity is invalid.');

  const expectedName = `${stem}-${metadata.tag}.tar.gz`;
  const expectedUrl = `https://github.com/${metadata.repository}/releases/download/${metadata.tag}/${expectedName}`;
  if (!archive || archive.name !== expectedName || archive.url !== expectedUrl)
    throw new Error(`The release manifest has an invalid ${label} archive.`);
}

function assertArchivePath(path) {
  const parts = path.split('/');
  const hasControlCharacter = Array.from(path).some((character) => {
    const code = character.codePointAt(0);
    return code < 0x20 || code === 0x7f;
  });
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    hasControlCharacter ||
    /^[A-Za-z]:/.test(path) ||
    parts.some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`Unsafe archive path: ${path}`);
}

export async function collectRegularFiles(
  sourceRoot,
  archiveRoot,
  { exclude = () => false } = {},
) {
  assertArchivePath(archiveRoot);
  const files = [];

  async function walk(directory, archiveDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => byteCompare(a.name, b.name));
    for (const entry of entries) {
      const archivePath = `${archiveDirectory}/${entry.name}`;
      assertArchivePath(archivePath);
      if (exclude(archivePath, entry)) continue;

      const path = `${directory}${sep}${entry.name}`;
      if (entry.isDirectory()) await walk(path, archivePath);
      else if (entry.isFile())
        files.push({
          path,
          archivePath,
          snapshot: await stat(path, { bigint: true }),
        });
      else throw new Error(`Unsupported filesystem entry: ${archivePath}`);
    }
  }

  await walk(sourceRoot, archiveRoot);
  files.sort((a, b) => byteCompare(a.archivePath, b.archivePath));
  return files;
}

function writeText(header, offset, length, value, field) {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length > length)
    throw new Error(`${field} exceeds the deterministic USTAR field limit.`);
  encoded.copy(header, offset);
}

function writeOctal(header, offset, length, value, field) {
  const encoded = value.toString(8).padStart(length - 1, '0') + '\0';
  if (encoded.length !== length)
    throw new Error(`${field} exceeds the deterministic USTAR numeric limit.`);
  header.write(encoded, offset, length, 'ascii');
}

function splitTarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
  for (
    let index = path.lastIndexOf('/');
    index > 0;
    index = path.lastIndexOf('/', index - 1)
  ) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100)
      return { name, prefix };
  }
  return null;
}

export function tarHeader(path, size, type = '0') {
  const header = Buffer.alloc(512);
  const split = splitTarPath(path);
  if (!split)
    throw new Error(`Archive header path exceeds the USTAR limit: ${path}`);
  const { name, prefix } = split;
  writeText(header, 0, 100, name, 'name');
  writeOctal(header, 100, 8, 0o644, 'mode');
  writeOctal(header, 108, 8, 0, 'uid');
  writeOctal(header, 116, 8, 0, 'gid');
  writeOctal(header, 124, 12, size, 'size');
  writeOctal(header, 136, 12, 0, 'mtime');
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  writeText(header, 257, 6, 'ustar\0', 'magic');
  writeText(header, 263, 2, '00', 'version');
  writeText(header, 265, 32, 'openview', 'owner');
  writeText(header, 297, 32, 'openview', 'group');
  writeText(header, 345, 155, prefix, 'prefix');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function paxRecord(name, value) {
  const body = `${name}=${value}\n`;
  let length = Buffer.byteLength(body) + 2;
  while (true) {
    const next = Buffer.byteLength(body) + String(length).length + 1;
    if (next === length) return Buffer.from(`${length} ${body}`, 'utf8');
    length = next;
  }
}

async function writeTarPayload(write, payload) {
  await write(payload);
  const padding = (512 - (payload.length % 512)) % 512;
  if (padding) await write(Buffer.alloc(padding));
}

function unchanged(before, after) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

export function assertSameFileInventory(before, after) {
  if (before.length !== after.length)
    throw new Error('The archive input inventory changed while archiving.');
  for (let index = 0; index < before.length; index += 1) {
    if (
      before[index].archivePath !== after[index].archivePath ||
      !unchanged(before[index].snapshot, after[index].snapshot)
    )
      throw new Error(
        `The archive input inventory changed while archiving: ${before[index].archivePath}.`,
      );
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function replaceFileSafely(temporary, output) {
  try {
    await rename(temporary, output);
    return;
  } catch (error) {
    if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error;
  }

  const backup = `${output}.${randomUUID()}.previous`;
  let backedUp = false;
  try {
    await rename(output, backup);
    backedUp = true;
    await rename(temporary, output);
  } catch (error) {
    if (backedUp && !(await exists(output))) {
      try {
        await rename(backup, output);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `Could not replace or restore ${output}. The prior file remains at ${backup}.`,
        );
      }
    }
    throw error;
  }
  await rm(backup, { force: true });
}

export async function createDeterministicTarGzip({
  files,
  output,
  maximumCompressedBytes,
  maximumFileCount,
  maximumUncompressedBytes,
  beforeCommit,
}) {
  if (!Number.isSafeInteger(maximumFileCount) || maximumFileCount < 1)
    throw new Error('The maximum archive file count is invalid.');
  if (
    !Number.isSafeInteger(maximumCompressedBytes) ||
    maximumCompressedBytes < 1
  )
    throw new Error('The maximum compressed archive size is invalid.');
  if (
    !Number.isSafeInteger(maximumUncompressedBytes) ||
    maximumUncompressedBytes < 1
  )
    throw new Error('The maximum uncompressed archive size is invalid.');
  if (files.length === 0 || files.length > maximumFileCount)
    throw new Error('The archive file count is outside its configured limit.');

  const names = new Set();
  for (const file of files) {
    assertArchivePath(file.archivePath);
    const folded = file.archivePath.toLowerCase();
    if (names.has(folded))
      throw new Error(`Duplicate archive path: ${file.archivePath}`);
    names.add(folded);
  }

  const temporary = `${output}.${randomUUID()}.tmp`;
  const gzip = createGzip({ level: 9, mtime: 0 });
  const destination = createWriteStream(temporary, { flags: 'wx' });
  gzip.pipe(destination);
  gzip.once('error', (error) => destination.destroy(error));
  destination.once('error', (error) => gzip.destroy(error));

  async function write(chunk) {
    if (!gzip.write(chunk)) await once(gzip, 'drain');
  }

  let uncompressedBytes = 0;
  try {
    for (const [index, file] of files.entries()) {
      const handle = await open(file.path, 'r');
      let before;
      let bytesRead = 0n;
      try {
        before = await handle.stat({ bigint: true });
        if (!before.isFile())
          throw new Error(
            `Archive input is no longer a file: ${file.archivePath}`,
          );
        if (!file.snapshot || !unchanged(file.snapshot, before))
          throw new Error(
            `Archive input changed after discovery: ${file.archivePath}`,
          );
        if (before.size > BigInt(Number.MAX_SAFE_INTEGER))
          throw new Error(`Archive input is too large: ${file.archivePath}`);

        uncompressedBytes += Number(before.size);
        if (uncompressedBytes > maximumUncompressedBytes)
          throw new Error('The archive exceeds its uncompressed-size limit.');

        let headerPath = file.archivePath;
        if (!splitTarPath(headerPath)) {
          const identifier = String(index).padStart(8, '0');
          const paxPayload = paxRecord('path', headerPath);
          await write(
            tarHeader(
              `PaxHeaders/openview-${identifier}`,
              paxPayload.length,
              'x',
            ),
          );
          await writeTarPayload(write, paxPayload);
          headerPath = `PaxPayload/openview-${identifier}`;
        }
        await write(tarHeader(headerPath, Number(before.size)));
        for await (const chunk of handle.createReadStream({
          autoClose: false,
        })) {
          bytesRead += BigInt(chunk.length);
          if (bytesRead > before.size)
            throw new Error(
              `Archive input grew while reading: ${file.archivePath}`,
            );
          await write(chunk);
        }
        const after = await handle.stat({ bigint: true });
        if (bytesRead !== before.size || !unchanged(before, after))
          throw new Error(
            `Archive input changed while reading: ${file.archivePath}`,
          );

        const padding = (512 - (Number(before.size) % 512)) % 512;
        if (padding) await write(Buffer.alloc(padding));
      } finally {
        await handle.close();
      }

      const current = await stat(file.path, { bigint: true });
      if (!unchanged(before, current))
        throw new Error(
          `Archive input was replaced while reading: ${file.archivePath}`,
        );
    }

    await write(Buffer.alloc(1024));
    gzip.end();
    await finished(destination);
  } catch (error) {
    gzip.destroy(error);
    destination.destroy(error);
    await rm(temporary, { force: true });
    throw error;
  }

  let outputStats;
  let sha256;
  try {
    outputStats = await stat(temporary);
    if (outputStats.size > maximumCompressedBytes)
      throw new Error('The archive exceeds its compressed-size limit.');

    const digest = createHash('sha256');
    for await (const chunk of createReadStream(temporary)) digest.update(chunk);
    sha256 = digest.digest('hex');
    if (beforeCommit) await beforeCommit();
    await replaceFileSafely(temporary, output);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return {
    sha256,
    compressedBytes: outputStats.size,
    fileCount: files.length,
    uncompressedBytes,
  };
}
