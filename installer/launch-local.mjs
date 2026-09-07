// Installed beside OpenView.exe; launched by the signed system Node.js runtime.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = dirname(fileURLToPath(import.meta.url));
const noBrowser = process.argv.includes('--no-browser');
let runtime;

async function main() {
  process.title = 'OpenView — press Ctrl+C to stop';
  process.chdir(root);
  const localData = process.env.LOCALAPPDATA;
  if (!localData)
    throw new Error(
      'The Windows local application data directory is unavailable.',
    );
  let settings = {};
  try {
    settings = JSON.parse(
      await readFile(join(localData, 'OpenView/config/settings.json'), 'utf8'),
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const port = settings.port ?? 8787;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid OpenView port setting.');
  const url = `http://127.0.0.1:${port}/`;
  const expected = createHash('sha256')
    .update(await readFile(join(root, 'dist/client/favicon.svg')))
    .digest('hex');
  async function ready() {
    try {
      const options = { signal: AbortSignal.timeout(1500), redirect: 'error' };
      const page = await fetch(url, options);
      if (!page.ok || !(await page.text()).includes('OpenView')) return false;
      const probe = await fetch(`${url}favicon.svg`, {
        ...options,
        signal: AbortSignal.timeout(1500),
      });
      if (!probe.ok) return false;
      return (
        createHash('sha256')
          .update(Buffer.from(await probe.arrayBuffer()))
          .digest('hex') === expected
      );
    } catch {
      return false;
    }
  }
  async function openBrowser() {
    if (noBrowser) return;
    await new Promise((resolve, reject) => {
      const browser = spawn(
        join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'),
        [url],
        {
          windowsHide: true,
          detached: true,
          stdio: 'ignore',
        },
      );
      browser.once('error', reject);
      browser.once('spawn', () => {
        browser.unref();
        resolve();
      });
    });
  }
  if (await ready()) {
    console.log(`OpenView is already running at ${url}`);
    await openBrowser();
    return;
  }
  // Match the desktop controller's clean child-process environment.
  for (const name of Object.keys(process.env)) {
    if (
      /(?:^|_)(?:API_?KEY|API_?TOKEN|AUTH|PASSWORD|SECRET|TOKEN)(?:$|_)/i.test(
        name,
      )
    )
      delete process.env[name];
  }
  delete process.env.PHOTON_API_URL;
  delete process.env.FCC_USERNAME;
  Object.assign(process.env, {
    CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
    WRANGLER_WRITE_LOGS: 'false',
    WRANGLER_LOG: 'error',
    NO_COLOR: '1',
  });
  const args = ['--port', String(port)];
  if (settings.photonApiUrl) {
    const photon = new URL(settings.photonApiUrl);
    if (
      !['http:', 'https:'].includes(photon.protocol) ||
      photon.username ||
      photon.password
    ) {
      throw new Error('Invalid Photon URL setting.');
    }
    args.push('--photon-url', photon.href);
  }
  const { startLocalApp } = await import(
    pathToFileURL(join(root, 'dist/local/server.mjs')).href
  );
  runtime = await startLocalApp(args);
  for (let attempt = 0; attempt < 60; attempt++) {
    if (runtime.child.exitCode !== null)
      throw new Error('The OpenView server stopped during startup.');
    if (await ready()) {
      console.log(
        `OpenView is ready at ${url}\nPress Ctrl+C in this window to stop OpenView.`,
      );
      await openBrowser();
      return;
    }
    await delay(1000);
  }
  throw new Error('OpenView did not become ready within the startup timeout.');
}

main().catch(async (error) => {
  console.error(`OpenView: ${error.message}`);
  await runtime?.close();
  process.exitCode = 1;
  if (process.stdin.isTTY) {
    console.error('Press Enter to close this window.');
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(1));
  }
});
