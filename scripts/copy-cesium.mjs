import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const source = new URL('node_modules/cesium/Build/Cesium/', root);
const destination = new URL('public/cesium/', root);
const stamp = new URL('.source-version', destination);
const directories = ['Workers', 'ThirdParty', 'Assets', 'Widgets'];
const sourcePath = fileURLToPath(source);
const destinationPath = fileURLToPath(destination);
const packageMetadata = JSON.parse(
  readFileSync(new URL('node_modules/cesium/package.json', root), 'utf8'),
);
if (typeof packageMetadata.version !== 'string' || !packageMetadata.version)
  throw new Error('The installed Cesium package does not declare a version.');

for (const dir of directories)
  if (!existsSync(new URL(`${dir}/`, source)))
    throw new Error(
      `The installed Cesium package is missing Build/Cesium/${dir}.`,
    );

const installedVersion = packageMetadata.version;
const copiedVersion = existsSync(stamp)
  ? readFileSync(stamp, 'utf8').trim()
  : '';
function inventory(base) {
  const files = [];
  const visit = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relative = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) visit(path, relative);
      else if (entry.isFile()) files.push(`${relative}:${statSync(path).size}`);
    }
  };
  for (const directory of directories) {
    const path = join(base, directory);
    if (!existsSync(path)) return '';
    visit(path, directory);
  }
  return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join('\n');
}

const sourceInventory = inventory(sourcePath);
const complete =
  copiedVersion === installedVersion &&
  sourceInventory !== '' &&
  inventory(destinationPath) === sourceInventory;

if (!complete) {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const dir of directories)
    cpSync(new URL(`${dir}/`, source), new URL(`${dir}/`, destination), {
      recursive: true,
    });
  writeFileSync(stamp, `${installedVersion}\n`);
}
