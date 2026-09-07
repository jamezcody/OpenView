import ts from 'typescript';
import { readdir, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';

const workerName = /\/(osm|space)-worker-[\w-]+\.js$/;
export function browserWorkerUrls(
  code,
  base = 'https://openview.invalid/_next/static/chunks/page.js',
) {
  const tree = ts.createSourceFile(
    'bundle.js',
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const urls = [];
  const literal = (node) =>
    node && ts.isStringLiteralLike(node) ? node.text : null;
  const visit = (node) => {
    if (
      ts.isNewExpression(node) &&
      node.expression.getText(tree) === 'Worker'
    ) {
      const first = node.arguments?.[0];
      if (first && /(?:osm|space)-worker-/.test(first.getText(tree))) {
        let url = literal(first);
        if (
          ts.isNewExpression(first) &&
          first.expression.getText(tree) === 'URL'
        ) {
          const value = literal(first.arguments?.[0]);
          const relativeTo =
            literal(first.arguments?.[1]) ||
            (first.arguments?.[1]?.getText(tree) === 'import.meta.url'
              ? base
              : null);
          url =
            value !== null && relativeTo
              ? new URL(value, relativeTo).href
              : null;
        }
        if (!url) throw new Error('Cannot verify the browser worker address.');
        const resolved = new URL(url, base);
        if (
          resolved.origin !== new URL(base).origin ||
          !/^https?:$/.test(resolved.protocol) ||
          !workerName.test(resolved.pathname)
        )
          throw new Error(`Invalid browser worker address: ${resolved.href}`);
        urls.push(resolved.pathname);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return urls;
}

export async function checkBrowserWorkers(clientRoot) {
  const directory = join(clientRoot, '_next/static/chunks');
  const urls = new Set();
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.js')) continue;
    const code = await readFile(join(directory, name), 'utf8');
    if (!/(?:osm|space)-worker-/.test(code)) continue;
    for (const url of browserWorkerUrls(code)) {
      await access(join(clientRoot, url.slice(1)));
      urls.add(url);
    }
  }
  for (const name of ['osm', 'space'])
    if (![...urls].some((url) => url.includes(`/${name}-worker-`)))
      throw new Error(
        `The production build is missing a valid ${name} worker constructor.`,
      );
  console.log(
    `Browser worker asset check passed: ${urls.size} same-origin scripts.`,
  );
}
