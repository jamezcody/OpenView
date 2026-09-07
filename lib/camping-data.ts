import { readBounded } from './bounded-fetch';
import type { CampPoint } from './camping-model';
import {
  CAMP_BUDGET,
  campManifest,
  validCampFile,
  campIntersects,
  campWords,
  campSearchResult,
  campRecordResult,
  CAMP_LAYERS,
  PAYMENTS,
  validCampLocation,
  type CampManifest,
  type CampFile,
  type CampCatalog,
  type CampRecord,
  type CampSearchRow,
  type CampNode,
  type CampBounds,
  type CampLayer,
  type Payment,
  type CampMarker,
} from './camping-model';

export type CampRequest = {
  signal: AbortSignal;
  requests: number;
  bytes: number;
};
export const campRequest = (signal: AbortSignal): CampRequest => ({
  signal,
  requests: 0,
  bytes: 0,
});
export class CampLimit extends Error {
  constructor() {
    super(
      'Camping loading limit reached. Zoom closer or use a more specific search.',
    );
  }
}
export class CampingData {
  private cache = new Map<string, { text: string; bytes: number }>();
  private cacheSize = 0;
  constructor(private fetcher: typeof fetch = (...args) => fetch(...args)) {}
  clear() {
    this.cache.clear();
    this.cacheSize = 0;
  }
  private async json(
    url: string,
    request: CampRequest,
    ref?: CampFile,
  ): Promise<unknown> {
    request.signal.throwIfAborted();
    if (ref && !validCampFile(ref))
      throw new Error('Invalid camping asset reference.');
    const cached = this.cache.get(url);
    if (cached) {
      this.cache.delete(url);
      this.cache.set(url, cached);
      return JSON.parse(cached.text);
    }
    const max = ref?.bytes || 65536;
    if (
      request.requests >= CAMP_BUDGET.requests ||
      request.bytes + max > CAMP_BUDGET.bytes
    )
      throw new CampLimit();
    request.requests++;
    request.bytes += max;
    const response = await this.fetcher(url, {
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(20000)]),
      cache: ref ? 'default' : 'no-store',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Camping data returned HTTP ${response.status}. Reload the prepared layer to retry.`,
      );
    }
    const bytes = await readBounded(response, max);
    request.signal.throwIfAborted();
    if (ref) {
      const hash = [
        ...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      ]
        .map((v) => v.toString(16).padStart(2, '0'))
        .join('');
      if (bytes.length !== ref.bytes || hash !== ref.sha256)
        throw new Error(
          'Camping asset failed its integrity check. Reload the prepared layer.',
        );
    }
    const text = new TextDecoder().decode(bytes),
      value = JSON.parse(text);
    request.signal.throwIfAborted();
    if (ref) {
      while (
        this.cacheSize + bytes.length > CAMP_BUDGET.cache ||
        this.cache.size >= 96
      ) {
        const key = this.cache.keys().next().value;
        if (!key) break;
        this.cacheSize -= this.cache.get(key)!.bytes;
        this.cache.delete(key);
      }
      this.cache.set(url, { text, bytes: bytes.length });
      this.cacheSize += bytes.length;
    }
    return value;
  }
  async manifest(request: CampRequest, version?: string) {
    if (version && !/^camping-[a-f0-9]{20}$/.test(version))
      throw new Error('Invalid camping release ID.');
    const m = campManifest(
      await this.json(
        version ? `/camping/${version}/manifest.json` : '/camping/latest.json',
        request,
      ),
    );
    if (version && m.version !== version)
      throw new Error(
        'Camping search release does not match its details. Refresh search.',
      );
    return m;
  }
  async file<T>(
    m: CampManifest,
    ref: CampFile,
    request: CampRequest,
  ): Promise<T> {
    return (await this.json(
      `/camping/${m.version}/${ref.file}`,
      request,
      ref,
    )) as T;
  }
  async catalog(m: CampManifest, request: CampRequest) {
    return this.file<CampCatalog>(m, m.catalog, request);
  }
  async record(
    m: CampManifest,
    id: string,
    request: CampRequest,
  ): Promise<CampRecord | null> {
    if (id.length > 250) throw new Error('Invalid camping record ID.');
    const catalog = await this.catalog(m, request);
    const hash = [
      ...new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id)),
      ),
    ]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('');
    const ref = Object.entries(catalog.details).find(([prefix]) =>
      hash.startsWith(prefix),
    )?.[1];
    if (!ref) return null;
    const rows = await this.file<CampRecord[]>(m, ref, request);
    const record = rows.find((r) => r.id === id) || null;
    if (
      record &&
      (!PAYMENTS.includes(record.payment_status) ||
        !CAMP_LAYERS.includes(record.layer) ||
        typeof record.payment_evidence !== 'string')
    )
      throw new Error('Invalid camping record.');
    return record;
  }
  async children(
    m: CampManifest,
    id: string,
    page: number,
    request: CampRequest,
  ) {
    const catalog = await this.catalog(m, request);
    const index = await this.file<Record<string, CampFile[]>>(
      m,
      catalog.links,
      request,
    );
    const files = index[id] || [];
    return {
      items: files[page]
        ? await this.file<[string, string, [number, number] | null][]>(
            m,
            files[page],
            request,
          )
        : [],
      pages: files.length,
    };
  }
  async search(query: string, request: CampRequest) {
    const m = await this.manifest(request);
    const exact =
      /^(?:osm:(?:node|way|relation)[/:]\d+|(?:ridb_facility|ridb_campsite|usfs|blm_point|blm_area|usgs):[^\s]+)$/i.test(
        query.trim(),
      );
    if (exact) {
      const r = await this.record(m, query.trim(), request);
      return {
        items: r ? [campRecordResult(r, m.version)] : [],
        total: r ? 1 : 0,
      };
    }
    const tokens = [...new Set(campWords(query))];
    if (!tokens.length || tokens.length > 8 || tokens.some((t) => t.length < 2))
      throw new Error(
        'Camping search uses word prefixes of at least 2 characters (up to 8 words), or a full source ID.',
      );
    const catalog = await this.catalog(m, request);
    let ids: Set<number> | null = null;
    // Longer words first often eliminate broad matches without extra requests.
    for (const word of tokens.sort((a, b) => b.length - a.length)) {
      const refs = catalog.terms.filter(
        (f) => f.last >= word && f.first < word + '\uffff',
      );
      const matches = new Set<number>();
      for (const ref of refs) {
        const rows = await this.file<[string, number[]][]>(m, ref, request);
        for (const [term, list] of rows)
          if (term.startsWith(word)) for (const id of list) matches.add(id);
      }
      ids = new Set([...(ids || matches)].filter((id) => matches.has(id)));
      if (!ids.size) break;
    }
    const selected = [...(ids || [])].sort((a, b) => a - b).slice(0, 40);
    const rows = new Map<number, CampSearchRow[]>();
    for (const id of selected) {
      const page = Math.floor(id / 256);
      if (!catalog.search[page])
        throw new Error('Invalid camping search locator.');
      if (!rows.has(page)) {
        try {
          rows.set(page, await this.file(m, catalog.search[page], request));
        } catch (e) {
          if (!(e instanceof CampLimit)) throw e;
          break;
        }
      }
    }
    return {
      items: selected
        .filter((id) => rows.has(Math.floor(id / 256)))
        .map((id) =>
          campSearchResult(
            rows.get(Math.floor(id / 256))![id % 256],
            m.version,
          ),
        ),
      total: ids?.size || 0,
    };
  }
  async view(
    m: CampManifest,
    bounds: CampBounds,
    height: number,
    layers: CampLayer[],
    payments: Payment[],
    request: CampRequest,
  ) {
    const markers: CampMarker[] = [];
    let limited = false;
    const depth = Math.max(
      0,
      Math.min(22, Math.floor(Math.log2(40000000 / Math.max(80, height)))),
    );
    const match = (l: CampLayer, p: Payment) =>
      layers.includes(l) && payments.includes(p);
    const aggregates = (node: CampNode, key: string) =>
      node.g
        .filter((g) => match(g[0], g[1]))
        .map(
          (g) =>
            ({
              id: `group:${key}:${g[0]}:${g[1]}`,
              name: `${g[2].toLocaleString()} source records`,
              layer: g[0],
              payment: g[1],
              count: g[2],
              lon: g[3],
              lat: g[4],
              cluster: true,
              bounds: node.b,
              version: m.version,
            }) as CampMarker,
        );
    const walk = async (
      input: CampNode,
      level: number,
      key: string,
    ): Promise<CampMarker[]> => {
      request.signal.throwIfAborted();
      if (
        !campIntersects(bounds, input.b) ||
        !input.g.some((g) => match(g[0], g[1]))
      )
        return [];
      const groups = aggregates(input, key);
      if (level >= depth) return groups;
      try {
        const node = input.ref
          ? await this.file<CampNode>(m, input.ref, request)
          : input;
        if (node.ref) return walk(node, level, key);
        if (node.c) {
          const out: CampMarker[] = [];
          for (let i = 0; i < node.c.length; i++) {
            out.push(...(await walk(node.c[i], level + 1, key + i)));
            if (out.length > CAMP_BUDGET.markers) {
              limited = true;
              return groups;
            }
          }
          return out;
        }
        const rows = [...(node.r || [])];
        for (const ref of node.pages || [])
          rows.push(...(await this.file<CampPoint[]>(m, ref, request)));
        const out: CampMarker[] = [];
        for (const row of rows) {
          const [id, name, layer, payment, lon, lat] = row;
          if (
            !match(layer, payment) ||
            !validCampLocation([lon, lat]) ||
            !campIntersects(bounds, [lon, lat, lon, lat])
          )
            continue;
          if (layer === 'sites' && height > 18000) continue;
          out.push({
            id,
            recordId: id,
            name,
            layer,
            payment,
            lon,
            lat,
            count: 1,
            cluster: false,
            bounds: node.b,
            version: m.version,
          });
        }
        if (height > 18000)
          out.push(...groups.filter((g) => g.layer === 'sites'));
        if (out.length > CAMP_BUDGET.markers) {
          limited = true;
          return groups;
        }
        return out;
      } catch (e) {
        if (!(e instanceof CampLimit)) throw e;
        limited = true;
        return groups;
      }
    };
    if (layers.length && payments.length)
      markers.push(
        ...(await walk(await this.file<CampNode>(m, m.root, request), 0, 'r')),
      );
    return {
      markers,
      limited,
      requests: request.requests,
      bytes: request.bytes,
    };
  }
}
