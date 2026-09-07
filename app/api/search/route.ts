import { placeSearch } from '@/lib/place-search';
import { FeedError } from '@/lib/feeds';
export async function GET(request: Request) {
  try {
    return Response.json(
      await placeSearch(new URL(request.url).searchParams.get('q') || ''),
      {
        headers: {
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      },
    );
  } catch (e) {
    const err =
      e instanceof FeedError
        ? e
        : new FeedError(
            'Online place search is unavailable. Prepared and loaded results are still available.',
            502,
            15,
          );
    return Response.json(
      { error: err.message },
      {
        status: err.status,
        headers: {
          'Cache-Control': 'no-store',
          'Retry-After': String(err.retryAfter),
        },
      },
    );
  }
}
