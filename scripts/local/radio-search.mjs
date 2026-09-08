import { Worker } from 'node:worker_threads';

export class RadioSearchService {
  constructor(publicRoot) {
    this.publicRoot = publicRoot;
    this.pending = new Map();
    this.serial = 0;
  }
  stop(message = 'Radio search stopped. Retry the search.') {
    const worker = this.worker;
    this.worker = null;
    this.version = null;
    for (const request of this.pending.values())
      request.reject(new Error(message));
    this.pending.clear();
    return worker?.terminate();
  }
  search(query, limit, radioVersion, searchVersion = '') {
    if (
      typeof query !== 'string' ||
      query.length > 180 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 500 ||
      !/^radio-[a-f0-9]{20}$/.test(radioVersion) ||
      (searchVersion !== '' && !/^search-[a-f0-9]{20}$/.test(searchVersion))
    )
      return Promise.reject(new Error('Invalid radio search query.'));
    const version = `${radioVersion}:${searchVersion}`;
    if (this.worker && this.version !== version)
      this.stop('Radio search dataset changed. Retry the search.');
    if (this.pending.size >= 2)
      return Promise.reject(
        new Error(
          'Radio search is busy. Wait for the current query or narrow your search.',
        ),
      );
    if (!this.worker) {
      this.version = version;
      const worker = (this.worker = new Worker(
        new URL('./radio-search-worker.mjs', import.meta.url),
        {
          workerData: {
            publicRoot: this.publicRoot,
            radioVersion,
            searchVersion,
          },
        },
      ));
      worker.on('message', (message) => {
        if (this.worker !== worker) return;
        if (message.fatal) {
          this.stop(message.fatal);
          return;
        }
        if (message.ready) return;
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.error) {
          request.reject(new Error(message.error));
          if (message.error.includes('older dataset')) this.stop(message.error);
        } else request.resolve(message.result);
      });
      worker.on('error', () => {
        if (this.worker === worker)
          this.stop(
            'Local radio search is unavailable. Restart OpenView to retry.',
          );
      });
      worker.on('exit', () => {
        if (this.worker === worker)
          this.stop('Local radio search worker stopped. Retry the search.');
      });
    }
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const timer = setTimeout(
        () =>
          this.stop(
            'Radio search took too long. Add a callsign, license identifier, or name to narrow the search.',
          ),
        30000,
      );
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.worker.postMessage({ id, query, limit });
    });
  }
  close() {
    return this.stop();
  }
}
