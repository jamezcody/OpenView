import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { credentialFindingsForLine } = await import(
  pathToFileURL(resolve('scripts/audit-credentials.mjs'))
);
const projectRel = `public/radio/versions/radio-${'a'.repeat(20)}/records/r0123-0000.json`;
const options = { projectRel, extension: '.json' };
const regulatoryField = ['authorization', 'type'].join('_');
const inspect = (value, overrides = {}) =>
  credentialFindingsForLine(JSON.stringify(value), {
    ...options,
    ...overrides,
  });

test('credential audit accepts only FCC public authorization codes in prepared radio record pages', () => {
  for (const code of ['C', 'L', 'S']) {
    assert.deepEqual(
      inspect([
        { source: 'us_lms', details_json: { [regulatoryField]: code } },
      ]),
      [],
    );
    const prettyLine =
      JSON.stringify({ [regulatoryField]: code }).slice(1, -1) + ',';
    assert.deepEqual(credentialFindingsForLine(prettyLine, options), []);
  }
  for (const location of [
    'config.json',
    'public/radio/latest.json',
    'public/search/records/r0123-0000.json',
    projectRel.replace('/records/', '/summary/'),
    projectRel.replace('radio-' + 'a'.repeat(20), 'untrusted'),
  ])
    assert.ok(
      inspect({ [regulatoryField]: 'L' }, { projectRel: location }).includes(
        'non-placeholder secret assignment',
      ),
    );
  for (const value of [
    'CP',
    'license',
    'l',
    'Bearer synthetic-value',
    'arbitrary-value',
  ])
    assert.ok(
      inspect({ [regulatoryField]: value }).includes(
        'non-placeholder secret assignment',
      ),
    );
});

test('regulatory exception does not weaken auth, password, API token or connection-string rules', () => {
  for (const name of [
    'AUTHORIZATION',
    'Authorization',
    'authorizationType',
    'authorization_type_token',
    'AUTH',
    'apiKey',
    'API_TOKEN',
    'password',
    'clientSecret',
  ]) {
    assert.ok(
      inspect({ [name]: 'L' }).includes('non-placeholder secret assignment'),
      name,
    );
    assert.ok(
      inspect({
        [regulatoryField]: 'L',
        [name]: 'synthetic-assignment-value',
      }).includes('non-placeholder secret assignment'),
      name,
    );
  }
  const connection =
    ['Pass', 'word'].join('') + '=' + 'synthetic-assignment-value';
  assert.ok(
    inspect({ [regulatoryField]: 'L', connection }).includes(
      'credential-bearing connection string',
    ),
  );
});

test('public authorization enum leaves high-confidence credentials detectable on the same line', () => {
  const cases = [
    ['GitHub token', 'ghp_' + 'a'.repeat(36)],
    [
      'JSON Web Token',
      ['eyJ' + 'a'.repeat(8), 'b'.repeat(8), 'c'.repeat(16)].join('.'),
    ],
    [
      'sensitive URL parameter',
      'https://example.invalid/?' +
        ['api', 'key'].join('_') +
        '=synthetic-value',
    ],
    [
      'URL-embedded credentials',
      'https://' +
        'synthetic-user' +
        ':' +
        'synthetic-value' +
        '@example.invalid/',
    ],
  ];
  for (const [rule, value] of cases) {
    assert.ok(
      inspect({ [regulatoryField]: 'L', description: value }).includes(rule),
    );
    assert.ok(
      inspect(
        { [regulatoryField]: 'L', description: value },
        { generatedOutput: true },
      ).includes(rule),
    );
  }
});

test('Python files are scanned and sanitizer fixture paths retain credential checks', async () => {
  const assignmentName = ['API', 'TOKEN'].join('_');
  const fixtureValue = 'synthetic-assignment-value';
  for (const name of [
    'test_audit_licenses.py',
    'test_fcc.py',
    'test_prepare_radio.py',
    'test_prepare_search.py',
  ]) {
    const fixtureOptions = {
      projectRel: `tools/radio-data/tests/${name}`,
      extension: '.py',
    };
    assert.ok(
      credentialFindingsForLine(
        `${assignmentName} = ${JSON.stringify(fixtureValue)}`,
        fixtureOptions,
      ).includes('non-placeholder secret assignment'),
    );
    assert.ok(
      credentialFindingsForLine(
        'https://example.invalid/?' + assignmentName + '=' + fixtureValue,
        fixtureOptions,
      ).includes('sensitive URL parameter'),
    );
  }

  const parent = resolve('work/credential-audit-tests');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'python-'));
  const file = join(directory, 'fixture.py');
  const audit = () =>
    spawnSync(
      process.execPath,
      [resolve('scripts/audit-credentials.mjs'), directory],
      { encoding: 'utf8', windowsHide: true },
    );
  try {
    await writeFile(file, 'example = "not-a-real-value"\n');
    const clean = audit();
    assert.ifError(clean.error);
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /1 text files/);

    await writeFile(
      file,
      `${assignmentName} = ${JSON.stringify(fixtureValue)}\n`,
    );
    const rejected = audit();
    assert.ifError(rejected.error);
    assert.equal(rejected.status, 1);
    assert.match(
      rejected.stderr,
      /fixture\.py:1 \[non-placeholder secret assignment\]/,
    );
    assert.ok(!rejected.stderr.includes(fixtureValue));
  } finally {
    assert.equal(dirname(directory), parent);
    await rm(directory, { recursive: true, force: true });
  }
});
