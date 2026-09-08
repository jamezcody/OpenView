import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

/** Serve prepared, bounded JSON without indexing national data in Wrangler. */
export async function servePreparedData(request, response, assetRoot) {
  const pathname = (request.url || '').split('?')[0];
  if (!/^\/(radio|search)(\/|$)/.test(pathname)) return false;
  const fail = (status, message) => {
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(JSON.stringify({ error: message }));
    return true;
  };
  if (!['GET', 'HEAD'].includes(request.method))
    return fail(405, 'Prepared data accepts GET or HEAD only.');
  const radio =
    /^\/radio\/(?:latest\.json|versions\/radio-[a-f0-9]{20}\/(?:manifest\.json|nodes\/r[0-3]{0,12}\.json|(?:records|summary|overview)\/r[0-3]{0,12}-\d{4,}\.json))$/;
  const search =
    /^\/search\/(?:latest\.json|(?:versions\/)?search-[a-f0-9]{20}\/(?:manifest|radio|parks)\.json)$/;
  if (!radio.test(pathname) && !search.test(pathname))
    return fail(404, 'Prepared data file is unavailable.');
  const root = resolve(assetRoot);
  const path = resolve(root, '.' + pathname);
  if (!path.startsWith(root + sep))
    return fail(404, 'Prepared data file is unavailable.');
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      return fail(404, 'Prepared data file is unavailable.');
    return fail(503, 'Prepared data could not be read.');
  }
  const maximumBytes = pathname.startsWith('/radio/') ? 1048576 : 12000000;
  if (!metadata.isFile() || metadata.size > maximumBytes)
    return fail(503, 'Prepared data file exceeds its supported size.');
  response.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': metadata.size,
    'Cache-Control': pathname.endsWith('/latest.json')
      ? 'no-cache'
      : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
  if (request.method === 'HEAD') {
    response.end();
    return true;
  }
  const stream = createReadStream(path);
  stream.on('error', () => response.destroy());
  response.once('close', () => stream.destroy());
  stream.pipe(response);
  return true;
}
