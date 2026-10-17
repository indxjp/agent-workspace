/**
 * Bounded, per-client admission counters for the control plane's unauthenticated writes: `aw
 * login`'s pre-authentication routes (issue #242, ADR-0083 §9) and a hosted surface's visitor
 * sessions, turns and ratings (issue #622).
 *
 * Two pieces, both O(1) per request and both bounded in memory:
 *
 *   * {@link BoundedRecencyMap} — a `Map` that remembers at most `capacity` keys and, when full,
 *     forgets the least recently written one. `Map` iterates in insertion order, and a write
 *     deletes the key before setting it, so the first key is always the stalest: eviction is one
 *     `keys().next()`, never a sweep.
 *   * {@link FixedWindowLimiter} — at most `limit` admissions per key per `windowMs`, kept in a
 *     {@link BoundedRecencyMap}. Evicting a key only forgets its count, so a flood of distinct keys
 *     costs the flooder its own history, never memory.
 *
 * {@link admitClient} keys a request by the proxy-authenticated address
 * `resolvePublicVisitorIdentity` derives for the public share routes (`AW_TRUSTED_PROXY_HOPS`,
 * counted from the right, HMAC'd). Without a trusted proxy chain there is no address a caller
 * cannot forge, so every caller shares one bucket with a wider limit rather than minting a fresh
 * identity per request.
 *
 * Per process: several replicas each admit their own limit. That bounds abuse per replica, which
 * is what the in-memory state here must guarantee.
 */
import { resolvePublicVisitorIdentity } from '../shares/runnable/visitor-identity';

export class BoundedRecencyMap<V> {
  readonly #entries = new Map<string, V>();
  readonly #capacity: number;

  public constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error(`BoundedRecencyMap capacity must be a positive integer, got ${capacity}`);
    }
    this.#capacity = capacity;
  }

  public get size(): number {
    return this.#entries.size;
  }

  public get(key: string): V | undefined {
    return this.#entries.get(key);
  }

  /** Write `value`, making `key` the most recent; evict the stalest key when over capacity. */
  public set(key: string, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    if (this.#entries.size > this.#capacity) {
      const stalest = this.#entries.keys().next();
      if (stalest.done !== true) this.#entries.delete(stalest.value);
    }
  }

  public clear(): void {
    this.#entries.clear();
  }
}

interface Window {
  readonly startedMs: number;
  readonly count: number;
}

export type Admission =
  { readonly admitted: true } | { readonly admitted: false; readonly retryAfterSeconds: number };

export class FixedWindowLimiter {
  readonly #windows: BoundedRecencyMap<Window>;
  readonly #limit: number;
  readonly #windowMs: number;

  public constructor(options: {
    readonly limit: number;
    readonly windowMs: number;
    readonly capacity: number;
  }) {
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#windows = new BoundedRecencyMap(options.capacity);
  }

  #window(key: string, nowMs: number): Window {
    const current = this.#windows.get(key);
    return current === undefined || nowMs - current.startedMs >= this.#windowMs
      ? { startedMs: nowMs, count: 0 }
      : current;
  }

  /** Whether `key` has room under `limit`, without counting anything. */
  public peek(key: string, nowMs: number, limit: number = this.#limit): Admission {
    const window = this.#window(key, nowMs);
    if (window.count >= limit) {
      const remainingMs = window.startedMs + this.#windowMs - nowMs;
      return { admitted: false, retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)) };
    }
    return { admitted: true };
  }

  /** Count one request for `key` against `limit` (a per-key override for the shared bucket). */
  public admit(key: string, nowMs: number, limit: number = this.#limit): Admission {
    const verdict = this.peek(key, nowMs, limit);
    if (!verdict.admitted) return verdict;
    const window = this.#window(key, nowMs);
    this.#windows.set(key, { startedMs: window.startedMs, count: window.count + 1 });
    return verdict;
  }

  public clear(): void {
    this.#windows.clear();
  }
}

/** Distinct keys remembered per limiter; beyond it the stalest key's count is forgotten. */
export const CLIENT_MEMORY = 10_000;
export const MINUTE_MS = 60_000;

/** A limiter admitting `limit` requests per key per minute. */
export const perMinuteLimiter = (limit: number): FixedWindowLimiter =>
  new FixedWindowLimiter({ limit, windowMs: MINUTE_MS, capacity: CLIENT_MEMORY });
/** Callers without a trusted proxy chain share one bucket, this many times the per-client limit. */
const SHARED_BUCKET_FACTOR = 10;
const SHARED_BUCKET_KEY = 'shared:no-trusted-proxy-chain';

/**
 * Count one request from the client `headers` identify against `limiter`, `limit` per window; a
 * caller without a trusted proxy chain counts against the shared bucket at
 * {@link SHARED_BUCKET_FACTOR} times `limit`.
 */
export function admitClient(
  limiter: FixedWindowLimiter,
  limit: number,
  headers: Headers,
  nowMs: number,
  env: Readonly<Record<string, string | undefined>>,
): Admission {
  const bucket = clientBucket(limit, headers, env);
  return limiter.admit(bucket.key, nowMs, bucket.limit);
}

/** The key and limit {@link admitClient} counts the client `headers` identify under. */
export function clientBucket(
  limit: number,
  headers: Headers,
  env: Readonly<Record<string, string | undefined>>,
): { readonly key: string; readonly limit: number } {
  const client = resolvePublicVisitorIdentity(headers, env);
  return client.ok
    ? { key: client.visitorKey, limit }
    : { key: SHARED_BUCKET_KEY, limit: limit * SHARED_BUCKET_FACTOR };
}
