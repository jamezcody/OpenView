import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  stat,
  rm,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  preparedAssetsRoot,
  createLocalServer,
} from '../scripts/local/server.mjs';

// Import the actual postbuild module without running its CLI entrypoint. The
// standard test transpiler intentionally copies only scripts/local modules.
const { movePreparedDatasets } = await import(
  pathToFileURL(resolve('scripts/copy-local.mjs'))
);

async function fixture() {
  const parent = resolve('work/prepared-layout-tests');
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, 'case-'));
}

test('postbuild moves datasets outside Wrangler assets without changing bytes and is idempotent', async () => {
  const root = await fixture(),
    dist = join(root, 'dist');
  let server;
  try {
    await mkdir(join(dist, 'client/radio'), { recursive: true });
    await mkdir(join(dist, 'client/search'), { recursive: true });
    const radio = '{"version":"radio-01234567890123456789"}\n';
    await writeFile(join(dist, 'client/radio/latest.json'), radio);
    await writeFile(
      join(dist, 'client/search/radio.sqlite'),
      'fixture database bytes',
    );
    const original = await stat(join(dist, 'client/radio/latest.json'));
    assert.equal(await preparedAssetsRoot(root), join(dist, 'client'));
    assert.equal(await movePreparedDatasets(dist), join(dist, 'prepared'));
    await assert.rejects(stat(join(dist, 'client/radio')), { code: 'ENOENT' });
    await assert.rejects(stat(join(dist, 'client/search')), { code: 'ENOENT' });
    assert.equal(
      await readFile(join(dist, 'prepared/radio/latest.json'), 'utf8'),
      radio,
    );
    assert.equal(
      (await stat(join(dist, 'prepared/radio/latest.json'))).ino,
      original.ino,
    );
    assert.equal(
      await readFile(join(dist, 'prepared/search/radio.sqlite'), 'utf8'),
      'fixture database bytes',
    );
    assert.equal(await movePreparedDatasets(dist), join(dist, 'prepared'));
    assert.equal(await preparedAssetsRoot(root), join(dist, 'prepared'));
    assert.equal(await preparedAssetsRoot(root, true), join(root, 'public'));
    server = createLocalServer(
      {},
      1,
      undefined,
      undefined,
      await preparedAssetsRoot(root),
    );
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/radio/latest.json`,
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), radio);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((ok) => server.close(ok));
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('postbuild rejects conflicting snapshots before moving either source', async () => {
  const root = await fixture(),
    dist = join(root, 'dist');
  try {
    await mkdir(join(dist, 'client/radio'), { recursive: true });
    await mkdir(join(dist, 'client/search'), { recursive: true });
    await mkdir(join(dist, 'prepared/search'), { recursive: true });
    await assert.rejects(
      movePreparedDatasets(dist),
      /Both client and prepared copies exist for search/,
    );
    assert.ok((await stat(join(dist, 'client/radio'))).isDirectory());
    await assert.rejects(stat(join(dist, 'prepared/radio')), {
      code: 'ENOENT',
    });
    // An existing prepared root is authoritative even when incomplete, so the
    // runtime cannot accidentally read an older client snapshot for one source.
    assert.equal(await preparedAssetsRoot(root), join(dist, 'prepared'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
