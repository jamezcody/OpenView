import { resolve } from 'node:path';
import { collectRegularFiles } from './deterministic-archive.mjs';

export async function collectDataFiles(
  root,
  directories,
  collect = collectRegularFiles,
) {
  const collected = [];
  for (const name of directories) {
    const directoryFiles = await collect(
      resolve(root, 'public', name),
      `public/${name}`,
    );
    if (
      !directoryFiles.some(
        (file) => file.archivePath === `public/${name}/latest.json`,
      )
    )
      throw new Error(`The ${name} dataset has no latest.json pointer.`);
    // National datasets exceed the engine's function-argument limit. Append
    // each original entry, preserving dataset order and collector ordering.
    for (const file of directoryFiles) collected.push(file);
  }
  return collected;
}
