import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const publicRoot = resolve(root, 'public');
const manifestPath = resolve(root, 'release/release-manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const archive = manifest.dataArchive;
const dataDirectories = manifest.dataDirectories;
const force = process.argv.includes('--force');
const utf8 = new TextDecoder('utf-8', { fatal: true });

function requireSafeManifest() {
  if (
    manifest.schemaVersion !== 1 ||
    !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
    manifest.tag !== `v${manifest.version}` ||
    manifest.repository !== 'jamezcody/OpenView'
  )
    throw new Error('The release manifest has an unsupported identity.');
  if (
    !Array.isArray(dataDirectories) ||
    dataDirectories.length === 0 ||
    new Set(dataDirectories.map((name) => name.toLowerCase())).size !==
      dataDirectories.length ||
    !dataDirectories.every((name) => /^[a-z][a-z0-9-]*$/.test(name))
  )
    throw new Error('The release manifest has invalid data directories.');

  const expectedName = `openview-data-${manifest.tag}.tar.gz`;
  const expectedUrl = `https://github.com/${manifest.repository}/releases/download/${manifest.tag}/${expectedName}`;
  if (
    !archive ||
    archive.name !== expectedName ||
    archive.url !== expectedUrl ||
    !/^[a-f0-9]{64}$/.test(archive.sha256) ||
    !Number.isSafeInteger(archive.compressedBytes) ||
    archive.compressedBytes <= 0 ||
    !Number.isSafeInteger(archive.fileCount) ||
    archive.fileCount <= 0 ||
    !Number.isSafeInteger(archive.uncompressedBytes) ||
    archive.uncompressedBytes <= 0 ||
    !Number.isSafeInteger(archive.maximumCompressedBytes) ||
    archive.compressedBytes > archive.maximumCompressedBytes ||
    !Number.isSafeInteger(archive.maximumFileCount) ||
    archive.fileCount > archive.maximumFileCount ||
    !Number.isSafeInteger(archive.maximumUncompressedBytes) ||
    archive.uncompressedBytes > archive.maximumUncompressedBytes
  )
    throw new Error('The release manifest has invalid data-archive metadata.');
  const url = new URL(archive.url);
  if (url.username || url.password || url.search || url.hash)
    throw new Error('The release archive URL contains forbidden URL state.');
}
requireSafeManifest();

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--'))
    throw new Error(`${name} requires a file path.`);
  return resolve(value);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function assertChildPath(path, parent, label) {
  const rel = relative(parent, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`Refusing to use an unsafe ${label}.`);
}

function assertDisposablePath(path, prefix) {
  if (dirname(path) !== root || !basename(path).startsWith(prefix))
    throw new Error(`Refusing to remove an unrecognized path: ${path}`);
}

const wait = (milliseconds) =>
  new Promise((accept) => setTimeout(accept, milliseconds));

async function removeWithRetries(path, options) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(path, options);
      return;
    } catch (error) {
      if (
        attempt >= 3 ||
        !['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error?.code)
      )
        throw error;
      await wait(100 * 2 ** attempt);
    }
  }
}

async function removeDisposablePath(path, prefix) {
  assertDisposablePath(path, prefix);
  await removeWithRetries(path, { recursive: true, force: true });
}

function readTarText(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return utf8.decode(field.subarray(0, end === -1 ? field.length : end));
}

function readTarOctal(header, offset, length, fieldName) {
  const text = readTarText(header, offset, length).trim();
  if (!/^[0-7]+$/.test(text))
    throw new Error(`The data archive has an invalid ${fieldName} field.`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`The data archive has an unsafe ${fieldName} value.`);
  return value;
}

function verifyTarChecksum(header) {
  const expected = readTarOctal(header, 148, 8, 'header checksum');
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  const actual = copy.reduce((sum, byte) => sum + byte, 0);
  if (actual !== expected)
    throw new Error('The data archive has an invalid TAR header checksum.');
}

function normalizedArchivePath(header, type) {
  const name = readTarText(header, 0, 100);
  const prefix = readTarText(header, 345, 155);
  let entry = prefix ? `${prefix}/${name}` : name;
  if (entry.startsWith('./')) entry = entry.slice(2);
  if (type === '5' && entry.endsWith('/')) entry = entry.slice(0, -1);
  const parts = entry.split('/');
  if (
    !entry ||
    !/^[A-Za-z0-9._/-]+$/.test(entry) ||
    entry.startsWith('/') ||
    /^[A-Za-z]:/.test(entry) ||
    posix.isAbsolute(entry) ||
    posix.normalize(entry) !== entry ||
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        part.endsWith('.') ||
        part.endsWith(' ') ||
        /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part),
    )
  )
    throw new Error('The data archive contains an unsafe Windows path.');
  if (
    !dataDirectories.some(
      (directory) =>
        entry === `public/${directory}` ||
        entry.startsWith(`public/${directory}/`),
    )
  )
    throw new Error('The data archive contains an unexpected path.');
  return entry;
}

class BoundedReader {
  constructor(source, maximumBytes) {
    this.iterator = source[Symbol.asyncIterator]();
    this.maximumBytes = maximumBytes;
    this.buffer = Buffer.alloc(0);
    this.bytes = 0;
    this.done = false;
  }

  async fill(length) {
    while (!this.done && this.buffer.length < length) {
      const next = await this.iterator.next();
      if (next.done) {
        this.done = true;
        break;
      }
      const chunk = Buffer.isBuffer(next.value)
        ? next.value
        : Buffer.from(next.value);
      this.bytes += chunk.length;
      if (this.bytes > this.maximumBytes)
        throw new Error('The data archive exceeds its decompression limit.');
      this.buffer =
        this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    }
  }

  async readExactly(length, allowEnd = false) {
    await this.fill(length);
    if (this.buffer.length === 0 && this.done && allowEnd) return null;
    if (this.buffer.length < length)
      throw new Error('The data archive is truncated.');
    const value = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return value;
  }

  async requireZerosToEnd() {
    while (true) {
      if (this.buffer.some((byte) => byte !== 0))
        throw new Error(
          'The data archive contains content after its end marker.',
        );
      this.buffer = Buffer.alloc(0);
      if (this.done) return;
      await this.fill(1);
    }
  }
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.length - offset,
      null,
    );
    if (bytesWritten <= 0)
      throw new Error('A staged data file could not be written.');
    offset += bytesWritten;
  }
}

async function parseTar(source, extractionRoot) {
  const maximumTarBytes =
    archive.maximumUncompressedBytes + archive.maximumFileCount * 1024 + 1024;
  const reader = new BoundedReader(source, maximumTarBytes);
  const inventory = new Map();
  const seen = new Set();
  const seenPointers = new Set();
  let entries = 0;
  let files = 0;
  let uncompressedBytes = 0;
  let zeroBlocks = 0;

  while (true) {
    const header = await reader.readExactly(512, true);
    if (!header)
      throw new Error('The data archive has no complete TAR end marker.');
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      if (zeroBlocks === 2) {
        await reader.requireZerosToEnd();
        break;
      }
      continue;
    }
    if (zeroBlocks !== 0)
      throw new Error('The data archive has an invalid TAR end marker.');

    entries += 1;
    if (entries > archive.maximumFileCount)
      throw new Error('The data archive exceeds its entry-count limit.');
    verifyTarChecksum(header);
    if (readTarText(header, 257, 6) !== 'ustar')
      throw new Error('The data archive must use the USTAR format.');
    const rawType = header[156];
    const type = rawType === 0 ? '0' : String.fromCharCode(rawType);
    if (type !== '0' && type !== '5')
      throw new Error('The data archive contains a non-regular entry.');
    const size = readTarOctal(header, 124, 12, 'file size');
    if (type === '5' && size !== 0)
      throw new Error('The data archive contains a non-empty directory entry.');
    const entry = normalizedArchivePath(header, type);
    const identity = entry.toUpperCase();
    if (seen.has(identity))
      throw new Error('The data archive contains a duplicate path.');
    seen.add(identity);

    if (type === '0') {
      files += 1;
      uncompressedBytes += size;
      if (
        files > archive.maximumFileCount ||
        uncompressedBytes > archive.maximumUncompressedBytes
      )
        throw new Error('The data archive exceeds its extraction limits.');
      inventory.set(entry, size);
      for (const directory of dataDirectories)
        if (entry === `public/${directory}/latest.json`)
          seenPointers.add(directory);
    }

    let output;
    if (extractionRoot) {
      const target = resolve(extractionRoot, ...entry.split('/'));
      assertChildPath(target, extractionRoot, 'archive destination');
      if (type === '5') {
        await mkdir(target, { recursive: true });
      } else {
        await mkdir(dirname(target), { recursive: true });
        output = await open(target, 'wx', 0o644);
      }
    }

    try {
      let remaining = size;
      while (remaining > 0) {
        const length = Math.min(remaining, 64 * 1024);
        const chunk = await reader.readExactly(length);
        if (output) await writeAll(output, chunk);
        remaining -= length;
      }
    } finally {
      await output?.close();
    }

    const paddingLength = (512 - (size % 512)) % 512;
    if (paddingLength) {
      const padding = await reader.readExactly(paddingLength);
      if (padding.some((byte) => byte !== 0))
        throw new Error('The data archive has non-zero TAR padding.');
    }
  }

  if (
    files !== archive.fileCount ||
    uncompressedBytes !== archive.uncompressedBytes ||
    seenPointers.size !== dataDirectories.length
  )
    throw new Error('The data archive does not match the release manifest.');
  return { entries, files, inventory, uncompressedBytes };
}

function sameFile(before, after) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

async function verifyAndExtract(path, extractionRoot) {
  const handle = await open(path, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.size !== BigInt(archive.compressedBytes) ||
      before.size > BigInt(archive.maximumCompressedBytes)
    )
      throw new Error('The data archive has an unexpected compressed size.');

    const digest = createHash('sha256');
    let compressedBytes = 0;
    let verified;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        compressedBytes += chunk.length;
        if (
          compressedBytes > archive.compressedBytes ||
          compressedBytes > archive.maximumCompressedBytes
        ) {
          callback(
            new Error('The data archive exceeds its compressed-size limit.'),
          );
          return;
        }
        digest.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      handle.createReadStream({ autoClose: false, start: 0 }),
      meter,
      createGunzip(),
      async (source) => {
        verified = await parseTar(source, extractionRoot);
      },
    );
    const after = await handle.stat({ bigint: true });
    if (!sameFile(before, after))
      throw new Error('The data archive changed while it was being read.');
    if (
      compressedBytes !== archive.compressedBytes ||
      digest.digest('hex') !== archive.sha256
    )
      throw new Error('The data archive failed release verification.');
    return verified;
  } finally {
    await handle.close();
  }
}

async function validateStagedTree(stagingRoot, inventory) {
  const remaining = new Map(inventory);
  let files = 0;
  let bytes = 0;
  async function walk(directory, archiveDirectory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const details = await lstat(path);
      if (details.isSymbolicLink())
        throw new Error('The staged data contains a reparse point.');
      const archivePath = archiveDirectory
        ? `${archiveDirectory}/${entry.name}`
        : entry.name;
      if (details.isDirectory()) await walk(path, archivePath);
      else if (details.isFile()) {
        const expectedSize = remaining.get(archivePath);
        if (expectedSize === undefined || details.size !== expectedSize)
          throw new Error('The staged data tree does not match the archive.');
        remaining.delete(archivePath);
        files += 1;
        bytes += details.size;
      } else {
        throw new Error('The staged data contains an unsupported entry.');
      }
    }
  }
  await walk(stagingRoot, '');
  if (
    remaining.size !== 0 ||
    files !== archive.fileCount ||
    bytes !== archive.uncompressedBytes
  )
    throw new Error('The staged data tree is incomplete.');
}

async function installedDataMatchesMarker(markerPath) {
  try {
    if (
      (await readFile(markerPath, 'utf8')).trim() !==
      `${archive.sha256}  ${archive.name}`
    )
      return false;
    let files = 0;
    let bytes = 0;
    async function walk(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        const details = await lstat(path);
        if (details.isSymbolicLink()) return false;
        if (details.isDirectory()) {
          if (!(await walk(path))) return false;
        } else if (details.isFile()) {
          files += 1;
          bytes += details.size;
          if (files > archive.fileCount || bytes > archive.uncompressedBytes)
            return false;
        } else {
          return false;
        }
      }
      return true;
    }
    for (const name of dataDirectories) {
      const directory = resolve(publicRoot, name);
      const details = await lstat(directory);
      if (details.isSymbolicLink() || !details.isDirectory()) return false;
      if (!(await walk(directory))) return false;
    }
    return files === archive.fileCount && bytes === archive.uncompressedBytes;
  } catch {
    return false;
  }
}

async function assertReplaceableDataTrees() {
  let entries = 0;
  async function walk(path) {
    const details = await lstat(path);
    if (details.isSymbolicLink())
      throw new Error('Existing prepared data contains a reparse point.');
    entries += 1;
    if (entries > archive.maximumFileCount)
      throw new Error('Existing prepared data exceeds the replacement limit.');
    if (details.isDirectory()) {
      for (const entry of await readdir(path)) await walk(resolve(path, entry));
    } else if (!details.isFile()) {
      throw new Error('Existing prepared data contains an unsupported entry.');
    }
  }
  for (const name of dataDirectories) {
    const destination = resolve(publicRoot, name);
    if (await exists(destination)) await walk(destination);
  }
}

const verifyPath = optionValue('--verify-archive');
if (verifyPath) {
  const verified = await verifyAndExtract(verifyPath);
  console.log(
    `Verified ${archive.name}: ${verified.files.toLocaleString()} regular files, ${verified.uncompressedBytes.toLocaleString()} source bytes, and the pinned SHA-256 digest.`,
  );
  process.exit(0);
}

const markerPath = resolve(publicRoot, `.openview-data-${manifest.tag}.sha256`);
if (!force && (await installedDataMatchesMarker(markerPath))) {
  console.log(
    'The checksum-pinned prepared datasets match the installed file inventory; leaving them unchanged. Pass --force to reinstall them.',
  );
  process.exit(0);
}

const suppliedArchive = optionValue('--archive');
const temporaryRoot = suppliedArchive
  ? undefined
  : await mkdtemp(join(tmpdir(), 'openview-data-'));
const archivePath = suppliedArchive ?? resolve(temporaryRoot, archive.name);
const operationId = randomUUID();
const stagingRoot = resolve(root, `.openview-data-staging-${operationId}`);
const backupRoot = resolve(root, `.openview-data-backup-${operationId}`);
const transitions = [];
const cleanupWarnings = [];
let preserveBackup = false;
let terminalError;
let verified;

try {
  if (!suppliedArchive) {
    console.log(`Downloading ${archive.name}...`);
    const response = await fetch(archive.url, {
      headers: { 'user-agent': `OpenView-data-installer/${manifest.version}` },
      redirect: 'follow',
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    if (!response.ok || !response.body)
      throw new Error(`Data download failed with HTTP ${response.status}.`);
    const declaredLength = Number(response.headers.get('content-length'));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > archive.maximumCompressedBytes
    )
      throw new Error(
        'The data archive exceeds the configured download limit.',
      );
    let bytes = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > archive.maximumCompressedBytes) {
          callback(
            new Error(
              'The data archive exceeds the configured download limit.',
            ),
          );
          return;
        }
        callback(null, chunk);
      },
    });
    await pipeline(
      response.body,
      meter,
      createWriteStream(archivePath, { flags: 'wx' }),
    );
  }

  await mkdir(stagingRoot, { recursive: false });
  await mkdir(backupRoot, { recursive: false });
  verified = await verifyAndExtract(archivePath, stagingRoot);
  await validateStagedTree(stagingRoot, verified.inventory);
  for (const name of dataDirectories)
    JSON.parse(
      await readFile(
        resolve(stagingRoot, 'public', name, 'latest.json'),
        'utf8',
      ),
    );
  await assertReplaceableDataTrees();

  for (const name of dataDirectories) {
    const transition = {
      backup: resolve(backupRoot, name),
      destination: resolve(publicRoot, name),
      newActivated: false,
      originalMoved: false,
    };
    transitions.push(transition);
    if (await exists(transition.destination)) {
      await rename(transition.destination, transition.backup);
      transition.originalMoved = true;
    }
    await rename(resolve(stagingRoot, 'public', name), transition.destination);
    transition.newActivated = true;
  }
  await writeFile(markerPath, `${archive.sha256}  ${archive.name}\n`, {
    flag: 'w',
  });
} catch (error) {
  const rollbackErrors = [];
  for (const transition of transitions.reverse()) {
    try {
      if (transition.newActivated)
        await removeWithRetries(transition.destination, {
          recursive: true,
          force: true,
        });
      if (transition.originalMoved)
        await rename(transition.backup, transition.destination);
    } catch (rollbackError) {
      preserveBackup = true;
      rollbackErrors.push(rollbackError);
    }
  }
  terminalError =
    rollbackErrors.length === 0
      ? error
      : new AggregateError(
          [error, ...rollbackErrors],
          `Data installation failed and automatic restoration was incomplete. Recovery data was preserved at ${backupRoot}.`,
        );
}

for (const [path, prefix] of [
  [stagingRoot, '.openview-data-staging-'],
  ...(preserveBackup ? [] : [[backupRoot, '.openview-data-backup-']]),
]) {
  try {
    await removeDisposablePath(path, prefix);
  } catch (error) {
    cleanupWarnings.push({ error, path });
  }
}
if (temporaryRoot) {
  try {
    await removeWithRetries(temporaryRoot, { recursive: true, force: true });
  } catch (error) {
    cleanupWarnings.push({ error, path: temporaryRoot });
  }
}
for (const warning of cleanupWarnings)
  console.error(
    `Warning: cleanup could not remove ${warning.path}: ${warning.error?.message ?? warning.error}`,
  );

if (terminalError) throw terminalError;
console.log(
  `Installed ${dataDirectories.length} checksum-verified datasets (${verified.files.toLocaleString()} files).`,
);
