import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, statSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const readJson = (path) => {
  if (statSync(path).size > 65536)
    throw new Error('Radio search catalog is too large.');
  return JSON.parse(readFileSync(path, 'utf8'));
};
const fold = (value) =>
  value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.]+/gu, ' ')
    .trim();

export async function openRadioSearch(
  publicRoot,
  expectedVersion,
  expectedSearchVersion = '',
) {
  const manifestPath = join(publicRoot, 'search/latest.json');
  const radioPath = join(publicRoot, 'radio/latest.json');
  const manifest = readJson(manifestPath);
  const assertCurrent = () => {
    if (
      readJson(radioPath).version !== expectedVersion ||
      readJson(manifestPath).version !== manifest.version ||
      manifest.radioVersion !== expectedVersion ||
      (expectedSearchVersion && manifest.version !== expectedSearchVersion)
    )
      throw new Error(
        'Radio search belongs to an older dataset. Refresh the search catalog.',
      );
  };
  assertCurrent();
  if (
    manifest.schemaVersion !== 2 ||
    !/^search-[a-f0-9]{20}$/.test(manifest.version)
  )
    throw new Error(
      'This snapshot does not contain a local radio search index.',
    );
  const file = manifest.files?.find((entry) => entry.kind === 'radio');
  if (
    !file ||
    file.file !== 'radio.sqlite' ||
    file.encoding !== 'radio-sqlite-v1' ||
    !Number.isSafeInteger(file.bytes) ||
    file.bytes < 512 ||
    file.bytes > 8 * 1024 ** 3 ||
    !Number.isSafeInteger(file.count) ||
    file.count < 0 ||
    !/^[a-f0-9]{64}$/.test(file.sha256)
  )
    throw new Error('Invalid local radio search descriptor.');
  const path = join(publicRoot, 'search', manifest.version, file.file);
  if (statSync(path).size !== file.bytes)
    throw new Error('Radio search database size differs from its catalog.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== file.sha256)
    throw new Error('Radio search database checksum mismatch.');
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  try {
    db.exec(
      'PRAGMA query_only=ON; PRAGMA cache_size=-32768; PRAGMA temp_store=FILE;',
    );
    const metadata = Object.fromEntries(
      db
        .prepare('SELECT key,value FROM metadata')
        .all()
        .map((row) => [row.key, row.value]),
    );
    if (
      metadata.encoding !== 'radio-sqlite-v1' ||
      metadata.radioVersion !== expectedVersion ||
      Number(metadata.count) !== file.count
    )
      throw new Error('Radio search metadata differs from its catalog.');
    return {
      close: () => db.close(),
      search(query, limit = 60) {
        assertCurrent();
        if (
          typeof query !== 'string' ||
          query.length > 180 ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 500
        )
          throw new Error(
            'Use a search query up to 180 characters and a result limit from 1 to 500.',
          );
        const q = fold(query),
          words = [...new Set(q.split(' ').filter(Boolean))];
        if (!words.length)
          return {
            items: [],
            total: 0,
            count: file.count,
            radioVersion: expectedVersion,
          };
        const where = words.map(() => 's.search_text LIKE ?').join(' AND '),
          patterns = words.map((word) => `%${word}%`);
        const total = db
          .prepare(`SELECT COUNT(*) AS n FROM radio_search s WHERE ${where}`)
          .get(...patterns).n;
        const rows = db
          .prepare(`SELECT r.payload FROM radio_search s JOIN records r ON r.rowid=s.rowid WHERE ${where}
          ORDER BY CASE WHEN r.namefold=? OR r.identityfold=? THEN 100 WHEN substr(r.namefold,1,length(?))=? THEN 80
          WHEN instr(r.namefold,?)>0 THEN 60 WHEN instr(r.textfold,?)>0 THEN 40 ELSE 20 END DESC,r.namefold,r.id LIMIT ?`)
          .all(...patterns, q, q, q, q, q, q, limit);
        const items = [];
        let bytes = 1024;
        for (const row of rows) {
          bytes += Buffer.byteLength(row.payload) + 1;
          if (bytes > 2 * 1024 ** 2) break;
          items.push(JSON.parse(row.payload));
        }
        return {
          items,
          total,
          count: file.count,
          radioVersion: expectedVersion,
        };
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

if (parentPort) {
  try {
    const engine = await openRadioSearch(
      workerData.publicRoot,
      workerData.radioVersion,
      workerData.searchVersion,
    );
    parentPort.on('message', ({ id, query, limit }) => {
      try {
        parentPort.postMessage({ id, result: engine.search(query, limit) });
      } catch (error) {
        parentPort.postMessage({ id, error: error.message });
      }
    });
    parentPort.postMessage({ ready: true });
  } catch (error) {
    parentPort.postMessage({ fatal: error.message });
  }
}
