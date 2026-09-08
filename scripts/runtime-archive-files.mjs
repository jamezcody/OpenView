import { resolve } from 'node:path';
import { collectRegularFiles } from './deterministic-archive.mjs';

export const requiredRuntimeFiles = [
  'launch-local.mjs',
  'dist/local/server.mjs',
  'dist/local/prepared-data.mjs',
  'dist/local/radio-search.mjs',
  'dist/local/radio-search-worker.mjs',
  'dist/local/ship-service.mjs',
  'dist/local/ship-model.mjs',
  'dist/local/ship-policy.mjs',
  'dist/local/ship-credential.mjs',
  'dist/local/ais-credential.ps1',
  'dist/server/index.js',
  'dist/server/wrangler.json',
  'dist/client/favicon.svg',
  'node_modules/wrangler/bin/wrangler.js',
  'node_modules/ws/package.json',
  'node_modules/@cloudflare/workerd-windows-64/bin/workerd.exe',
];

export async function collectRuntimeFiles(
  root,
  dependenciesRoot,
  dataDirectories,
) {
  const dataRoots = new Set(dataDirectories);
  const excludeState = (path) => path.split('/').includes('.wrangler');
  const launcher = await collectRegularFiles(
    resolve(root, 'installer'),
    'installer',
    {
      exclude: (path) => path !== 'installer/launch-local.mjs',
    },
  );
  const files = [
    ...launcher.map((file) => ({ ...file, archivePath: 'launch-local.mjs' })),
    ...(await collectRegularFiles(resolve(root, 'dist/local'), 'dist/local', {
      exclude: excludeState,
    })),
    ...(await collectRegularFiles(resolve(root, 'dist/client'), 'dist/client', {
      exclude(path) {
        const parts = path.split('/');
        return (
          excludeState(path) ||
          dataRoots.has(parts[2]) ||
          parts[2]?.startsWith('.openview-data-')
        );
      },
    })),
    ...(await collectRegularFiles(resolve(root, 'dist/server'), 'dist/server', {
      exclude: excludeState,
    })),
    ...(await collectRegularFiles(
      resolve(dependenciesRoot, 'node_modules'),
      'node_modules',
      { exclude: excludeState },
    )),
  ];
  files.sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.archivePath),
      Buffer.from(right.archivePath),
    ),
  );
  const names = new Set(files.map((file) => file.archivePath));
  for (const path of requiredRuntimeFiles)
    if (!names.has(path))
      throw new Error(`The runtime archive is missing ${path}.`);
  for (const file of files) {
    const path = file.archivePath;
    if (
      excludeState(path) ||
      path.split('/')[2]?.startsWith('.openview-data-') ||
      path.startsWith('dist/prepared/') ||
      dataDirectories.some((name) => path.startsWith(`dist/client/${name}/`))
    )
      throw new Error(
        'The runtime archive includes local state or prepared data.',
      );
  }
  return files;
}
