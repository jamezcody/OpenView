export class BodyTooLargeError extends Error {
  constructor(message = 'Body exceeds the size limit.') {
    super(message);
    this.name = 'BodyTooLargeError';
  }
}

/** Read request or provider bodies without trusting content-length or allocating unbounded data. */
export async function readBounded(
  message: Request | Response,
  maxBytes: number,
) {
  const length = Number(message.headers.get('content-length'));
  if (length > maxBytes) {
    await message.body?.cancel();
    throw new BodyTooLargeError();
  }
  const reader = message.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
export async function boundedJson<T = unknown>(
  message: Request | Response,
  maxBytes = 6_000_000,
): Promise<T> {
  return JSON.parse(
    new TextDecoder().decode(await readBounded(message, maxBytes)),
  );
}
