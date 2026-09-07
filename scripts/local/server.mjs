import http from 'node:http';
import net from 'node:net';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile, open, rm } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OsmManager } from './osm-manager.mjs';
import { jsonFile, parseRange } from './osm-io.mjs';
import { runProcess } from './osm-tools.mjs';
import { ShipService } from './ship-service.mjs';
import { readShipKey } from './ship-credential.mjs';

export async function requestJson(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json')
    throw new Error('JSON is required.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16384) throw new Error('Request is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
export function sameOrigin(request) {
  const host = request.headers.host || '';
  return (
    /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) &&
    (!request.headers.origin || request.headers.origin === `http://${host}`) &&
    !['cross-site', 'same-site'].includes(request.headers['sec-fetch-site'])
  );
}
function json(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}
export function createLocalServer(manager, upstreamPort, ships) {
  const nonce = randomBytes(32).toString('hex');
  let mutation = false;
  const server = http.createServer(async (request, response) => {
    const local = (request.url || '').startsWith('/local-osm/');
    if (!sameOrigin(request)) {
      json(response, 403, {
        error: 'OpenView accepts same-origin localhost requests only.',
      });
      return;
    }
    if (ships && (request.url || '').split('?')[0] === '/api/ships') {
      if (request.method !== 'GET') {
        json(response, 405, { error: 'Only GET is supported.' });
        return;
      }
      try {
        json(response, 200, await ships.snapshot());
      } catch {
        json(response, 503, {
          error:
            'Ship reports are unavailable. Retry at the next ten-minute update.',
          retryAt: Date.now() + 600000,
        });
      }
      return;
    }
    if (!local) {
      const proxy = http.request(
        {
          hostname: '127.0.0.1',
          port: upstreamPort,
          path: request.url,
          method: request.method,
          headers: { ...request.headers, host: `127.0.0.1:${upstreamPort}` },
        },
        (upstream) => {
          response.writeHead(upstream.statusCode || 502, upstream.headers);
          upstream.pipe(response);
        },
      );
      proxy.on('error', () => {
        if (!response.headersSent)
          json(response, 503, {
            error: 'OpenView is starting. Please retry shortly.',
          });
        else response.destroy();
      });
      response.on('close', () => proxy.destroy());
      request.pipe(proxy);
      return;
    }
    let ownsMutation = false;
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/local-osm/status') {
        json(response, 200, { ...manager.snapshot(), nonce });
        return;
      }
      const tile = /^\/local-osm\/tiles\/([a-f0-9-]{36})\.pmtiles$/.exec(
        url.pathname,
      );
      if (request.method === 'GET' && tile) {
        const dataset = manager.dataset(tile[1]);
        if (dataset.status !== 'ready' || !dataset.enabled)
          throw new Error('This dataset is not enabled.');
        let range;
        try {
          range = parseRange(request.headers.range, dataset.tilesBytes);
        } catch {
          response.writeHead(416, {
            'Content-Range': `bytes */${dataset.tilesBytes}`,
          });
          response.end();
          return;
        }
        const stream = createReadStream(dataset.tilesPath, range);
        stream.once('error', () => {
          if (!response.headersSent)
            json(response, 404, {
              error: 'Prepared data is unavailable. Prepare the file again.',
            });
          else response.destroy();
        });
        stream.once('open', () => {
          response.writeHead(206, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': range.end - range.start + 1,
            'Content-Range': `bytes ${range.start}-${range.end}/${dataset.tilesBytes}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
            ETag: `"${dataset.id}-${dataset.prepared}"`,
          });
          stream.pipe(response);
        });
        response.on('close', () => stream.destroy());
        return;
      }
      if (request.method !== 'POST') {
        json(response, 404, { error: 'Unknown local data route.' });
        return;
      }
      const proof = request.headers['x-openview-local'];
      if (
        typeof proof !== 'string' ||
        proof.length !== nonce.length ||
        !timingSafeEqual(Buffer.from(proof), Buffer.from(nonce))
      ) {
        json(response, 403, {
          error: 'Reload OpenView to reconnect to the local data service.',
        });
        return;
      }
      const body = await requestJson(request);
      // Serialize changes to the library, but allow Stop while a download/import runs in the background.
      if (mutation)
        throw new Error('Another data request is finishing. Try again.');
      mutation = true;
      ownsMutation = true;
      switch (url.pathname) {
        case '/local-osm/regions':
          json(response, 200, await manager.regions());
          return;
        case '/local-osm/inspect':
          json(response, 200, await manager.inspect(body.selection));
          return;
        case '/local-osm/storage':
          await manager.setStorage(body.path);
          break;
        case '/local-osm/download':
          await manager.addDownload(body.selection);
          break;
        case '/local-osm/import':
          await manager.addLocal(body.path);
          break;
        case '/local-osm/pick': {
          if (process.platform !== 'win32')
            throw new Error(
              'Use the file path field on this operating system.',
            );
          const script = join(manager.root, 'choose-osm.ps1');
          await writeFile(
            script,
            `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Choose an OpenStreetMap PBF file'
$dialog.Filter = 'OpenStreetMap PBF (*.osm.pbf)|*.osm.pbf'
$dialog.CheckFileExists = $true
if ($dialog.ShowDialog() -eq 'OK') { [Console]::Write($dialog.FileName) }
$dialog.Dispose()
`,
          );
          const selected = await runProcess('powershell.exe', [
            '-NoProfile',
            '-STA',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            script,
          ]);
          if (selected.trim()) await manager.addLocal(selected.trim());
          break;
        }
        case '/local-osm/resume':
          manager.start(body.id, 'download');
          break;
        case '/local-osm/prepare':
          manager.start(body.id, 'prepare');
          break;
        case '/local-osm/stop':
          await manager.pause(body.id);
          break;
        case '/local-osm/enable':
          await manager.enable(body.id, body.enabled);
          break;
        case '/local-osm/remove':
          await manager.remove(body.id);
          break;
        default:
          json(response, 404, { error: 'Unknown local data route.' });
          return;
      }
      json(response, 200, { ...manager.snapshot(), nonce });
    } catch (error) {
      if (!response.headersSent)
        json(response, 400, {
          error: error.message || 'Local data operation failed.',
        });
    } finally {
      if (ownsMutation) mutation = false;
    }
  });
  server.requestTimeout = 60000;
  server.on('upgrade', (request, socket, head) => {
    if (!sameOrigin(request) || (request.url || '').startsWith('/local-osm/')) {
      socket.destroy();
      return;
    }
    const upstream = net.connect(upstreamPort, '127.0.0.1', () => {
      upstream.write(
        `${request.method} ${request.url} HTTP/1.1\r\n` +
          Object.entries(request.headers)
            .map(
              ([key, value]) =>
                `${key}: ${key === 'host' ? `127.0.0.1:${upstreamPort}` : value}`,
            )
            .join('\r\n') +
          '\r\n\r\n',
      );
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });
  return server;
}
async function unusedPort() {
  const server = net.createServer();
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', ok);
  });
  const port = server.address().port;
  await new Promise((ok) => server.close(ok));
  return port;
}
export async function startLocalApp(args = process.argv.slice(2)) {
  const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index < 0 ? fallback : args[index + 1];
  };
  const port = Number(option('--port', '8787'));
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid server port.');
  const dataRoot =
    process.env.OPENVIEW_OSM_HOME ||
    join(process.env.LOCALAPPDATA || homedir(), 'OpenViewData', 'OSM');
  await mkdir(dataRoot, { recursive: true });
  const lockPath = join(dataRoot, 'service.lock');
  const previous = await jsonFile(lockPath, null);
  if (previous) {
    let running = false;
    try {
      process.kill(previous.pid, 0);
      running = true;
    } catch (error) {
      if (error.code !== 'ESRCH') running = true;
    }
    if (running)
      throw new Error(
        'Another OpenView local data service is running. Close it before starting this copy.',
      );
    await rm(lockPath);
  }
  const lock = await open(lockPath, 'wx');
  await lock.writeFile(JSON.stringify({ pid: process.pid }));
  await lock.close();
  const manager = new OsmManager(dataRoot, root);
  let child,
    server,
    ships,
    closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    server?.closeAllConnections();
    server?.close();
    await ships?.close();
    await manager.close();
    if (child && child.exitCode === null && child.pid) {
      if (process.platform === 'win32') {
        await runProcess(
          join(
            process.env.SystemRoot || 'C:\\Windows',
            'System32',
            'taskkill.exe',
          ),
          ['/PID', String(child.pid), '/T', '/F'],
        ).catch(() => child.kill());
      } else child.kill();
    }
    await rm(lockPath, { force: true });
  };
  try {
    await manager.initialize();
    const upstream = await unusedPort();
    ships = new ShipService({
      key: await readShipKey(),
      snapshotPath: join(dataRoot, 'ships-snapshot.json'),
      fallback: async () => {
        const response = await fetch(`http://127.0.0.1:${upstream}/api/ships`, {
          signal: AbortSignal.timeout(20000),
        });
        if (!response.ok) throw new Error('Regional ship feed unavailable.');
        return response.json();
      },
    });
    await ships.initialize();
    server = createLocalServer(manager, upstream, ships);
    await new Promise((ok, fail) => {
      server.once('error', fail);
      server.listen(port, '127.0.0.1', ok);
    });
    const dev = args.includes('--dev');
    const command = dev
      ? [
          join(root, 'node_modules/vinext/dist/cli.js'),
          'dev',
          '--hostname',
          '127.0.0.1',
          '--port',
          String(upstream),
        ]
      : [
          join(root, 'node_modules/wrangler/bin/wrangler.js'),
          'dev',
          '--config',
          join(root, 'dist/server/wrangler.json'),
          '--ip',
          '127.0.0.1',
          '--port',
          String(upstream),
          '--log-level',
          'error',
        ];
    const photon = option('--photon-url', '');
    if (photon && !dev) command.push('--var', `PHOTON_API_URL:${photon}`);
    child = spawn(process.execPath, command, {
      cwd: root,
      windowsHide: true,
      stdio: 'inherit',
      env: {
        ...process.env,
        WRANGLER_WRITE_LOGS: 'false',
        WRANGLER_LOG_PATH: '.wrangler/logs',
        MINIFLARE_REGISTRY_PATH: '.wrangler/registry',
      },
    });
    child.once('error', (error) => {
      console.error(error.message);
      void close().then(() => {
        process.exitCode = 1;
      });
    });
    child.once('exit', (code) => {
      if (!closing)
        void close().then(() => {
          process.exitCode = code || 1;
        });
    });
    process.once('SIGINT', () => {
      void close();
    });
    process.once('SIGTERM', () => {
      void close();
    });
    console.log(`OpenView local URL: http://127.0.0.1:${port}/`);
    return { manager, server, child, close };
  } catch (error) {
    await close();
    throw error;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  startLocalApp().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
