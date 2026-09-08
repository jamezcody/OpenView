import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { collectDataFiles } = await import(
  pathToFileURL(resolve('scripts/data-archive-files.mjs'))
);

test('data collector preserves all identities and order across a national dataset above 150k files', async () => {
  const root = resolve('work/data-archive-virtual-fixture');
  const directories = ['parks', 'radio', 'search'];
  const inventory = {
    parks: [{ archivePath: 'public/parks/latest.json' }],
    radio: Array.from({ length: 180_001 }, (_, index) => ({
      archivePath:
        index === 0
          ? 'public/radio/latest.json'
          : `public/radio/versions/radio-${'a'.repeat(20)}/records/r0123-${String(index).padStart(6, '0')}.json`,
      path: `virtual-source-${index}`,
      snapshot: { size: BigInt(index) },
    })),
    search: [
      { archivePath: 'public/search/latest.json' },
      { archivePath: 'public/search/radio.sqlite' },
    ],
  };
  const calls = [];
  const result = await collectDataFiles(
    root,
    directories,
    async (source, archiveRoot) => {
      const name = directories[calls.length];
      assert.equal(source, resolve(root, 'public', name));
      assert.equal(archiveRoot, `public/${name}`);
      calls.push(name);
      return inventory[name];
    },
  );
  assert.deepEqual(calls, directories);
  assert.equal(result.length, 180_004);
  let offset = 0;
  for (const name of directories) {
    for (const original of inventory[name]) {
      assert.equal(result[offset], original);
      offset += 1;
    }
  }
  assert.equal(offset, result.length);
  assert.equal(inventory.radio.length, 180_001);
});

test('data collector rejects an incomplete dataset instead of returning only preceding datasets', async () => {
  let calls = 0;
  await assert.rejects(
    collectDataFiles(
      resolve('.'),
      ['parks', 'radio', 'search'],
      async (_source, archiveRoot) => {
        calls += 1;
        return [
          {
            archivePath:
              archiveRoot +
              (archiveRoot === 'public/radio'
                ? '/records/r-0000.json'
                : '/latest.json'),
          },
        ];
      },
    ),
    /The radio dataset has no latest.json pointer/,
  );
  assert.equal(calls, 2);
});

test('data collector preserves a source-read failure without returning a partial inventory', async () => {
  const failure = new Error('fixture source could not be read');
  await assert.rejects(
    collectDataFiles(resolve('.'), ['radio'], async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
});
