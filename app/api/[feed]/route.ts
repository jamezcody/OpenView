import { validateBounds } from '@/lib/land-model';
import { aircraft, ships, satellites, FeedError } from '@/lib/feeds';
import { addresses } from '@/lib/address-tiles';
import { usBoundaries } from '@/lib/parcel-service';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ feed: string }> },
) {
  try {
    const { feed } = await params;
    const q = new URL(request.url).searchParams;
    const num = (name: string) => {
      const raw = q.get(name);
      if (raw === null || raw.trim() === '' || !Number.isFinite(Number(raw)))
        throw new FeedError(`A valid ${name} is required.`, 400);
      return Number(raw);
    };
    let data;
    if (feed === 'addresses' || feed === 'us-parcels') {
      const bounds = {
        west: num('west'),
        south: num('south'),
        east: num('east'),
        north: num('north'),
      };
      try {
        validateBounds(bounds, feed === 'us-parcels' ? 0.08 : 0.12);
      } catch (e) {
        throw new FeedError(
          e instanceof Error ? e.message : 'Invalid view bounds.',
          400,
        );
      }
      data =
        feed === 'addresses'
          ? await addresses(bounds)
          : await usBoundaries(bounds);
    } else if (feed === 'orbits') data = await satellites();
    else if (feed === 'ships') data = await ships();
    else if (feed === 'aircraft') {
      const lat = num('lat'),
        lon = num('lon');
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180)
        throw new FeedError('Coordinates are out of range.', 400);
      data = await aircraft(lat, lon);
    } else
      return Response.json({ error: 'Unknown data source.' }, { status: 404 });
    return Response.json(data, {
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (e) {
    const err =
      e instanceof FeedError
        ? e
        : new FeedError('Unable to retrieve this data source.');
    return Response.json(
      {
        error: err.message,
        retryAt: err.retryAt ?? Date.now() + err.retryAfter * 1000,
      },
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
