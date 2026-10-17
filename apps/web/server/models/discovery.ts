/**
 * Model discovery (issue #129) — turning one configured connection into the models it can run.
 *
 * `GET /api/models` used to return connections and call them models (issue #129's "Current
 * State"). This is the normalised shape it returns instead: one row per provider-side model a
 * connection actually offers, `{ connectionId, providerModelId, displayName, capabilities }`,
 * driven by the same adapters the gateway itself runs requests through
 * (`packages/gateway/src/providers/registry.ts`) rather than a third hand-rolled per-provider
 * HTTP client — `probe.ts` in this directory is already a second one, built for a plain
 * reachability check, not for discovery. Reusing the registry also gets Azure's "the deployment
 * IS the model" behaviour for free: `azure-openai.ts`'s own `listModels()` already returns
 * exactly `[{ id: deployment, ... }]`, so nothing here special-cases Azure.
 *
 * `anthropic-compatible` has no row of its own in the registry — `contract.ts`'s header already
 * establishes that it "follows the same rule as anthropic" for configuration, and
 * `packages/gateway/src/index.ts`'s own run resolver maps it onto the `anthropic` adapter id the
 * same way this file does.
 *
 * The cache is a short TTL, in-process, per connection **and credential** — not a persistent
 * table, and not a background refresh job (the card's own "Deliberately not built"). The key is
 * the connection id plus an HMAC fingerprint of the credential and the connection's configuration
 * (issue #393), so rotating a key — which first-run setup does to its own connection on every
 * retry — never serves the catalogue the previous key earned. The HMAC key is random per process,
 * so the fingerprint cannot be checked against a guessed credential offline, and storing a list
 * for one fingerprint evicts every other fingerprint of the same connection, so a rotated-away
 * key's list (and its fingerprint) does not linger in memory.
 *
 * Every provider call is bounded ({@link DEFAULT_DISCOVERY_TIMEOUT_MS}): discovery sits on the
 * `POST …/runs` path through the run preflight, and a provider that never answers must not hold a
 * run start open. A timeout is reported as `unreachable`, which the run preflight treats as "the
 * list could not be read" — the run proceeds with its explicit model. On a discovery failure with a list
 * cached for the same key, the cached list is returned marked `stale: true` rather than the caller
 * seeing nothing; a first-ever failure with nothing cached answers `ok: false` with a typed
 * {@link DiscoveryFailure} and a sentence that says what actually failed. A provider that rejects
 * the key (`401`/`403`) is never answered from the cache: that is a fact about the key, not an
 * outage to ride out. Neither is a provider that refuses the connection or does not resolve
 * (issue #661): a run on this host would fail on the same network.
 */
import { createHmac, randomBytes } from 'node:crypto';

import { EgressRefusedError } from '@agent-workspace/core';
import {
  createProviderRegistry,
  ModelDiscoveryHttpError,
  registryProviderId,
  type ModelProvider as GatewayProviderAdapter,
} from '@agent-workspace/gateway/providers/registry';

import type { ResolvedModelConnection } from './store';

export type DiscoveredModelCapabilities = {
  readonly streaming: boolean;
  readonly toolUse: boolean;
  readonly thinking: boolean;
  readonly promptCaching: boolean;
  readonly structuredOutput: boolean;
  readonly contextManagement: boolean;
  readonly webSearch: boolean;
  readonly tokenCounting: boolean;
};

/** #129's normalised discovery row: one connection, one provider-side model, its capabilities. */
export type DiscoveredModel = {
  readonly connectionId: string;
  readonly providerModelId: string;
  readonly displayName: string;
  readonly capabilities: DiscoveredModelCapabilities;
};

/**
 * Why a model list could not be read (issue #393). Only `credential-rejected` is a statement about
 * the key; every other kind is about the provider or the path to it, and a screen must not word it
 * as a bad key. `connection-failed` (issue #661) is a refused connection or a name that did not
 * resolve: nothing on this host's network answers at that address, so a run would fail the same
 * way. `unreachable` keeps everything that may be passing — a timeout, a reset, an unreadable answer.
 */
export type DiscoveryFailure =
  | { readonly kind: 'credential-rejected'; readonly status: number }
  | { readonly kind: 'provider-error'; readonly status: number }
  | { readonly kind: 'connection-failed' }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'unsupported-provider'; readonly provider: string };

export type DiscoverModelsResult =
  | { readonly ok: true; readonly models: readonly DiscoveredModel[]; readonly stale: boolean }
  | { readonly ok: false; readonly reason: string; readonly failure: DiscoveryFailure };

/** Discover the models one resolved (credential-bearing) connection currently offers. */
export type ModelDiscovery = (resolved: ResolvedModelConnection) => Promise<DiscoverModelsResult>;

const DEFAULT_TTL_MS = 60_000;

/** How long one provider model-list call may take before it is abandoned as unreachable. */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;

/** The per-process HMAC key for cache fingerprints. Never persisted, logged or returned. */
const PROCESS_CACHE_SECRET = randomBytes(32);

/**
 * The sentence a screen shows for a failure. It names the HTTP status when there is one, and says
 * the key was rejected only when the provider said so.
 */
export function describeDiscoveryFailure(failure: DiscoveryFailure): string {
  switch (failure.kind) {
    case 'credential-rejected':
      return `The provider rejected the API key (HTTP ${String(failure.status)}). Replace the key on this connection.`;
    case 'provider-error':
      return `Model list unavailable (provider returned HTTP ${String(failure.status)}).`;
    case 'connection-failed':
      return "The provider could not be connected to (connection refused or DNS lookup failed). Check the connection's base URL and this host's network.";
    case 'unreachable':
      return 'Model list unavailable (the provider could not be reached, or its answer could not be read).';
    case 'unsupported-provider':
      return `Model list unavailable (no discovery adapter is registered for provider "${failure.provider}").`;
    default: {
      const unknown: never = failure;
      throw new TypeError(`unhandled discovery failure ${JSON.stringify(unknown)}`);
    }
  }
}

function classifyDiscoveryError(error: unknown): DiscoveryFailure {
  if (error instanceof ModelDiscoveryHttpError) {
    return error.status === 401 || error.status === 403
      ? { kind: 'credential-rejected', status: error.status }
      : { kind: 'provider-error', status: error.status };
  }
  if (error instanceof EgressRefusedError) {
    return error.dnsFailed ? { kind: 'connection-failed' } : { kind: 'unreachable' };
  }
  return isConnectionFailure(error) ? { kind: 'connection-failed' } : { kind: 'unreachable' };
}

/** `EAI_AGAIN` (a temporary resolver failure, typical of WSL waking) is deliberately absent: it
 * stays `unreachable`, so it is retried and a cached list is served stale. */
const CONNECTION_FAILURE_CODES: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ENOTFOUND']);

/** `fetch` reports a refused connection or a failed lookup as `TypeError('fetch failed')` whose
 * `cause` carries the system error code. */
function isConnectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause: unknown = error.cause;
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return false;
  return typeof cause.code === 'string' && CONNECTION_FAILURE_CODES.has(cause.code);
}

/**
 * The cache fingerprint: a keyed one-way digest of what a discovery call is made with. It is an
 * HMAC under a random per-process key rather than a bare hash, so a fingerprint that leaked (a heap
 * dump, a debugger) cannot be tested against candidate credentials. The credential never leaves
 * this function. Exported for tests only.
 */
export function discoveryCacheFingerprint(
  resolved: ResolvedModelConnection,
  secret: Uint8Array = PROCESS_CACHE_SECRET,
): string {
  return createHmac('sha256', secret)
    .update(resolved.credential)
    .update('\u0000')
    .update(JSON.stringify(resolved.connection.config))
    .digest('hex');
}

/** Wait for `work`, or reject once `signal` aborts — even if the adapter ignores the signal. */
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('discovery timed out'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolvePromise(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export type ModelDiscoveryOptions = {
  readonly fetch?: typeof fetch;
  /** How long a discovered list is served without a fresh call. Default 60s. */
  readonly ttlMs?: number;
  readonly now?: () => number;
  /** How long one provider call may take. Default {@link DEFAULT_DISCOVERY_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /**
   * `false` for a discovery that never reads or stores the cache: first-run setup checks a key
   * on a connection that may never be written (issue #415), and its list must not linger under
   * an id nothing else will use. Default `true`.
   */
  readonly cache?: boolean;
  /** Where a failed provider call is reported. Defaults to `console.error`. */
  readonly log?: (message: string, cause: unknown) => void;
};

function failed(failure: DiscoveryFailure): DiscoverModelsResult {
  return { ok: false, reason: describeDiscoveryFailure(failure), failure };
}

/** Build a {@link ModelDiscovery}, with its own private TTL cache. */
export function createModelDiscovery(options: ModelDiscoveryOptions = {}): ModelDiscovery {
  const registry = createProviderRegistry(
    options.fetch === undefined ? {} : { fetch: options.fetch },
  );
  const byId = new Map<string, GatewayProviderAdapter>(registry.map((row) => [row.id, row]));
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const caching = options.cache ?? true;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((message: string, cause: unknown) => console.error(message, cause));
  // One entry per connection id: storing a list for a new fingerprint replaces (evicts) the list
  // any other fingerprint of the same connection had.
  const cache = new Map<
    string,
    {
      readonly fingerprint: string;
      readonly models: readonly DiscoveredModel[];
      readonly at: number;
    }
  >();

  return async function discover(resolved: ResolvedModelConnection): Promise<DiscoverModelsResult> {
    const { connection, credential } = resolved;
    const fingerprint = discoveryCacheFingerprint(resolved);
    const entry = caching ? cache.get(connection.id) : undefined;
    const cached = entry?.fingerprint === fingerprint ? entry : undefined;
    if (cached !== undefined && now() - cached.at < ttlMs) {
      return { ok: true, models: cached.models, stale: false };
    }

    const row = byId.get(registryProviderId(connection.provider));
    if (row === undefined) {
      return cached === undefined
        ? failed({ kind: 'unsupported-provider', provider: connection.provider })
        : { ok: true, models: cached.models, stale: true };
    }

    try {
      const signal = AbortSignal.timeout(timeoutMs);
      const infos = await bounded(
        row.listModels({
          providerId: row.id,
          credential,
          requestId: crypto.randomUUID(),
          settings: connection.config,
          signal,
        }),
        signal,
      );
      const models: readonly DiscoveredModel[] = infos.map((info) => ({
        connectionId: connection.id,
        providerModelId: info.id,
        displayName: info.display_name,
        capabilities: row.capabilities,
      }));
      if (caching) cache.set(connection.id, { fingerprint, models, at: now() });
      return { ok: true, models, stale: false };
    } catch (error) {
      const failure = classifyDiscoveryError(error);
      if (failure.kind === 'credential-rejected' || failure.kind === 'connection-failed') {
        if (cached !== undefined) cache.delete(connection.id);
      } else if (cached !== undefined) {
        return { ok: true, models: cached.models, stale: true };
      }
      log(
        `[models] provider model discovery failed for connection ${connection.id} (${failure.kind})`,
        error,
      );
      return failed(failure);
    }
  };
}
