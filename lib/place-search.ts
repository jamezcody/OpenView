import { cached, FeedError } from './feeds';
import { readBounded } from './bounded-fetch';
import { parsePhoton } from './search-model';
let inFlight = 0,
  lastRequest = 0;
const hasControlCharacter = (value: string) => {
  for (const character of value) {
    if (character.charCodeAt(0) <= 0x1f) return true;
  }
  return false;
};
export function photonUrl(endpoint: string | undefined, query: string) {
  let url: URL;
  try {
    url = new URL(endpoint || 'https://photon.komoot.io/api');
  } catch {
    throw new FeedError('Place search endpoint is not a valid URL.', 503);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new FeedError(
      'Place search endpoint must be HTTPS without credentials, a query string, or a fragment.',
      503,
    );
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '12');
  url.searchParams.set('lang', 'en');
  return url;
}
export async function placeSearch(query: string) {
  const q = query.trim().replace(/\s+/g, ' ');
  if (q.length < 3 || q.length > 180 || hasControlCharacter(q))
    throw new FeedError(
      'Enter 3–180 characters for online place and address search.',
      400,
      0,
    );
  return cached(`photon-v1:${q.toLowerCase()}`, 24 * 60 * 60, async () => {
    // Shared per isolate, in addition to the existing bounded/coalescing result cache.
    if (inFlight >= 2 || Date.now() - lastRequest < 1000)
      throw new FeedError(
        'Place search is busy. Try again in a few seconds.',
        429,
        3,
      );
    lastRequest = Date.now();
    inFlight++;
    try {
      const url = photonUrl(process.env.PHOTON_API_URL, q);
      const response = await fetch(url, {
        signal: AbortSignal.timeout(18000),
        headers: {
          Accept: 'application/json',
          'User-Agent': 'OpenView/0.1.1 (place and address search)',
        },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new FeedError(
          `Place search returned HTTP ${response.status}. Prepared and loaded results are still available.`,
          502,
          15,
        );
      }
      const raw = JSON.parse(
        new TextDecoder().decode(await readBounded(response, 1024 * 1024)),
      );
      return {
        items: parsePhoton(raw),
        source: 'OpenStreetMap via Photon',
        sourceUrl: 'https://github.com/komoot/photon',
        fetchedAt: Date.now(),
      };
    } finally {
      inFlight--;
    }
  });
}
