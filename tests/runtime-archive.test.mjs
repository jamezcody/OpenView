import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

// Load production packaging helpers without executing a release build. The
// standard test runner copies tests and local runtime modules only.
const { collectRuntimeFiles, requiredRuntimeFiles } = await import(
  pathToFileURL(resolve('scripts/runtime-archive-files.mjs'))
);
const { createDeterministicTarGzip, tarHeader } = await import(
  pathToFileURL(resolve('scripts/deterministic-archive.mjs'))
);

async function fixture() {
  const parent = resolve('work/runtime-archive-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'case-'));
  const dependencies = join(root, 'dependencies');
  async function write(path, body = 'fixture content\n') {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }
  for (const name of requiredRuntimeFiles) {
    const path =
      name === 'launch-local.mjs'
        ? join(root, 'installer/launch-local.mjs')
        : name.startsWith('node_modules/')
          ? join(dependencies, name)
          : join(root, name);
    await write(path, `fixture ${name}\n`);
  }
  for (const name of ['radio', 'search', 'parks']) {
    await write(join(root, 'dist/client', name, 'latest.json'), '{}');
    await write(join(root, 'dist/prepared', name, 'latest.json'), '{}');
  }
  for (const name of ['local', 'client', 'server'])
    await write(join(root, 'dist', name, '.wrangler/private.json'), '{}');
  await write(
    join(root, 'dist/client/.openview-data-v0.2.0.sha256'),
    'old data marker',
  );
  return {
    root,
    dependencies,
    write,
    directories: ['radio', 'search', 'parks'],
  };
}

test('runtime inventory includes standalone launcher and complete radio runtime while excluding prepared datasets', async () => {
  const data = await fixture();
  try {
    const files = await collectRuntimeFiles(
      data.root,
      data.dependencies,
      data.directories,
    );
    const names = files.map((file) => file.archivePath);
    assert.deepEqual(
      names,
      [...requiredRuntimeFiles].sort((left, right) =>
        left === right ? 0 : left < right ? -1 : 1,
      ),
    );
    const launcher = files.find(
      (file) => file.archivePath === 'launch-local.mjs',
    );
    assert.equal(
      await readFile(launcher.path, 'utf8'),
      'fixture launch-local.mjs\n',
    );
    await rm(join(data.root, 'dist/local/radio-search-worker.mjs'));
    await assert.rejects(
      collectRuntimeFiles(data.root, data.dependencies, data.directories),
      /missing dist\/local\/radio-search-worker.mjs/,
    );
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});

test('release USTAR numeric headers preserve the full 6.1 GB SQLite length and refuse 8 GiB overflow', () => {
  for (const size of [6_101_401_600, 8 * 1024 ** 3 - 1]) {
    const header = tarHeader(
      'public/search/search-471e585387c4f3caf437/radio.sqlite',
      size,
    );
    assert.equal(
      Number.parseInt(header.subarray(124, 135).toString('ascii'), 8),
      size,
    );
    assert.equal(header[135], 0);
  }
  assert.throws(
    () => tarHeader('public/search/radio.sqlite', 8 * 1024 ** 3),
    /numeric limit/,
  );
});

test('release runtime archive remains deterministic and uses only paired path PAX for long asset names', async () => {
  const data = await fixture();
  try {
    const longName = `dist/server/assets/${'x'.repeat(101)}.js`;
    await data.write(join(data.root, longName), 'long runtime asset\n');
    const files = await collectRuntimeFiles(
      data.root,
      data.dependencies,
      data.directories,
    );
    const limits = {
      maximumFileCount: 100,
      maximumUncompressedBytes: 1024 ** 2,
      maximumCompressedBytes: 1024 ** 2,
    };
    const output = join(data.root, 'one.tar.gz');
    const first = await createDeterministicTarGzip({
      files,
      output,
      ...limits,
    });
    const second = await createDeterministicTarGzip({
      files,
      output: join(data.root, 'two.tar.gz'),
      ...limits,
    });
    assert.equal(first.sha256, second.sha256);
    const bytes = gunzipSync(await readFile(output));
    const names = [];
    let pendingPath, pendingIdentifier;
    for (
      let offset = 0;
      !bytes.subarray(offset, offset + 512).every((byte) => byte === 0);
    ) {
      const header = bytes.subarray(offset, offset + 512);
      const text = (start, length) =>
        header
          .subarray(start, start + length)
          .toString('utf8')
          .split('\0')[0];
      const rawName = [text(345, 155), text(0, 100)].filter(Boolean).join('/');
      const size = Number.parseInt(text(124, 12), 8);
      const payload = bytes.subarray(offset + 512, offset + 512 + size);
      if (header[156] === 'x'.charCodeAt(0)) {
        assert.equal(pendingPath, undefined);
        assert.match(rawName, /^PaxHeaders\/openview-\d{8}$/);
        const record = payload.toString('utf8');
        assert.equal(Number.parseInt(record, 10), payload.length);
        assert.match(record, /^\d+ path=[^\n]+\n$/);
        pendingPath = record.slice(record.indexOf(' path=') + 6, -1);
        pendingIdentifier = rawName.slice('PaxHeaders/'.length);
      } else {
        assert.equal(header[156], '0'.charCodeAt(0));
        if (pendingPath)
          assert.equal(rawName, `PaxPayload/${pendingIdentifier}`);
        names.push(pendingPath ?? rawName);
        if (pendingPath) assert.equal(pendingPath, longName);
        pendingPath = pendingIdentifier = undefined;
      }
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    assert.equal(pendingPath, undefined);
    assert.deepEqual(
      names,
      files.map((file) => file.archivePath),
    );
    assert.equal(first.fileCount, names.length);
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});
