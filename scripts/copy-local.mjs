import { cp, mkdir, writeFile, lstat, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { checkBrowserWorkers } from './check-browser-workers.mjs';

const statIfPresent = async (path) => {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

export async function movePreparedDatasets(distRoot) {
  const root = resolve(distRoot),
    prepared = join(root, 'prepared');
  const moves = [];
  // Preflight the complete pair before moving either directory. Do not replace
  // an older prepared snapshot implicitly when rerunning postbuild by hand.
  for (const name of ['radio', 'search']) {
    const source = resolve(root, 'client', name),
      target = resolve(prepared, name);
    for (const path of [source, target]) {
      const part = relative(root, path);
      if (
        isAbsolute(part) ||
        part === '..' ||
        part.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))
      )
        throw new Error('Prepared dataset path escaped the build directory.');
    }
    const sourceStat = await statIfPresent(source),
      targetStat = await statIfPresent(target);
    for (const [path, stat] of [
      [source, sourceStat],
      [target, targetStat],
    ])
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
        throw new Error(`Prepared dataset must be a real directory: ${path}`);
    if (sourceStat && targetStat)
      throw new Error(
        `Both client and prepared copies exist for ${name}; clean or reconcile the build before copying the local runtime.`,
      );
    if (sourceStat) moves.push({ source, target });
  }
  await mkdir(prepared, { recursive: true });
  const completed = [];
  try {
    for (const move of moves) {
      await rename(move.source, move.target);
      completed.push(move);
    }
  } catch (error) {
    const errors = [error];
    for (const move of completed.reverse()) {
      try {
        await rename(move.target, move.source);
      } catch (rollback) {
        errors.push(rollback);
      }
    }
    throw new AggregateError(
      errors,
      'Unable to move prepared datasets out of the web assets directory.',
    );
  }
  return prepared;
}

export async function copyLocalRuntime(root) {
  root = resolve(root);
  const dist = join(root, 'dist');
  await checkBrowserWorkers(join(dist, 'client'));
  await movePreparedDatasets(dist);
  await mkdir(join(dist, 'local'), { recursive: true });
  await cp(join(root, 'scripts/local'), join(dist, 'local'), {
    recursive: true,
  });
  // Defense against accidentally exposing copied data. This ignore file does
  // not prune Wrangler's recursive watcher: the data must live in dist/prepared.
  await writeFile(join(dist, 'client/.assetsignore'), 'radio/**\nsearch/**\n');
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await copyLocalRuntime(fileURLToPath(new URL('../', import.meta.url)));
