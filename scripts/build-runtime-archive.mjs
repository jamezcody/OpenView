import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertChildPath,
  assertReleaseArchive,
  assertSameFileInventory,
  createDeterministicTarGzip,
  replaceFileSafely,
} from './deterministic-archive.mjs';
import { collectRuntimeFiles } from './runtime-archive-files.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const metadataPath = resolve(root, 'release/release-manifest.json');
const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
const archive = metadata.runtimeArchive;
const artifactRoot = resolve(root, 'artifacts');
const artifactDirectory = resolve(artifactRoot, metadata.tag ?? '');
const output = resolve(artifactDirectory, archive?.name ?? '');
const workRoot = resolve(root, 'work/runtime-archive');

if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error(
    'The win-x64 runtime archive must be built on 64-bit Windows.',
  );
assertReleaseArchive(metadata, archive, 'openview-runtime-win-x64', 'runtime');
if (
  !Array.isArray(metadata.dataDirectories) ||
  metadata.dataDirectories.length === 0 ||
  !metadata.dataDirectories.every((name) => /^[a-z][a-z0-9-]*$/.test(name)) ||
  new Set(metadata.dataDirectories).size !== metadata.dataDirectories.length
)
  throw new Error('The release manifest has invalid data directories.');
assertChildPath(artifactDirectory, artifactRoot, 'artifact directory');
assertChildPath(output, artifactDirectory, 'runtime-archive output path');

const packageMetadata = JSON.parse(
  await readFile(resolve(root, 'package.json'), 'utf8'),
);
const runtimePackageMetadata = JSON.parse(
  await readFile(resolve(root, 'runtime/package.json'), 'utf8'),
);
if (
  packageMetadata.name !== 'openview' ||
  packageMetadata.version !== metadata.version ||
  packageMetadata.engines?.node !== '>=22.13.0' ||
  runtimePackageMetadata.name !== 'openview-runtime-win-x64' ||
  runtimePackageMetadata.version !== metadata.version ||
  runtimePackageMetadata.engines?.node !== packageMetadata.engines.node ||
  runtimePackageMetadata.dependencies?.wrangler !==
    packageMetadata.devDependencies?.wrangler ||
  runtimePackageMetadata.dependencies?.ws !== packageMetadata.dependencies?.ws
)
  throw new Error(
    'The application, runtime, and release manifest versions are inconsistent.',
  );

const requiredBuildFiles = [
  'dist/server/index.js',
  'dist/server/wrangler.json',
  'dist/client/favicon.svg',
  'dist/local/server.mjs',
  'dist/local/prepared-data.mjs',
  'dist/local/radio-search.mjs',
  'dist/local/radio-search-worker.mjs',
  'dist/local/ship-service.mjs',
  'dist/local/ais-credential.ps1',
];
for (const path of requiredBuildFiles)
  await readFile(resolve(root, path)).catch(() => {
    throw new Error(`Run npm run build first; ${path} is missing.`);
  });

const probePath = metadata.runtimeProbe?.path;
const probeSha256 = metadata.runtimeProbe?.sha256;
if (
  typeof probePath !== 'string' ||
  !/^\/[A-Za-z0-9._/-]+$/.test(probePath) ||
  probePath.split('/').some((part) => part === '..' || part === '.')
)
  throw new Error('The release manifest has an invalid runtime probe path.');
if (typeof probeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(probeSha256))
  throw new Error('The release manifest has an invalid runtime probe digest.');
const probeDigest = createHash('sha256');
const clientRoot = resolve(root, 'dist/client');
const probeFile = resolve(clientRoot, probePath.slice(1));
assertChildPath(probeFile, clientRoot, 'runtime probe path');
for await (const chunk of createReadStream(probeFile))
  probeDigest.update(chunk);
if (probeDigest.digest('hex') !== probeSha256)
  throw new Error(
    'The built runtime probe does not match the release manifest.',
  );

const workerConfig = JSON.parse(
  await readFile(resolve(root, 'dist/server/wrangler.json'), 'utf8'),
);
if (
  workerConfig.main !== 'index.js' ||
  workerConfig.assets?.directory !== '../client' ||
  Object.keys(workerConfig.vars ?? {}).length !== 0
)
  throw new Error('The production Worker configuration is unexpected.');

await new Promise((accept, reject) => {
  const child = spawn(
    process.execPath,
    [resolve(root, 'scripts/audit-credentials.mjs'), '--generated', 'dist'],
    { cwd: root, stdio: 'inherit', windowsHide: true },
  );
  child.once('error', reject);
  child.once('exit', (code) => {
    if (code === 0) accept();
    else
      reject(
        new Error(`The generated credential audit exited with code ${code}.`),
      );
  });
});

await mkdir(workRoot, { recursive: true });
const staging = await mkdtemp(join(workRoot, 'build-'));
assertChildPath(staging, workRoot, 'runtime staging path');

async function runNpmCi(directory) {
  const npmCli = resolve(
    dirname(process.execPath),
    'node_modules/npm/bin/npm-cli.js',
  );
  await readFile(npmCli).catch(() => {
    throw new Error('npm-cli.js was not found beside Node.js.');
  });
  await new Promise((accept, reject) => {
    const child = spawn(
      process.execPath,
      [
        npmCli,
        'ci',
        '--omit=dev',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ],
      { cwd: directory, stdio: 'inherit', windowsHide: true },
    );
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) accept();
      else
        reject(new Error(`The runtime npm install exited with code ${code}.`));
    });
  });
}

try {
  await copyFile(
    resolve(root, 'runtime/package.json'),
    resolve(staging, 'package.json'),
  );
  await copyFile(
    resolve(root, 'runtime/package-lock.json'),
    resolve(staging, 'package-lock.json'),
  );
  await runNpmCi(staging);

  const files = await collectRuntimeFiles(
    root,
    staging,
    metadata.dataDirectories,
  );

  await mkdir(artifactDirectory, { recursive: true });
  const result = await createDeterministicTarGzip({
    files,
    output,
    maximumCompressedBytes: archive.maximumCompressedBytes,
    maximumFileCount: archive.maximumFileCount,
    maximumUncompressedBytes: archive.maximumUncompressedBytes,
    async beforeCommit() {
      assertSameFileInventory(
        files,
        await collectRuntimeFiles(root, staging, metadata.dataDirectories),
      );
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
} finally {
  assertChildPath(staging, workRoot, 'runtime staging path');
  await rm(staging, { recursive: true, force: true });
}
