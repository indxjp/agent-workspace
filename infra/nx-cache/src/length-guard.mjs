// A pass-through stream that enforces an exact byte count. Every storage
// backend pipes the request body through one of these, so a client that
// disconnects early (fewer bytes than its Content-Length) or lies about its
// size (more bytes) makes the WHOLE upload fail instead of committing a
// truncated tar under a valid cache key. A truncated artifact restored by Nx
// would be a corrupt build output, which is the one failure a cache must
// never produce.
import { Transform } from "node:stream";

export class LengthMismatchError extends Error {
  constructor(expected, received) {
    super(
      `body length mismatch: expected ${expected} bytes, received ${received}`,
    );
    this.name = "LengthMismatchError";
    this.expected = expected;
    this.received = received;
  }
}

/**
 * @param {number} expected exact number of bytes the stream must carry
 * @returns {Transform & { bytes: () => number }}
 */
export function lengthGuard(expected) {
  let received = 0;
  const guard = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (received > expected) {
        cb(new LengthMismatchError(expected, received));
        return;
      }
      cb(null, chunk);
    },
    flush(cb) {
      cb(
        received === expected
          ? null
          : new LengthMismatchError(expected, received),
      );
    },
  });
  guard.bytes = () => received;
  return guard;
}
