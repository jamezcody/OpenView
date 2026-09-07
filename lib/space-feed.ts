import type { Snapshot } from './model';
import {
  isSpaceObject,
  elementEpoch,
  MAX_ELEMENT_AGE,
  parseSpaceMetadata,
  parseSpaceOrbits,
  type SpaceObject,
  SPACE_REFRESH_INTERVAL,
  spaceRefreshAt,
  migrateSpaceRetryAt,
} from './space-data';
import { parseFallbackOrbits } from './space-fallback';
import type { SpaceCache } from './space-cache';

export const GP_CATALOG_URL = 'https://celestrak.org/pub/TLE/catalog.csv';
export const SATCAT_URL = 'https://celestrak.org/pub/satcat.csv';
export class SpaceFeedError extends Error {
  constructor(
    message: string,
    public retryAt: number,
  ) {
    super(message);
  }
}
type Control = {
  retryAt: number;
  failure: string;
  fallbackRetryAt: number;
  refreshInterval?: number;
};
type Metadata = { rows: [number, Record<string, string>][]; fetchedAt: number };
type Options = { cache?: SpaceCache; readFallback?: () => Promise<unknown> };

export function createSpaceFeed(
  readCsv: (url: string) => Promise<string>,
  clock = Date.now,
  { cache, readFallback }: Options = {},
) {
  let metadata: ReturnType<typeof parseSpaceMetadata> | undefined;
  let metadataAt = 0;
  let snapshot: Snapshot<SpaceObject> | undefined;
  let pending: Promise<Snapshot<SpaceObject>> | undefined;
  let restored = false;
  let control: Control = {
    retryAt: 0,
    failure: '',
    fallbackRetryAt: 0,
    refreshInterval: SPACE_REFRESH_INTERVAL,
  };
  const save = (key: string, value: unknown) =>
    cache?.write(key, value).catch(() => {});
  async function restore() {
    if (restored) return;
    restored = true;
    const savedControl = await cache
      ?.read<Control>('control')
      .catch(() => undefined);
    if (
      savedControl &&
      Number.isFinite(savedControl.retryAt) &&
      Number.isFinite(savedControl.fallbackRetryAt)
    ) {
      control = {
        ...savedControl,
        retryAt: migrateSpaceRetryAt(
          savedControl.retryAt,
          savedControl.refreshInterval,
        ),
        fallbackRetryAt: migrateSpaceRetryAt(
          savedControl.fallbackRetryAt,
          savedControl.refreshInterval,
        ),
        refreshInterval: SPACE_REFRESH_INTERVAL,
      };
      if (savedControl.refreshInterval !== SPACE_REFRESH_INTERVAL)
        await save('control', control);
    }
    const savedMeta = await cache
      ?.read<Metadata>('metadata')
      .catch(() => undefined);
    if (
      savedMeta &&
      Array.isArray(savedMeta.rows) &&
      Number.isFinite(savedMeta.fetchedAt)
    ) {
      metadata = new Map(savedMeta.rows);
      metadataAt = savedMeta.fetchedAt;
    }
    const saved = await cache
      ?.read<Snapshot<SpaceObject>>('snapshot')
      .catch(() => undefined);
    if (
      saved &&
      Array.isArray(saved.items) &&
      Number.isFinite(saved.fetchedAt) &&
      Number.isFinite(saved.nextRefreshAt)
    ) {
      snapshot = {
        ...saved,
        nextRefreshAt: spaceRefreshAt(saved),
        items: saved.items.filter(isSpaceObject),
      };
      if (snapshot.nextRefreshAt !== saved.nextRefreshAt)
        await save('snapshot', snapshot);
    }
  }
  return async (): Promise<Snapshot<SpaceObject>> => {
    if (pending) return pending;
    pending = (async () => {
      await restore();
      if (snapshot?.items.length && clock() < snapshot.nextRefreshAt)
        return { ...snapshot, cached: true };
      if (clock() >= control.retryAt) {
        // Persist before requesting: restarting during a download must not retry.
        control.retryAt = clock() + SPACE_REFRESH_INTERVAL;
        control.failure = 'CelesTrak source requests are paused.';
        await save('control', control);
        try {
          if (!metadata || clock() - metadataAt >= SPACE_REFRESH_INTERVAL) {
            metadata = parseSpaceMetadata(await readCsv(SATCAT_URL));
            metadataAt = clock();
            await save('metadata', {
              rows: [...metadata],
              fetchedAt: metadataAt,
            });
          }
          const items = parseSpaceOrbits(
            await readCsv(GP_CATALOG_URL),
            metadata,
            metadataAt,
          );
          const fetchedAt = clock();
          snapshot = {
            items,
            fetchedAt,
            nextRefreshAt: fetchedAt + SPACE_REFRESH_INTERVAL,
            source: 'CelesTrak · GP orbital elements and SATCAT',
            sourceUrl: 'https://celestrak.org/NORAD/elements/',
            coverage:
              'Public Earth-orbiting payloads and rocket bodies with orbital elements. Debris, unknown types and decayed objects are excluded.',
          };
          control.retryAt = 0;
          control.failure = '';
          await save('snapshot', snapshot);
          await save('control', control);
          return snapshot;
        } catch (error) {
          control.failure =
            error instanceof Error
              ? error.message
              : 'CelesTrak is unavailable.';
          const seconds = Number(
            (error as { retryAfter?: unknown })?.retryAfter,
          );
          control.retryAt =
            clock() +
            Math.max(
              SPACE_REFRESH_INTERVAL,
              Number.isFinite(seconds) ? seconds * 1000 : 0,
            );
          await save('control', control);
        }
      }
      // The independent backup still requires explicit, recent classifications.
      if (
        readFallback &&
        metadata &&
        clock() - metadataAt <= MAX_ELEMENT_AGE &&
        clock() >= control.fallbackRetryAt
      ) {
        control.fallbackRetryAt = clock() + SPACE_REFRESH_INTERVAL;
        await save('control', control);
        try {
          const backup = parseFallbackOrbits(
            await readFallback(),
            metadata,
            metadataAt,
            clock(),
          );
          const items = new Map(
            (snapshot?.items || [])
              .filter(
                (o) =>
                  isSpaceObject(o) &&
                  Math.abs(clock() - elementEpoch(o)) <= MAX_ELEMENT_AGE,
              )
              .map((o) => [o.NORAD_CAT_ID, o]),
          );
          for (const o of backup) {
            const previous = items.get(o.NORAD_CAT_ID);
            if (!previous || elementEpoch(o) >= elementEpoch(previous))
              items.set(o.NORAD_CAT_ID, o);
          }
          snapshot = {
            items: [...items.values()],
            fetchedAt: clock(),
            nextRefreshAt: Math.max(
              control.retryAt,
              clock() + SPACE_REFRESH_INTERVAL,
            ),
            source: 'SatNOGS backup + saved CelesTrak classifications',
            sourceUrl: 'https://db.satnogs.org/',
            coverage:
              'Limited backup coverage; previously saved objects are retained while their elements remain usable. Debris and unclassified objects are excluded.',
            warning: `${control.failure} Using backup orbital data while CelesTrak recovers.`,
          };
          await save('snapshot', snapshot);
          return snapshot;
        } catch (error) {
          const seconds = Number(
            (error as { retryAfter?: unknown })?.retryAfter,
          );
          if (Number.isFinite(seconds)) {
            control.fallbackRetryAt = Math.max(
              control.fallbackRetryAt,
              clock() + seconds * 1000,
            );
            await save('control', control);
          }
          // Keep the saved catalog when both providers fail.
        }
      }
      if (snapshot?.items.length) {
        snapshot = {
          ...snapshot,
          cached: true,
          nextRefreshAt: control.retryAt,
          warning: `${control.failure} Showing saved orbital data until the next source check.`,
        };
        await save('snapshot', snapshot);
        return snapshot;
      }
      throw new SpaceFeedError(
        `${control.failure} No saved space catalog is available yet.`,
        control.retryAt,
      );
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };
}
