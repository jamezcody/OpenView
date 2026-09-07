import { runPropertyInquiry, validateAddress } from '@/lib/property-inquiry';
import { BodyTooLargeError, readBounded } from '@/lib/bounded-fetch';
export async function POST(request: Request) {
  let address;
  try {
    const text = new TextDecoder().decode(await readBounded(request, 16_000));
    address = validateAddress(JSON.parse(text).address);
  } catch (error) {
    if (error instanceof BodyTooLargeError)
      return Response.json({ error: 'Request too large.' }, { status: 413 });
    return Response.json(
      { error: 'A valid selected address is required.' },
      { status: 400 },
    );
  }
  const lifecycle = new AbortController();
  request.signal.addEventListener('abort', () => lifecycle.abort(), {
    once: true,
  });
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: unknown) => {
        if (!lifecycle.signal.aborted)
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
      };
      try {
        await runPropertyInquiry(address, emit, lifecycle.signal);
      } catch (e) {
        emit({
          type: 'error',
          message: e instanceof Error ? e.message : 'Property lookup failed.',
        });
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      lifecycle.abort();
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
