import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { servePreparedData } from '../scripts/local/prepared-data.mjs';

test('local prepared data preserves bytes and blocks private database and unsafe paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openview-prepared-'));
  await mkdir(join(root, 'radio'));
  const body = '{"schemaVersion":1,"test":"unchanged"}\n';
  await writeFile(join(root, 'radio/latest.json'), body);
  const server = http.createServer((request, response) => {
    void servePreparedData(request, response, root).then((handled) => {
      if (!handled) {
        response.writeHead(418);
        response.end();
      }
    });
  });
  await new Promise((accept) => server.listen(0, '127.0.0.1', accept));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/radio/latest.json`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), body);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    const head = await fetch(`${base}/radio/latest.json`, { method: 'HEAD' });
    assert.equal(
      head.headers.get('content-length'),
      String(Buffer.byteLength(body)),
    );
    assert.equal(await head.text(), '');
    for (const path of [
      '/search/search-12345678901234567890/radio.sqlite',
      '/radio/%2e%2e%2fsecret.json',
      '/radio/missing.json',
    ]) {
      assert.equal((await fetch(base + path)).status, 404);
    }
    assert.equal(
      (await fetch(`${base}/radio/latest.json`, { method: 'POST' })).status,
      405,
    );
    assert.equal((await fetch(`${base}/favicon.svg`)).status, 418);
  } finally {
    server.closeAllConnections();
    await new Promise((accept) => server.close(accept));
    await rm(root, { recursive: true, force: true });
  }
});
