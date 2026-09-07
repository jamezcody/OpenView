import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const cellsRoot = resolve(root, 'public/cells');
const pointerPath = resolve(cellsRoot, 'latest.json');
const sensitiveParameters = new Set([
  'access_token',
  'api-key',
  'api_key',
  'apikey',
  'key',
  'secret',
  'signature',
  'sig',
  'token',
]);

const pointer = JSON.parse(await readFile(pointerPath, 'utf8'));
if (typeof pointer.manifest !== 'string' || !pointer.manifest)
  throw new Error('The active cell pointer does not name a manifest.');

const manifestPath = resolve(cellsRoot, pointer.manifest);
const rel = relative(cellsRoot, manifestPath);
if (!rel || rel.startsWith(`..${sep}`) || rel === '..')
  throw new Error('Refusing to sanitize a manifest outside public/cells.');

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
let removed = 0;

function sanitize(value) {
  if (Array.isArray(value)) {
    for (const item of value) sanitize(item);
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && /^https?:\/\//i.test(item)) {
      const url = new URL(item);
      for (const parameter of new Set(url.searchParams.keys())) {
        if (!sensitiveParameters.has(parameter.toLowerCase())) continue;
        url.searchParams.delete(parameter);
        removed += 1;
      }
      value[key] = url.toString();
    } else {
      sanitize(item);
    }
  }
}

sanitize(manifest);
if (removed === 0) {
  console.log('No sensitive URL parameters were present.');
  process.exit(0);
}

const manifestBytes = Buffer.from(JSON.stringify(manifest));
const sha256 = createHash('sha256').update(manifestBytes).digest('hex');
pointer.sha256 = sha256;

await writeFile(manifestPath, manifestBytes);
await writeFile(pointerPath, JSON.stringify(pointer));

console.log(
  `Removed ${removed} sensitive URL parameter(s) from ${relative(root, manifestPath)} and updated its pointer checksum.`,
);
