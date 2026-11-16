/**
 * Share passphrases: the scrypt hash a protected link stores, its verification off the event loop,
 * and the limiter that counts wrong guesses per share and per visitor.
 */
import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';

import { perMinuteLimiter } from '../http/rate-limit';

export function hashPassphrase(passphrase: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('base64url')}.${scryptSync(passphrase, salt, 32).toString('base64url')}`;
}
const SCRYPT_KEY_BYTES = 32;
function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, SCRYPT_KEY_BYTES, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}
/** Verified off the event loop: a guess costs ~170 ms of scrypt, which must not stall other requests. */
export async function verifyPassphrase(passphrase: string, encoded: string): Promise<boolean> {
  const [salt, expected] = encoded.split('.');
  if (!salt || !expected) return false;
  const actual = await deriveKey(passphrase, Buffer.from(salt, 'base64url'));
  const wanted = Buffer.from(expected, 'base64url');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/** Wrong passphrases a share link (and a visitor of it) may submit per minute. */
export const PASSPHRASE_FAILURES_PER_SHARE_PER_MINUTE = 10;
export const PASSPHRASE_FAILURES_PER_VISITOR_PER_MINUTE = 5;
/** Verifications in flight per share, so a burst cannot all pass the limit before any fails. */
const MAX_VERIFICATIONS_IN_FLIGHT = 4;

/**
 * The failed-guess counters. Per process, like the other public limiters (`surfaces/public/limits.ts`);
 * a successful guess is not counted, so a visitor chatting with the right passphrase is never held.
 */
export class PassphraseAttemptLimiter {
  readonly #byShare = perMinuteLimiter(PASSPHRASE_FAILURES_PER_SHARE_PER_MINUTE);
  readonly #byVisitor = perMinuteLimiter(PASSPHRASE_FAILURES_PER_VISITOR_PER_MINUTE);
  readonly #inFlight = new Map<string, number>();

  /** Reserve a verification, or the seconds to wait. Pair a reservation with `release`. */
  public reserve(shareId: string, visitorKey: string | undefined, nowMs: number): number | null {
    const share = this.#byShare.peek(shareId, nowMs);
    if (!share.admitted) return share.retryAfterSeconds;
    if (visitorKey !== undefined) {
      const visitor = this.#byVisitor.peek(`${shareId}:${visitorKey}`, nowMs);
      if (!visitor.admitted) return visitor.retryAfterSeconds;
    }
    const pending = this.#inFlight.get(shareId) ?? 0;
    if (pending >= MAX_VERIFICATIONS_IN_FLIGHT) return 1;
    this.#inFlight.set(shareId, pending + 1);
    return null;
  }

  public release(shareId: string): void {
    const pending = (this.#inFlight.get(shareId) ?? 1) - 1;
    if (pending <= 0) this.#inFlight.delete(shareId);
    else this.#inFlight.set(shareId, pending);
  }

  public recordFailure(shareId: string, visitorKey: string | undefined, nowMs: number): void {
    this.#byShare.admit(shareId, nowMs);
    if (visitorKey !== undefined) this.#byVisitor.admit(`${shareId}:${visitorKey}`, nowMs);
  }
}
