import { readBounded } from './bounded-fetch';
import {
  intersectsRadio,
  matchesRadio,
  RADIO_CATEGORIES,
  radioNodeId,
  radioPath,
  radioVersion,
  validRadioGroup,
  validateRadioManifest,
  validateRadioNode,
  type RadioFile,
  type RadioFilters,
  type RadioManifest,
  type RadioMarker,
  type RadioNode,
  type RadioRecord,
  type RadioGroup,
} from './radio-model';
import type { Bounds } from './model';

export class RadioBudgetError extends Error {}
export class RadioBudget {
  requests = 0;
  bytes = 0;
  constructor(
    public maxRequests = 160,
    public maxBytes = 4 * 1024 * 1024,
  ) {}
  add(bytes: number) {
    this.bytes += bytes;
    if (this.bytes > this.maxBytes)
      throw new RadioBudgetError(
        'View limit reached. Zoom closer to load more records.',
      );
  }
  request() {
    if (++this.requests > this.maxRequests)
      throw new RadioBudgetError(
        'View limit reached. Zoom closer to load more records.',
      );
  }
}
/** Hook-owned cache: bounded, versioned and never shared with another viewer. */
export class RadioData {
  private cache = new Map<string, { value: unknown; bytes: number }>();
  private cacheBytes = 0;
  constructor(
    private fetcher: typeof fetch = (...args) => fetch(...args),
    private base = '/radio',
  ) {}
  private remember(url: string, value: unknown, bytes: number) {
    while (
      this.cacheBytes + bytes > 8 * 1024 * 1024 ||
      this.cache.size >= 256
    ) {
      const first = this.cache.keys().next().value;
      if (!first) break;
      this.cacheBytes -= this.cache.get(first)!.bytes;
      this.cache.delete(first);
    }
    this.cache.set(url, { value, bytes });
    this.cacheBytes += bytes;
  }
  private async json(
    path: string,
    signal: AbortSignal,
    budget: RadioBudget,
    expected?: { sha256: string; bytes?: number },
    fresh = false,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const url = `${this.base}/${path}`;
    const hit = !fresh && this.cache.get(url);
    if (hit) {
      budget.add(hit.bytes);
      this.cache.delete(url);
      this.cache.set(url, hit);
      return hit.value;
    }
    budget.request();
    const response = await this.fetcher(url, {
      signal,
      cache: fresh ? 'no-store' : 'default',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Prepared ${this.base === '/cells' ? 'cell' : 'radio'} data unavailable (HTTP ${response.status}). Retry to reload this view.`,
      );
    }
    const bytes = await readBounded(
      response,
      expected?.bytes !== undefined ? 262144 : 1048576,
    );
    signal.throwIfAborted();
    budget.add(bytes.length);
    if (expected) {
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      )
        .map((v) => v.toString(16).padStart(2, '0'))
        .join('');
      if (
        (expected.bytes !== undefined && bytes.length !== expected.bytes) ||
        digest !== expected.sha256
      )
        throw new Error(
          `${this.base === '/cells' ? 'Cell' : 'Radio'} data integrity check failed. Reload the dataset.`,
        );
    }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!fresh) this.remember(url, value, bytes.length);
    return value;
  }
  async manifest(signal: AbortSignal): Promise<RadioManifest> {
    const b = new RadioBudget();
    const pointer = (await this.json(
      'latest.json',
      signal,
      b,
      undefined,
      true,
    )) as Record<string, unknown>;
    if (
      pointer.schemaVersion !== 1 ||
      !radioVersion(pointer.version) ||
      pointer.manifest !== `versions/${pointer.version}/manifest.json`
    )
      throw new Error('Radio dataset pointer is invalid.');
    if (
      typeof pointer.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(pointer.sha256)
    )
      throw new Error('Radio manifest checksum is missing.');
    const value = await this.json(
      String(pointer.manifest),
      signal,
      b,
      { sha256: pointer.sha256 },
      true,
    );
    const manifest = validateRadioManifest(value);
    if (this.base === '/cells' && manifest.datasetKind !== 'cell-locations')
      throw new Error(
        'The cell asset root does not contain a cell-location dataset.',
      );
    if (manifest.version !== pointer.version)
      throw new Error('Radio dataset changed during loading. Retry.');
    return manifest;
  }
  async node(
    version: string,
    id: string,
    signal: AbortSignal,
    budget: RadioBudget,
  ): Promise<RadioNode> {
    if (!radioVersion(version) || !radioNodeId(id))
      throw new Error('Invalid radio node path.');
    return validateRadioNode(
      await this.json(`versions/${version}/nodes/${id}.json`, signal, budget),
      id,
    );
  }
  async page(
    version: string,
    file: RadioFile,
    signal: AbortSignal,
    budget: RadioBudget,
  ): Promise<unknown[]> {
    if (!radioVersion(version) || !radioPath(file.file))
      throw new Error('Invalid radio data path.');
    const value = await this.json(
      `versions/${version}/${file.file}`,
      signal,
      budget,
      file,
    );
    if (
      !Array.isArray(value) ||
      value.length > 256 ||
      !value.every(validRadioGroup)
    )
      throw new Error('Radio record data is invalid.');
    return value;
  }
  async view(
    manifest: RadioManifest,
    bounds: Bounds,
    depth: number,
    filters: RadioFilters,
    signal: AbortSignal,
  ) {
    const budget = new RadioBudget(),
      markers: RadioMarker[] = [];
    let queue = ['r'],
      limited = false;
    try {
      while (queue.length) {
        signal.throwIfAborted();
        const ids = queue.splice(0, 6);
        const nodes = await Promise.all(
          ids.map((id) => this.node(manifest.version, id, signal, budget)),
        );
        const targets: RadioNode[] = [];
        for (const n of nodes) {
          if (!intersectsRadio(n.bounds, bounds)) continue;
          if (
            n.id.length - 1 < depth &&
            n.children.length &&
            queue.length + n.children.length < 128
          )
            queue.push(...n.children);
          else targets.push(n);
        }
        // A node is added only after all its summaries passed integrity checks.
        for (const [targetIndex, n] of targets.entries()) {
          if (!n.children.length && n.id.length - 1 <= depth) {
            const points = new Map<string, RadioMarker>();
            for (const f of n.recordPages) {
              const rows = (await this.page(
                manifest.version,
                f,
                signal,
                budget,
              )) as RadioRecord[];
              for (const r of rows) {
                if (
                  !matchesRadio(r, filters) ||
                  !intersectsRadio([r.lon, r.lat, r.lon, r.lat], bounds)
                )
                  continue;
                const key = `${r.category}:${r.lat}:${r.lon}`;
                const p = points.get(key) || {
                  id: `${n.id}:${key}`,
                  node: n.id,
                  category: r.category,
                  lat: r.lat,
                  lon: r.lon,
                  count: 0,
                  bounds: n.bounds,
                  recordIds: [],
                };
                p.count++;
                p.recordIds!.push(r.id);
                points.set(key, p);
              }
            }
            const available = Math.max(0, 240 - markers.length);
            markers.push(...Array.from(points.values()).slice(0, available));
            if (points.size > available || markers.length >= 240) {
              limited = true;
              queue = [];
              break;
            }
            continue;
          }
          const sums = new Map<
            string,
            { count: number; lat: number; lon: number }
          >();
          for (const f of n.summaryPages) {
            const groups = (await this.page(
              manifest.version,
              f,
              signal,
              budget,
            )) as RadioGroup[];
            for (const g of groups) {
              if (!Number.isSafeInteger(g.count) || g.count < 1)
                throw new Error('Invalid radio aggregate count.');
              if (!matchesRadio(g, filters)) continue;
              const a = sums.get(g.category) || { count: 0, lat: 0, lon: 0 };
              a.count += g.count;
              a.lat += g.lat * g.count;
              a.lon += g.lon * g.count;
              sums.set(g.category, a);
            }
          }
          for (const category of RADIO_CATEGORIES) {
            const a = sums.get(category);
            if (a && markers.length < 240)
              markers.push({
                id: `${n.id}:${category}`,
                node: n.id,
                category,
                count: a.count,
                lat: a.lat / a.count,
                lon: a.lon / a.count,
                bounds: n.bounds,
              });
          }
          if (markers.length >= 240) {
            limited =
              queue.length > 0 ||
              targetIndex < targets.length - 1 ||
              sums.size > 1;
            queue = [];
            break;
          }
        }
      }
    } catch (e) {
      if (e instanceof RadioBudgetError) limited = true;
      else throw e;
    }
    return { markers, limited, requests: budget.requests, bytes: budget.bytes };
  }
}

/** Incremental depth-first inspection; no offset scan and no discarded records between pages. */
export class RadioInspection {
  private tasks: (
    | { node: string; summaryIndex: number; metadata?: RadioNode }
    | { page: RadioFile }
  )[];
  private buffer: RadioRecord[] = [];
  private identities: Set<string> | undefined;
  constructor(
    private data: RadioData,
    private version: string,
    marker: RadioMarker,
    private filters: RadioFilters,
  ) {
    this.tasks = [{ node: marker.node, summaryIndex: 0 }];
    this.filters = { ...filters, categories: [marker.category] };
    this.identities = marker.recordIds ? new Set(marker.recordIds) : undefined;
  }
  async next(signal: AbortSignal) {
    const savedTasks = this.tasks.map((t) => ({ ...t })),
      savedBuffer = [...this.buffer];
    try {
      const budget = new RadioBudget(48, 2 * 1024 * 1024),
        records: RadioRecord[] = [];
      let limited = false;
      while (records.length < 50) {
        signal.throwIfAborted();
        if (this.buffer.length) {
          records.push(this.buffer.shift()!);
          continue;
        }
        const task = this.tasks[0];
        if (!task) break;
        try {
          if ('node' in task) {
            const n =
              task.metadata ||
              (await this.data.node(this.version, task.node, signal, budget));
            task.metadata = n;
            let matches = false;
            while (task.summaryIndex < n.summaryPages.length) {
              const f = n.summaryPages[task.summaryIndex];
              const groups = (await this.data.page(
                this.version,
                f,
                signal,
                budget,
              )) as RadioGroup[];
              task.summaryIndex++;
              if (groups.some((g) => matchesRadio(g, this.filters))) {
                matches = true;
                break;
              }
            }
            this.tasks.shift();
            if (matches)
              this.tasks.unshift(
                ...(n.children.length
                  ? n.children.map((node) => ({ node, summaryIndex: 0 }))
                  : n.recordPages.map((page) => ({ page }))),
              );
          } else {
            const rows = (await this.data.page(
              this.version,
              task.page,
              signal,
              budget,
            )) as RadioRecord[];
            if (
              !rows.every(
                (r) =>
                  typeof r.id === 'string' && typeof r.record_id === 'string',
              )
            )
              throw new Error('Radio record identities are missing.');
            this.buffer = rows.filter(
              (r) =>
                matchesRadio(r, this.filters) &&
                (!this.identities || this.identities.has(r.id)),
            );
            this.tasks.shift();
          }
        } catch (e) {
          if (e instanceof RadioBudgetError) {
            limited = true;
            break;
          }
          throw e;
        }
      }
      return {
        records,
        more: this.buffer.length > 0 || this.tasks.length > 0,
        limited,
      };
    } catch (e) {
      this.tasks = savedTasks;
      this.buffer = savedBuffer;
      throw e;
    }
  }
}
