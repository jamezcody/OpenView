import type { Snapshot } from './model';
import {
  isSpaceObject,
  type SpaceObject,
  spaceRefreshAt,
  SPACE_REFRESH_INTERVAL,
  migrateSpaceRetryAt,
} from './space-data';

const RETRY_KEY = 'openview-space-retry-v3';
export function readSpaceRetry(): { retryAt: number; error: string } | null {
  try {
    const saved = JSON.parse(localStorage.getItem(RETRY_KEY) || 'null');
    const retryAt =
      saved && Number.isFinite(saved.retryAt)
        ? migrateSpaceRetryAt(saved.retryAt, saved.refreshInterval)
        : 0;
    return saved &&
      Number.isFinite(saved.retryAt) &&
      retryAt > Date.now() &&
      typeof saved.error === 'string'
      ? { ...saved, retryAt }
      : null;
  } catch {
    return null;
  }
}
export function saveSpaceRetry(
  value: { retryAt: number; error: string } | null,
) {
  try {
    if (value)
      localStorage.setItem(
        RETRY_KEY,
        JSON.stringify({ ...value, refreshInterval: SPACE_REFRESH_INTERVAL }),
      );
    else localStorage.removeItem(RETRY_KEY);
  } catch {
    /* Storage restrictions must not prevent using the current tab. */
  }
}

async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('openview-space-v2', 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore('snapshots');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function readSpaceSnapshot(): Promise<Snapshot<SpaceObject> | null> {
  const db = await database();
  try {
    const saved = await new Promise<Snapshot<SpaceObject>>(
      (resolve, reject) => {
        const request = db
          .transaction('snapshots')
          .objectStore('snapshots')
          .get('latest');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      },
    );
    if (
      !saved ||
      !Array.isArray(saved.items) ||
      !Number.isFinite(saved.fetchedAt) ||
      !Number.isFinite(saved.nextRefreshAt)
    )
      return null;
    return {
      ...saved,
      nextRefreshAt: spaceRefreshAt(saved),
      items: saved.items.filter(isSpaceObject),
    };
  } finally {
    db.close();
  }
}
export async function saveSpaceSnapshot(snapshot: Snapshot<SpaceObject>) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('snapshots', 'readwrite');
      transaction
        .objectStore('snapshots')
        .put(
          { ...snapshot, items: snapshot.items.filter(isSpaceObject) },
          'latest',
        );
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}
