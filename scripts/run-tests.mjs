import ts from 'typescript';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url)),
  out = join(root, 'work/tests');
function compile(directory) {
  for (const entry of readdirSync(join(root, directory), {
    withFileTypes: true,
  })) {
    const name = join(directory, entry.name);
    if (entry.isDirectory()) {
      compile(name);
      continue;
    }
    if (!/\.(ts|json|mjs)$/.test(name)) continue;
    const source = readFileSync(join(root, name), 'utf8');
    let js = name.endsWith('.mjs')
      ? source
      : name.endsWith('.json')
        ? `export default ${source};`
        : ts.transpileModule(source, {
            compilerOptions: {
              target: ts.ScriptTarget.ES2022,
              module: ts.ModuleKind.ESNext,
            },
          }).outputText;
    js = js.replace(
      /from (['"])(\.[^'"]+)\1/g,
      (_, q, path) =>
        `from ${q}${path.replace(/\.(ts|json|mjs)$/, '')}.mjs${q}`,
    );
    const target = join(out, name.replace(/\.(ts|json)$/, '.mjs'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, js);
  }
}
compile('lib');
compile('scripts/local');
compile('tests');
for (const name of readdirSync(join(root, 'tests')).filter(
  (name) => /\.test\.(ts|mjs)$/.test(name) && name !== 'osm-local.test.mjs',
))
  await import(pathToFileURL(join(out, 'tests', name.replace('.ts', '.mjs'))));
