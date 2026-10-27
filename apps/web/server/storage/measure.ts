import { createHash } from 'node:crypto';

/** The body passed the limit the caller set; thrown out of the stream as soon as it does. */
export class BodyTooLargeError extends Error {
  public override readonly name = 'BodyTooLargeError';

  public constructor() {
    super('the body is larger than the allowed size');
  }
}

/**
 * Counts and hashes a body as it streams through, holding no chunk. Errors the stream with
 * {@link BodyTooLargeError} on the first byte past `maxBytes`. Read `result()` after the stream ends.
 */
export function measure(maxBytes: number): {
  readonly stream: TransformStream<Uint8Array, Uint8Array>;
  result(): { readonly sizeBytes: number; readonly sha256: string };
} {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      sizeBytes += chunk.byteLength;
      if (sizeBytes > maxBytes) throw new BodyTooLargeError();
      hash.update(chunk);
      controller.enqueue(chunk);
    },
  });
  return { stream, result: () => ({ sizeBytes, sha256: hash.copy().digest('hex') }) };
}
