import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { checkBrowserWorkers } from './check-browser-workers.mjs';
await checkBrowserWorkers(
  fileURLToPath(new URL('../dist/client/', import.meta.url)),
);
await mkdir(new URL('../dist/local/', import.meta.url), { recursive: true });
await cp(
  new URL('./local/', import.meta.url),
  new URL('../dist/local/', import.meta.url),
  { recursive: true },
);
