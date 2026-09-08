import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  writeFile,
  stat,
  rm,
  copyFile,
} from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, join } from 'node:path';
import { openRadioSearch } from '../scripts/local/radio-search-worker.mjs';
import { RadioSearchService } from '../scripts/local/radio-search.mjs';
import { createLocalServer } from '../scripts/local/server.mjs';

const radioVersion = `radio-${'a'.repeat(20)}`,
  searchVersion = `search-${'b'.repeat(20)}`;
async function fixture(count = 100001) {
  const parent = resolve('work/radio-search-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'case-'));
  const folder = join(root, 'search', searchVersion);
  await mkdir(folder, { recursive: true });
  await mkdir(join(root, 'radio'), { recursive: true });
  const path = join(folder, 'radio.sqlite');
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE records(id TEXT UNIQUE,name TEXT,namefold TEXT,identityfold TEXT,textfold TEXT,search_text TEXT,payload TEXT); CREATE VIRTUAL TABLE radio_search USING fts5(search_text,content='records',content_rowid='rowid',tokenize=trigram,detail=none); BEGIN;",
  );
  const insert = db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)');
  for (let index = 1; index <= count; index++) {
    const hash = index.toString(16).padStart(64, '0'),
      recordId = `transmitters:${hash}`;
    const name =
      index === count ? 'Zebra broadcast station' : `Ordinary station ${index}`;
    const terms =
      index === count ? 'FCC LMS BLH 20010101AAA 98.7 MHz' : 'FCC ULS 151 MHz';
    const id = `radio:${recordId}`,
      namefold = name.toLowerCase(),
      identityfold = id.replaceAll(':', ' ');
    const textfold = `${name} ${terms} radio transmitter`.toLowerCase();
    const payload = {
      id,
      name,
      kind: 'transmitter',
      terms,
      detail: 'Transmitter · US',
      lat: 40,
      lon: -74,
      height: 2500,
      source: 'FCC',
      sourceUrl: 'https://www.fcc.gov/',
      release: radioVersion,
      target: {
        type: 'radio',
        recordId,
        node: 'r012',
        category: 'transmitters',
      },
    };
    insert.run(
      id,
      name,
      namefold,
      identityfold,
      textfold,
      `${textfold} ${identityfold}`,
      JSON.stringify(payload),
    );
  }
  const meta = db.prepare('INSERT INTO metadata VALUES(?,?)');
  meta.run('encoding', 'radio-sqlite-v1');
  meta.run('radioVersion', radioVersion);
  meta.run('count', String(count));
  db.exec("COMMIT; INSERT INTO radio_search(radio_search) VALUES('rebuild');");
  db.close();
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const descriptor = {
    kind: 'radio',
    file: 'radio.sqlite',
    encoding: 'radio-sqlite-v1',
    bytes: (await stat(path)).size,
    sha256: hash.digest('hex'),
    count,
  };
  const manifest = {
    schemaVersion: 2,
    version: searchVersion,
    radioVersion,
    files: [descriptor],
  };
  await writeFile(join(root, 'search/latest.json'), JSON.stringify(manifest));
  await writeFile(
    join(root, 'radio/latest.json'),
    JSON.stringify({ version: radioVersion }),
  );
  return {
    root,
    manifest,
    descriptor,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test('local SQLite search reaches beyond 100k records, preserves substring/word matching and caps response', async () => {
  const data = await fixture();
  let engine;
  try {
    engine = await openRadioSearch(data.root, radioVersion);
    const result = engine.search('bra BLH 98.7', 60);
    assert.equal(result.total, 1);
    assert.equal(result.items[0].name, 'Zebra broadcast station');
    assert.equal(result.items[0].target.node, 'r012');
    assert.equal(result.items[0].release, radioVersion);
    const all = engine.search('station', 20);
    assert.equal(all.total, 100001);
    assert.equal(all.items.length, 20);
    assert.ok(Buffer.byteLength(JSON.stringify(all)) < 2 * 1024 ** 2);
    assert.equal(engine.search('z', 20).total, 100001); // Short substrings remain complete, including MHz.
    assert.throws(() => engine.search('x'.repeat(181)), /180/);
    assert.throws(() => engine.search('station', 501), /500/);
    await writeFile(
      join(data.root, 'radio/latest.json'),
      JSON.stringify({ version: `radio-${'c'.repeat(20)}` }),
    );
    assert.throws(() => engine.search('zebra'), /older dataset/);
  } finally {
    engine?.close();
    await data.close();
  }
});

test('local radio endpoint uses a worker, enforces origin and never serves database files', async () => {
  const data = await fixture(3),
    service = new RadioSearchService(data.root);
  const server = createLocalServer({}, 1, undefined, service, data.root);
  try {
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${server.address().port}`;
    const params = new URLSearchParams({
      q: 'zebra',
      radioVersion,
      limit: '1',
    });
    const response = await fetch(`${base}/local-search/radio?${params}`);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.total, 1);
    assert.equal(result.items.length, 1);
    const first = service.search('station', 1, radioVersion),
      second = service.search('zebra', 1, radioVersion);
    await assert.rejects(service.search('another', 1, radioVersion), /busy/);
    assert.equal((await first).total, 3);
    assert.equal((await second).total, 1);
    assert.equal(
      (
        await fetch(`${base}/local-search/radio?${params}`, {
          headers: { Origin: 'https://example.com' },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(`${base}/search/${searchVersion}/radio.sqlite`)).status,
      404,
    );
    assert.equal(
      (await fetch(`${base}/search/${searchVersion}/radio%2esqlite`)).status,
      404,
    );
  } finally {
    await service.close();
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
    await data.close();
  }
});

test('local database integrity and version mismatch fail closed', async () => {
  const data = await fixture(1);
  try {
    await assert.rejects(
      openRadioSearch(data.root, `radio-${'d'.repeat(20)}`),
      /older dataset/,
    );
    data.descriptor.sha256 = '0'.repeat(64);
    await writeFile(
      join(data.root, 'search/latest.json'),
      JSON.stringify(data.manifest),
    );
    await assert.rejects(openRadioSearch(data.root, radioVersion), /checksum/);
  } finally {
    await data.close();
  }
});

test('refreshing only the search version replaces the worker without changing the radio snapshot', async () => {
  const data = await fixture(1),
    service = new RadioSearchService(data.root);
  try {
    assert.equal(
      (await service.search('zebra', 1, radioVersion, searchVersion)).total,
      1,
    );
    const nextVersion = `search-${'e'.repeat(20)}`;
    await mkdir(join(data.root, 'search', nextVersion));
    await copyFile(
      join(data.root, 'search', searchVersion, 'radio.sqlite'),
      join(data.root, 'search', nextVersion, 'radio.sqlite'),
    );
    await writeFile(
      join(data.root, 'search/latest.json'),
      JSON.stringify({ ...data.manifest, version: nextVersion }),
    );
    assert.equal(
      (await service.search('zebra', 1, radioVersion, nextVersion)).total,
      1,
    );
  } finally {
    await service.close();
    await data.close();
  }
});
