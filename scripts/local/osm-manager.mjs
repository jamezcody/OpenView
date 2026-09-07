import { randomUUID } from 'node:crypto';
import { mkdir, stat, statfs, rename, rm, writeFile } from 'node:fs/promises';
import { resolve, join, isAbsolute, relative, basename } from 'node:path';
import { freemem, availableParallelism } from 'node:os';
import {
  atomicJson,
  jsonFile,
  boundedResponse,
  sourceMetadata,
  validateSourceUrl,
  downloadFile,
  validatePbf,
  pmtilesHeader,
  verifyDownload,
} from './osm-io.mjs';
import { ensureTools, runProcess } from './osm-tools.mjs';
import {
  osmProfile,
  importArguments,
  PROFILE_VERSION,
} from './osm-profile.mjs';

const GiB = 1024 ** 3;
const ACTIVE = new Set(['downloading', 'checking', 'preparing']);
export function inside(root, path) {
  const part = relative(resolve(root), resolve(path));
  return !part.startsWith('..') && !isAbsolute(part);
}
export class OsmManager {
  constructor(root, applicationRoot, dependencies = {}) {
    this.root = resolve(root);
    this.applicationRoot = resolve(applicationRoot);
    this.fetcher = dependencies.fetcher || fetch;
    this.ensureTools = dependencies.ensureTools || ensureTools;
    this.runProcess = dependencies.runProcess || runProcess;
    this.state = {
      schemaVersion: 1,
      storage: join(this.root, 'datasets'),
      datasets: [],
    };
    /** @type {{id: string, controller: AbortController, promise: Promise<void>} | null} */
    this.active = null;
    this.catalog = null;
    this.saving = Promise.resolve();
  }
  async initialize() {
    await mkdir(this.root, { recursive: true });
    this.state = await jsonFile(join(this.root, 'library.json'), this.state);
    if (this.state.schemaVersion !== 1 || !Array.isArray(this.state.datasets))
      throw new Error('The OSM library needs recovery: unsupported metadata.');
    for (const dataset of this.state.datasets)
      if (ACTIVE.has(dataset.status)) {
        dataset.status =
          dataset.status === 'downloading' ? 'paused' : 'interrupted';
        dataset.message =
          'OpenView stopped. Resume the download or prepare the file again.';
        dataset.enabled = false;
      }
    for (const dataset of this.state.datasets)
      dataset.sourceReady ??= ['ready', 'downloaded'].includes(dataset.status);
    await mkdir(this.state.storage, { recursive: true });
    await this.save();
  }
  save() {
    const snapshot = JSON.parse(JSON.stringify(this.state));
    this.saving = this.saving
      .catch(() => {})
      .then(() => atomicJson(join(this.root, 'library.json'), snapshot));
    return this.saving;
  }
  dataset(id) {
    const dataset = this.state.datasets.find((item) => item.id === id);
    if (!dataset || !/^[a-f0-9-]{36}$/.test(id))
      throw new Error('Dataset not found.');
    return dataset;
  }
  snapshot() {
    return {
      ...this.state,
      busy: Boolean(this.active),
      activeId: this.active?.id || null,
      freeMemoryBytes: freemem(),
      datasets: this.state.datasets.map((d) => ({ ...d })),
    };
  }
  async regions() {
    if (this.catalog && Date.now() - this.catalog.at < 3600000)
      return this.catalog.items;
    const response = await this.fetcher(
      'https://download.geofabrik.de/index-v1-nogeom.json',
      { signal: AbortSignal.timeout(30000) },
    );
    const raw = JSON.parse(
      (await boundedResponse(response, 8 * 1024 * 1024)).toString(),
    );
    if (!Array.isArray(raw.features) || raw.features.length > 10000)
      throw new Error('Unexpected regional catalog.');
    const title = (value) =>
      value
        .replace(/[-_]/g, ' ')
        .replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
    const names = new Map(
      raw.features.flatMap(({ properties: p } = {}) =>
        typeof p?.id === 'string' && typeof p.name === 'string'
          ? [[p.id, p.name === p.id ? title(p.id.split('/').at(-1)) : p.name]]
          : [],
      ),
    );
    const countries = new Intl.DisplayNames(['en'], { type: 'region' });
    const items = raw.features
      .flatMap(({ properties: p } = {}) => {
        if (
          !p ||
          typeof p.id !== 'string' ||
          typeof p.name !== 'string' ||
          typeof p.urls?.pbf !== 'string'
        )
          return [];
        try {
          const url = validateSourceUrl(p.urls.pbf);
          const parents = new URL(url).pathname.split('/').slice(1, -1);
          const codes = ['iso3166-1:alpha2', 'iso3166-1:alpha3', 'iso3166-2']
            .flatMap((key) => (Array.isArray(p[key]) ? p[key] : []))
            .filter(
              (code) =>
                typeof code === 'string' && /^[A-Z0-9-]{2,12}$/.test(code),
            );
          return [
            {
              id: p.id,
              name: names.get(p.id),
              parent: parents
                .map(
                  (part, index) =>
                    names.get(parents.slice(0, index + 1).join('/')) ||
                    names.get(part) ||
                    (/^[a-z]{2}$/.test(part)
                      ? countries.of(part.toUpperCase())
                      : title(part)),
                )
                .join(' / '),
              codes,
              url,
            },
          ];
        } catch {
          return [];
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!items.length)
      throw new Error(
        'Geofabrik returned no downloadable regions. Please try again.',
      );
    this.catalog = { at: Date.now(), items };
    return items;
  }
  async inspect(selection) {
    let name = 'Entire planet',
      url = 'https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf';
    if (selection !== 'planet') {
      const region = (await this.regions()).find((r) => r.id === selection);
      if (!region) throw new Error('Choose a region from the catalog.');
      ({ name, url } = region);
    }
    const metadata = await sourceMetadata(url, this.fetcher);
    const free = await statfs(this.state.storage);
    return {
      ...metadata,
      name,
      selection,
      compressed: true,
      estimatedWorkingBytes: Math.ceil(metadata.bytes * 8 + GiB),
      freeDiskBytes: free.bavail * free.bsize,
    };
  }
  async setStorage(path) {
    if (this.active)
      throw new Error(
        'Wait for the current operation before changing storage.',
      );
    if (typeof path !== 'string' || !isAbsolute(path) || path.length > 1000)
      throw new Error('Enter an absolute local folder path.');
    const location = resolve(path);
    if (
      inside(this.applicationRoot, location) ||
      inside(location, this.applicationRoot)
    )
      throw new Error(
        'Store OSM data outside the OpenView application folder.',
      );
    if (process.env.LOCALAPPDATA) {
      const settings = join(process.env.LOCALAPPDATA, 'OpenView');
      if (inside(settings, location) || inside(location, settings))
        throw new Error(
          'Choose a folder outside OpenView settings so uninstall will preserve your maps.',
        );
    }
    // A separate library folder avoids installer/uninstaller ownership of user data.
    await mkdir(location, { recursive: true });
    const probe = join(location, `.openview-${randomUUID()}`);
    await writeFile(probe, '');
    await rm(probe);
    this.state.storage = location;
    await this.save();
  }
  async addLocal(path) {
    if (typeof path !== 'string' || !isAbsolute(path))
      throw new Error('Select a local .osm.pbf file.');
    path = resolve(path);
    const info = await validatePbf(path);
    const existing = this.state.datasets.find(
      (d) => d.sourcePath.toLowerCase() === path.toLowerCase(),
    );
    if (existing) return existing;
    const dataset = {
      id: randomUUID(),
      name: basename(path),
      sourcePath: path,
      managedSource: false,
      sourceReady: true,
      sourceUrl: '',
      bytes: info.size,
      downloadedBytes: info.size,
      status: 'downloaded',
      enabled: false,
      created: new Date().toISOString(),
      message: 'File registered. Prepare it to display on the map.',
    };
    dataset.directory = join(this.state.storage, dataset.id);
    await mkdir(dataset.directory, { recursive: true });
    this.state.datasets.push(dataset);
    await this.save();
    return dataset;
  }
  async addDownload(selection) {
    if (this.active) throw new Error('Another OSM operation is running.');
    const preview = await this.inspect(selection);
    const space = await statfs(this.state.storage);
    if (space.bavail * space.bsize < preview.bytes + 512 * 1024 ** 2)
      throw new Error(
        'Not enough free disk space for this download. Choose another storage folder.',
      );
    const dataset = {
      id: randomUUID(),
      name: preview.name,
      sourceUrl: preview.url,
      sourcePath: '',
      managedSource: true,
      sourceReady: false,
      bytes: preview.bytes,
      downloadedBytes: 0,
      etag: preview.etag,
      modified: preview.modified,
      status: 'paused',
      enabled: false,
      created: new Date().toISOString(),
      message: 'Waiting to download.',
    };
    dataset.directory = join(this.state.storage, dataset.id);
    dataset.sourcePath = join(dataset.directory, 'source.osm.pbf');
    await mkdir(dataset.directory, { recursive: true });
    this.state.datasets.push(dataset);
    await this.save();
    this.start(dataset.id, 'download');
    return dataset;
  }
  start(id, operation) {
    if (this.active) throw new Error('Another OSM operation is running.');
    const dataset = this.dataset(id);
    if (!['download', 'prepare'].includes(operation))
      throw new Error('Unknown operation.');
    if (
      operation === 'download' &&
      (!dataset.managedSource || dataset.status === 'ready')
    )
      throw new Error('This dataset does not need downloading.');
    if (
      operation === 'prepare' &&
      dataset.managedSource &&
      !dataset.sourceReady
    )
      throw new Error('Finish and verify the download before preparing it.');
    const controller = new AbortController();
    this.active = { id, controller, promise: Promise.resolve() };
    dataset.status = operation === 'download' ? 'downloading' : 'checking';
    dataset.enabled = false;
    dataset.message =
      operation === 'download'
        ? 'Checking download…'
        : 'Checking source and available space…';
    const job = (async () => {
      try {
        await this.save();
        if (operation === 'download')
          await this.download(dataset, controller.signal);
        else await this.prepare(dataset, controller.signal);
      } catch (error) {
        dataset.status = controller.signal.aborted
          ? operation === 'download'
            ? 'paused'
            : 'interrupted'
          : 'error';
        dataset.message = controller.signal.aborted
          ? 'Stopped. You can continue later.'
          : error.message;
      } finally {
        this.active = null;
        await this.save();
      }
    })();
    this.active.promise = job;
    void job.catch(() => {});
  }
  async pause(id) {
    if (this.active?.id !== id) throw new Error('This dataset is not running.');
    const active = this.active;
    active.controller.abort();
    await active.promise;
  }
  async download(dataset, signal) {
    const metadata = await sourceMetadata(
      dataset.sourceUrl,
      this.fetcher,
      signal,
    );
    const path = `${dataset.sourcePath}.part`;
    if (
      metadata.bytes !== dataset.bytes ||
      metadata.etag !== dataset.etag ||
      metadata.modified !== dataset.modified
    ) {
      await rm(path, { force: true });
      Object.assign(dataset, metadata, { downloadedBytes: 0 });
    }
    let checksum = null;
    const response = await this.fetcher(`${dataset.sourceUrl}.md5`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    });
    if (response.ok) {
      const text = (await boundedResponse(response, 4096)).toString();
      checksum = /^([0-9a-f]{32})\s/i.exec(text)?.[1];
      if (!checksum)
        throw new Error('The provider returned an invalid checksum.');
    } else {
      await response.body?.cancel();
      throw new Error(
        'Could not obtain the provider checksum. Try again later.',
      );
    }
    await downloadFile({
      ...metadata,
      path,
      signal,
      fetcher: this.fetcher,
      progress: (bytes) => {
        dataset.downloadedBytes = bytes;
        dataset.message = 'Downloading compressed OSM PBF…';
      },
    });
    dataset.status = 'checking';
    dataset.message = 'Verifying source checksum…';
    await verifyDownload(path, checksum, 'md5', signal);
    await rename(path, dataset.sourcePath);
    await validatePbf(dataset.sourcePath);
    dataset.md5 = checksum;
    dataset.downloadedBytes = dataset.bytes;
    dataset.sourceReady = true;
    dataset.status = 'downloaded';
    dataset.message = 'Download verified. Prepare the file to display it.';
  }
  async prepare(dataset, signal) {
    const source = await validatePbf(dataset.sourcePath);
    dataset.bytes = source.size;
    const free = await statfs(dataset.directory),
      estimate = Math.ceil(source.size * 8 + GiB);
    if (free.bavail * free.bsize < estimate)
      throw new Error(
        `Preparation estimates ${(estimate / GiB).toFixed(1)} GiB free disk space. Choose a smaller extract or a disk with more space.`,
      );
    const available = freemem();
    if (available < 1536 * 1024 ** 2)
      throw new Error(
        'Preparation needs at least 1.5 GiB available RAM. Close other applications and try again.',
      );
    const memoryMiB = Math.floor(
      Math.min(
        Math.max(1024, source.size / 2 / 1024 ** 2),
        (available / 1024 ** 2) * 0.45,
      ),
    );
    const tools = await this.ensureTools(this.root, signal, (message) => {
      dataset.message = message;
    });
    signal.throwIfAborted();
    dataset.status = 'preparing';
    dataset.message = 'Preparing OSM map tiles on disk…';
    const work = join(dataset.directory, 'preparation');
    // Only this dataset's generated work is replaced; source files are never removed here.
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    const schema = join(work, 'openview.yml'),
      output = join(work, 'map.pmtiles');
    await writeFile(
      schema,
      JSON.stringify(osmProfile(dataset.sourcePath), null, 2),
    );
    await this.runProcess(
      tools.java,
      importArguments(
        tools.jar,
        dataset.sourcePath,
        output,
        schema,
        join(work, 'temporary'),
        memoryMiB,
        Math.max(1, Math.min(4, availableParallelism() - 1)),
      ),
      {
        signal,
        cwd: work,
        onLine: (line) => {
          dataset.message = line;
        },
      },
    );
    signal.throwIfAborted();
    const header = await pmtilesHeader(output);
    const after = await stat(dataset.sourcePath);
    if (after.size !== source.size || after.mtimeMs !== source.mtimeMs)
      throw new Error(
        'The source changed during preparation. Prepare the file again.',
      );
    const destination = join(dataset.directory, `map-${randomUUID()}.pmtiles`);
    await rename(output, destination);
    const previous = dataset.tilesPath;
    Object.assign(dataset, {
      ...header,
      tilesPath: destination,
      tilesBytes: (await stat(destination)).size,
      profileVersion: PROFILE_VERSION,
      status: 'ready',
      enabled: false,
      prepared: new Date().toISOString(),
      message: 'Ready. Enable this dataset to show its map layers.',
    });
    await this.save();
    if (previous && inside(dataset.directory, previous))
      await rm(previous, { force: true });
    await rm(work, { recursive: true, force: true });
  }
  async enable(id, enabled) {
    const dataset = this.dataset(id);
    if (typeof enabled !== 'boolean' || dataset.status !== 'ready')
      throw new Error('Prepare the dataset before enabling it.');
    await stat(dataset.tilesPath);
    // One source at a time prevents duplicate regional/planet geometry and bounds total rendering work.
    if (enabled) for (const item of this.state.datasets) item.enabled = false;
    dataset.enabled = enabled;
    await this.save();
  }
  async remove(id) {
    if (this.active?.id === id)
      throw new Error('Stop the operation before removing it.');
    const dataset = this.dataset(id);
    if (
      basename(dataset.directory) !== id ||
      resolve(dataset.directory) === this.root
    )
      throw new Error('Invalid dataset directory.');
    // Never recurse through an imported original; only our UUID directory is managed.
    if (!dataset.managedSource && inside(dataset.directory, dataset.sourcePath))
      throw new Error(
        'Cannot remove a directory containing a supplied source file.',
      );
    if (
      this.state.datasets.some(
        (d) =>
          d.id !== id && inside(dataset.directory, d.sourcePath || d.directory),
      )
    )
      throw new Error(
        'Another dataset uses files in this directory. Remove that registration first.',
      );
    await rm(dataset.directory, { recursive: true, force: true });
    this.state.datasets = this.state.datasets.filter((d) => d.id !== id);
    await this.save();
  }
  async close() {
    if (this.active) {
      const active = this.active;
      active.controller.abort();
      await active.promise;
    }
    await this.saving;
  }
}
