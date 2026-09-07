import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));

async function run(script, arguments_ = []) {
  await new Promise((accept, reject) => {
    const child = spawn(
      process.execPath,
      [resolve(root, script), ...arguments_],
      {
        cwd: root,
        stdio: 'inherit',
        windowsHide: true,
      },
    );
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) accept();
      else reject(new Error(`${script} exited with code ${code}.`));
    });
  });
}

await run('scripts/sanitize-public-manifests.mjs');
await run('scripts/audit-credentials.mjs', ['public']);
await run('scripts/copy-cesium.mjs');
await run('scripts/run-tests.mjs');
await run('scripts/build-data-archive.mjs');
