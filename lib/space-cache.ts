// Wrangler/Miniflare persists this cache under .wrangler/state. It survives
// local server restarts and HMR; an edge deployment needs a shared collector.
export interface SpaceCache {
  read<T>(key: string): Promise<T | undefined>;
  write(key: string, value: unknown): Promise<void>;
}
export const SPACE_SERVER_CACHE = 'https://openview-cache.invalid/space-v3/';
export const spaceCache: SpaceCache = {
  async read<T>(key: string) {
    const cache =
      typeof caches === 'undefined'
        ? undefined
        : (caches as CacheStorage & { default?: Cache }).default;
    const response = await cache?.match(new Request(SPACE_SERVER_CACHE + key));
    return response ? ((await response.json()) as T) : undefined;
  },
  async write(key, value) {
    const cache =
      typeof caches === 'undefined'
        ? undefined
        : (caches as CacheStorage & { default?: Cache }).default;
    await cache?.put(
      new Request(SPACE_SERVER_CACHE + key),
      Response.json(value, {
        headers: { 'Cache-Control': 'max-age=1209600' },
      }),
    );
  },
};
