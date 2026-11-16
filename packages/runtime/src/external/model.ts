import type {
  AgentConnection,
  RuntimeCapabilities,
  RuntimeConfig,
  RuntimeDriver,
  RuntimeHandle,
} from '../driver.js';
import type { EngineImageMap } from '../engine-images.js';

export type ExternalSandboxRequest = Readonly<{
  /** The engine's image reference at the provider (E2B: `<template>:<build_id>`, LC2). */
  image: string;
  sessionKey: string;
  /** The per-sandbox bearer the runner server inside requires on every call (LC3). */
  bearer: string;
  /** `restricted`, and `open` when the capabilities omit it, are refused before the provider is called. */
  networkPolicy: 'none' | 'open';
  gatewayHost: string;
  timeoutSeconds: number;
  /**
   * Set only by a stateless driver (ADR-0126): a stable, URL-safe name for this session's sandbox,
   * derived from the manager secret. The provider records it (Vercel: the sandbox name, E2B:
   * metadata) so `find` can return the sandbox without any table of ours.
   */
  lookupKey?: string;
  /** `tool-host` starts the session's tool host (ADR-0118) instead of the runner server. */
  workload?: 'tool-host';
  /** Metadata the provider records with the sandbox, so `list` finds it again. Never a secret. */
  tags?: Readonly<Record<string, string>>;
}>;

export type ExternalSandbox = Readonly<{
  sandboxId: string;
  origin: string;
  /** Headers the provider's edge needs in addition to the bearer. */
  accessHeaders: Readonly<Record<string, string>>;
  /** Set when `create` reused a sandbox that already runs: the deadline the provider reports. */
  expiresAt?: number;
}>;

/** A sandbox `find` returned: usable as `create`'s result, with the deadline the provider reports. */
export type FoundExternalSandbox = ExternalSandbox & Readonly<{ expiresAt: number }>;

/** The sandbox a file is written into, and the deadline the provider reported for it. */
export type ExternalFileTarget = Readonly<{ sandboxId: string; expiresAt: number }>;

export interface ExternalProvider {
  readonly id: string;
  readonly capabilities: RuntimeCapabilities;
  /** The sentence refusing `restricted`, used while `capabilities` does not list `allowlist`. */
  readonly restrictedRefusal: string;
  create(request: ExternalSandboxRequest, apiKey: string): Promise<ExternalSandbox>;
  destroy(sandboxId: string, apiKey: string): Promise<void>;
  /**
   * The running sandbox `create` recorded under `lookupKey`, or `undefined`. Needed to be stateless.
   * With `renewSeconds` its deadline moves to that many seconds from now.
   */
  find?(
    lookupKey: string,
    apiKey: string,
    renewSeconds?: number,
  ): Promise<FoundExternalSandbox | undefined>;
  /** The ids of the running sandboxes `create` recorded with every one of `tags`. */
  list?(tags: Readonly<Record<string, string>>, apiKey: string): Promise<readonly string[]>;
  /** Writes `content` to the plain file `name` in the tool host's workspace (ADR-0118 TS4). */
  writeFile?(
    target: ExternalFileTarget,
    name: string,
    content: string,
    apiKey: string,
  ): Promise<void>;
}

export type ExternalDriverId = 'external' | 'vercel-sandbox' | 'cloudflare-sandbox';

export type ExternalAgentStarter<TRequest, TEvent> = (
  runtime: RuntimeHandle,
  request: TRequest,
) => AgentConnection<TEvent> | Promise<AgentConnection<TEvent>>;

export type ExternalDriverOptions<TRequest, TEvent> = Readonly<{
  provider: ExternalProvider;
  images: EngineImageMap;
  /** The sandbox-facing public gateway URL (LC3); its host is always allowed outbound (LC4). */
  gatewayUrl: string;
  startAgent: ExternalAgentStarter<TRequest, TEvent>;
  /**
   * The id this driver publishes (ADR-0120 LC1). `external` for a provider reached through that
   * driver; `vercel-sandbox` for the native driver of the Vercel cloud, which reuses this
   * implementation and is a driver of its own, not an `external` provider; `cloudflare-sandbox`
   * likewise reuses it under its own id.
   */
  driverId?: ExternalDriverId;
  /**
   * Makes the driver stateless (ADR-0126): at least 32 characters, from which the sandbox's
   * lookup key, its bearer and the seal of its handle id are derived. The handle id then carries
   * the sandbox's address, so another process holding the same secret serves it with no table. The
   * provider must implement `find`.
   */
  sealSecret?: string;
  /**
   * `tool-host` makes this driver start the session's tool host instead of the runner server
   * (ADR-0118, ADR-0120 LC5). Its handles are sealed under a label of their own, so an id of one
   * workload is no use to the other.
   */
  workload?: 'tool-host';
  /**
   * Stateless agent driver only: bounds a session's sandbox to its idle time instead of the plan
   * maximum. Its deadline is the larger of this and the run spec's `idleTimeoutSeconds`, plus a
   * margin, capped at the plan maximum, and every allocation that finds it moves the deadline out
   * again. A run spec that sets `timeoutSeconds` keeps that hard deadline instead.
   */
  sessionIdleSeconds?: number;
}>;

export type ExternalDriver<TRequest, TEvent> = Omit<
  RuntimeDriver<TRequest, TEvent>,
  'create' | 'destroy'
> &
  Readonly<{
    /**
     * `providerCredential` is the provider key for this call only (LC6). `tags` are recorded with
     * the sandbox for `destroyTagged`; they must hold no secret.
     */
    create(
      config: RuntimeConfig,
      providerCredential?: string,
      tags?: Readonly<Record<string, string>>,
    ): Promise<RuntimeHandle>;
    destroy(runtime: RuntimeHandle, providerCredential?: string): Promise<void>;
    /** Throws what `create` would refuse (run spec, credential) without calling the provider. */
    assertCreatable(config: RuntimeConfig, providerCredential?: string): void;
    /** Whether this driver created the sandbox and its deadline has not passed. No provider call. */
    isLive(runtime: RuntimeHandle): Promise<boolean>;
    /**
     * Destroys every running sandbox the provider holds with all of `tags`, whichever process
     * created it. Only for a provider that can `list`.
     */
    destroyTagged?(
      tags: Readonly<Record<string, string>>,
      providerCredential?: string,
    ): Promise<void>;
    /**
     * Stateless drivers only: the live sandbox of this session at the provider, or `undefined`. A
     * tool host's deadline is renewed to the run spec's timeout, and an idle-bounded session's to
     * its idle bound, so each ends that long after the last run that used it (an idle timeout).
     */
    find?(config: RuntimeConfig, providerCredential?: string): Promise<RuntimeHandle | undefined>;
    /** Stateless drivers only: the handle a sealed id stands for, or `undefined` if it is not ours. */
    recover?(id: string): RuntimeHandle | undefined;
    requestUrl(runtime: RuntimeHandle, path: string): string;
    authHeaders(runtime: RuntimeHandle): Promise<Record<string, string>>;
    /** The headers the provider's edge needs, without the sandbox bearer. */
    accessHeaders(runtime: RuntimeHandle): Readonly<Record<string, string>>;
    /** Writes a plain file into the sandbox's workspace; `providerCredential` is for this call only (LC6). */
    writeFile(
      runtime: RuntimeHandle,
      name: string,
      content: string,
      providerCredential?: string,
    ): Promise<void>;
  }>;
