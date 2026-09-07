import { rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootUrl = new URL('../', import.meta.url);
const root = resolve(fileURLToPath(rootUrl));
const output = resolve(fileURLToPath(new URL('dist/', rootUrl)));

if (dirname(output) !== root || basename(output) !== 'dist')
  throw new Error('Refusing to clean an unexpected build output path.');

rmSync(output, { recursive: true, force: true });
