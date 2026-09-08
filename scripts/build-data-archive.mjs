import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertChildPath,
  assertReleaseArchive,
  assertSameFileInventory,
  createDeterministicTarGzip,
  replaceFileSafely,
} from './deterministic-archive.mjs';
import { collectDataFiles } from './data-archive-files.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const metadataPath = resolve(root, 'release/release-manifest.json');
const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
const directories = metadata.dataDirectories;
const archive = metadata.dataArchive;
const artifactRoot = resolve(root, 'artifacts');
const artifactDirectory = resolve(artifactRoot, metadata.tag ?? '');
const output = resolve(artifactDirectory, archive?.name ?? '');

if (
  !Array.isArray(directories) ||
  directories.length === 0 ||
  !directories.every((name) => /^[a-z][a-z0-9-]*$/.test(name)) ||
  new Set(directories).size !== directories.length
)
  throw new Error('The release manifest has invalid data directories.');
assertReleaseArchive(metadata, archive, 'openview-data', 'data');
assertChildPath(artifactDirectory, artifactRoot, 'artifact directory');
assertChildPath(output, artifactDirectory, 'data-archive output path');

const files = await collectDataFiles(root, directories);

await mkdir(artifactDirectory, { recursive: true });
const result = await createDeterministicTarGzip({
  files,
  output,
  maximumCompressedBytes: archive.maximumCompressedBytes,
  maximumFileCount: archive.maximumFileCount,
  maximumUncompressedBytes: archive.maximumUncompressedBytes,
  async beforeCommit() {
    assertSameFileInventory(files, await collectDataFiles(root, directories));
  },
});

Object.assign(archive, result);
const temporaryManifest = `${metadataPath}.${randomUUID()}.tmp`;
await writeFile(temporaryManifest, `${JSON.stringify(metadata, null, 2)}\n`, {
  flag: 'wx',
});
try {
  await replaceFileSafely(temporaryManifest, metadataPath);
} catch (error) {
  await rm(temporaryManifest, { force: true });
  throw error;
}

console.log(
  `Built ${relative(root, output)}: ${result.fileCount.toLocaleString()} files, ${result.uncompressedBytes.toLocaleString()} source bytes, ${result.compressedBytes.toLocaleString()} compressed bytes, SHA-256 ${result.sha256}.`,
);
