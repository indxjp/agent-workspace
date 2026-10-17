/**
 * The `external` runtime driver (ADR-0120 LC1): one sandbox per session at a provider this package
 * calls over REST, reached over HTTPS with a per-sandbox bearer (LC3).
 *
 * The provider seam below takes and returns only this package's own types, so no vendor type
 * crosses the driver boundary. The provider API key is an argument of the calls that need it and is
 * held nowhere (LC6): not in the handle, not in the live table, not in any message.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import type {
  AgentConnection,
  RuntimeCapabilities,
  RuntimeConfig,
  RuntimeDriver,
  RuntimeHandle,
  RuntimeRunSpec,
} from '../driver.js';
import { requireEngineImage } from '../engine-images.js';
import type { EngineImageMap } from '../engine-images.js';
import { RuntimeRefusalError } from './errors.js';
import { createSealer, type SealedSandbox, type Sealer } from './stateless.js';

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

type LiveSandbox = Readonly<{
  handle: RuntimeHandle;
  sandboxId: string;
  origin: string;
  bearer: string;
  accessHeaders: Readonly<Record<string, string>>;
  expiresAt: number;
}>;

const FALLBACK_TIMEOUT_SECONDS = 3_600;
const SESSION_IDLE_MARGIN_SECONDS = 120;
const WORKSPACE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/** The session a sandbox belongs to; the run profile is part of it, as in the manager's own key. */
function sessionKeyOf(config: RuntimeConfig): string {
  return `${config.runtimeProfileId ?? ''}:${config.sessionId}`;
}

function gatewayHostOf(gatewayUrl: string, label: string): string {
  let url: URL;
  try {
    url = new URL(gatewayUrl);
  } catch {
    throw new Error(`${label} runtime: gatewayUrl must be an absolute https URL.`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`${label} runtime: gatewayUrl must be an https URL (ADR-0120 LC3).`);
  }
  return url.hostname;
}

function requireCredential(
  credential: string | undefined,
  providerId: string,
  label: string,
): string {
  if (credential === undefined || credential.length === 0) {
    throw new RuntimeRefusalError(
      'provider_credential_required',
      `${label} runtime: provider ${providerId} needs its credential on every call that reaches it (ADR-0120 LC6); none was supplied.`,
    );
  }
  return credential;
}

/** Refuse, by name, what the provider cannot enforce (spec §14.5); never pass it on weakened. */
function assertSupportedRunSpec(
  spec: RuntimeRunSpec | undefined,
  provider: ExternalProvider,
  driverId: ExternalDriverId,
): void {
  if (spec !== undefined && spec.driver !== driverId) {
    throw new Error(`${driverId} runtime: run spec selects incompatible driver ${spec.driver}.`);
  }
  // No run spec means `none`; a provider that cannot prove `none` must refuse it too.
  if (
    (spec === undefined || spec.networkPolicy === 'none') &&
    !provider.capabilities.networkPolicies.includes('none')
  ) {
    throw new RuntimeRefusalError(
      'network_policy_unsupported',
      `external runtime: provider ${provider.id} refuses the none network policy until its live lane proves the sandbox reaches only the gateway (ADR-0120 LC4, ADR-0131).`,
    );
  }
  if (spec === undefined) return;
  if (
    spec.networkPolicy === 'restricted' &&
    !provider.capabilities.networkPolicies.includes('allowlist')
  ) {
    throw new RuntimeRefusalError('network_policy_unsupported', provider.restrictedRefusal);
  }
  if (spec.networkPolicy === 'open' && !provider.capabilities.networkPolicies.includes('open')) {
    throw new RuntimeRefusalError(
      'network_policy_unsupported',
      `external runtime: provider ${provider.id} refuses the open network policy until its live lane proves the always-denied ranges are enforced (ADR-0120 LC4).`,
    );
  }
  if (spec.allowedDomains !== undefined && spec.allowedDomains.length > 0) {
    throw new RuntimeRefusalError(
      'run_spec_unsupported',
      `${driverId} runtime: provider ${provider.id} cannot enforce allowedDomains without the restricted network policy (ADR-0120 LC4).`,
    );
  }
  if (spec.persistPaths !== undefined && spec.persistPaths.length > 0) {
    throw new RuntimeRefusalError(
      'run_spec_unsupported',
      `${driverId} runtime: provider ${provider.id} has no persistent filesystem, so persistPaths cannot be enforced.`,
    );
  }
}

export function createExternalDriver<TRequest, TEvent>(
  options: ExternalDriverOptions<TRequest, TEvent>,
): ExternalDriver<TRequest, TEvent> {
  const { provider, images } = options;
  const driverId = options.driverId ?? 'external';
  const gatewayHost = gatewayHostOf(options.gatewayUrl, driverId);
  const live = new Map<string, LiveSandbox>();
  const sealer =
    options.sealSecret === undefined
      ? undefined
      : createSealer(
          options.sealSecret,
          options.workload === undefined ? driverId : `${driverId}/${options.workload}`,
        );
  if (sealer !== undefined && provider.find === undefined) {
    throw new Error(
      `${driverId} runtime: provider ${provider.id} cannot find a sandbox again, so it cannot be used statelessly (ADR-0126).`,
    );
  }

  function handleOf(id: string, sealed: SealedSandbox): RuntimeHandle {
    return {
      id,
      driver: driverId,
      externalId: sealed.sandboxId,
      workspacePath: sealed.workspacePath,
      createdAt: new Date(sealed.createdAt),
      expiresAt: new Date(sealed.expiresAt),
    };
  }

  /** What this driver holds for a handle: its live table, else (stateless) what the id seals. */
  function lookup(id: string): LiveSandbox | undefined {
    const stored = live.get(id);
    if (stored !== undefined || sealer === undefined) return stored;
    const sealed = sealer.open(id);
    if (sealed === undefined) return undefined;
    return {
      handle: handleOf(id, sealed),
      sandboxId: sealed.sandboxId,
      origin: sealed.origin,
      bearer: sealer.bearer(sealed.lookupKey),
      accessHeaders: sealed.accessHeaders,
      expiresAt: sealed.expiresAt,
    };
  }

  function sealedHandle(by: Sealer, sealed: SealedSandbox): RuntimeHandle {
    return handleOf(by.seal(sealed), sealed);
  }

  function assertLive(runtime: RuntimeHandle, operation: string): LiveSandbox {
    const known = lookup(runtime.id);
    if (known === undefined || known.handle.externalId !== runtime.externalId) {
      throw new Error(
        `${driverId} runtime: cannot ${operation}; handle ${JSON.stringify(runtime.id)} was not created by this driver or is no longer live.`,
      );
    }
    return known;
  }

  /** The deadline an idle-bounded session sandbox gets, or `undefined` when none applies. */
  function idleBoundSeconds(spec: RuntimeRunSpec | undefined, limit: number): number | undefined {
    const { sessionIdleSeconds } = options;
    if (
      sessionIdleSeconds === undefined ||
      sealer === undefined ||
      options.workload !== undefined ||
      spec?.timeoutSeconds !== undefined
    ) {
      return undefined;
    }
    const idle = Math.max(spec?.idleTimeoutSeconds ?? 0, sessionIdleSeconds);
    return Math.min(idle + SESSION_IDLE_MARGIN_SECONDS, limit);
  }

  /** Everything `create` refuses before the provider is called; returns the provider key. */
  function assertCreatable(config: RuntimeConfig, providerCredential: string | undefined): string {
    if (config.sessionId.length === 0) {
      throw new Error(`${driverId} runtime: sessionId must be a non-empty string.`);
    }
    assertSupportedRunSpec(config.runSpec, provider, driverId);
    return requireCredential(providerCredential, provider.id, driverId);
  }

  return {
    id: driverId,
    capabilities: provider.capabilities,

    assertCreatable(config, providerCredential) {
      assertCreatable(config, providerCredential);
    },

    async create(config, providerCredential, tags) {
      const apiKey = assertCreatable(config, providerCredential);
      const spec = config.runSpec;
      const image = requireEngineImage(images, config.engine, driverId);
      const limit = provider.capabilities.maxSessionSeconds ?? FALLBACK_TIMEOUT_SECONDS;
      const timeoutSeconds =
        idleBoundSeconds(spec, limit) ?? Math.min(spec?.timeoutSeconds ?? limit, limit);
      const lookupKey = sealer?.lookupKey(sessionKeyOf(config));
      const bearer =
        sealer !== undefined && lookupKey !== undefined
          ? sealer.bearer(lookupKey)
          : randomBytes(32).toString('base64url');
      const sandbox = await provider.create(
        {
          image,
          sessionKey: config.sessionId,
          bearer,
          networkPolicy: spec?.networkPolicy === 'open' ? 'open' : 'none',
          gatewayHost,
          timeoutSeconds,
          ...(lookupKey === undefined ? {} : { lookupKey }),
          ...(options.workload === undefined ? {} : { workload: options.workload }),
          ...(tags === undefined ? {} : { tags }),
        },
        apiKey,
      );
      const createdAt = new Date();
      const expiresAt = sandbox.expiresAt ?? createdAt.getTime() + timeoutSeconds * 1_000;
      if (sealer !== undefined && lookupKey !== undefined) {
        return sealedHandle(sealer, {
          sandboxId: sandbox.sandboxId,
          origin: sandbox.origin,
          accessHeaders: sandbox.accessHeaders,
          createdAt: createdAt.getTime(),
          expiresAt,
          workspacePath: config.workspacePath,
          lookupKey,
        });
      }
      const handle: RuntimeHandle = {
        id: randomUUID(),
        driver: driverId,
        externalId: sandbox.sandboxId,
        workspacePath: config.workspacePath,
        createdAt,
        expiresAt: new Date(expiresAt),
      };
      live.set(handle.id, {
        handle,
        sandboxId: sandbox.sandboxId,
        origin: sandbox.origin,
        bearer,
        accessHeaders: sandbox.accessHeaders,
        expiresAt,
      });
      return handle;
    },

    async startAgent(runtime, request) {
      return await options.startAgent(assertLive(runtime, 'start an agent').handle, request);
    },

    async destroy(runtime, providerCredential) {
      const known = assertLive(runtime, 'destroy');
      // Without the key the sandbox is left to its provider-side timeout, and stays addressable
      // here so the caller can retry with the key.
      await provider.destroy(
        known.sandboxId,
        requireCredential(providerCredential, provider.id, driverId),
      );
      live.delete(known.handle.id);
    },

    isLive(runtime) {
      const known = lookup(runtime.id);
      return Promise.resolve(
        known !== undefined &&
          known.handle.externalId === runtime.externalId &&
          Date.now() < known.expiresAt,
      );
    },

    ...(provider.list === undefined
      ? {}
      : {
          async destroyTagged(tags: Readonly<Record<string, string>>, providerCredential?: string) {
            const apiKey = requireCredential(providerCredential, provider.id, driverId);
            const ids = new Set((await provider.list?.(tags, apiKey)) ?? []);
            await Promise.all([...ids].map((id) => provider.destroy(id, apiKey)));
            for (const [id, entry] of live) if (ids.has(entry.sandboxId)) live.delete(id);
          },
        }),

    ...(sealer === undefined
      ? {}
      : {
          async find(config: RuntimeConfig, providerCredential?: string) {
            const apiKey = requireCredential(providerCredential, provider.id, driverId);
            const lookupKey = sealer.lookupKey(sessionKeyOf(config));
            const limit = provider.capabilities.maxSessionSeconds ?? FALLBACK_TIMEOUT_SECONDS;
            const renew =
              options.workload === 'tool-host'
                ? Math.min(config.runSpec?.timeoutSeconds ?? limit, limit)
                : idleBoundSeconds(config.runSpec, limit);
            const found = await provider.find?.(lookupKey, apiKey, renew);
            if (found === undefined) return undefined;
            return sealedHandle(sealer, {
              sandboxId: found.sandboxId,
              origin: found.origin,
              accessHeaders: found.accessHeaders,
              createdAt: Date.now(),
              expiresAt: found.expiresAt,
              workspacePath: config.workspacePath,
              lookupKey,
            });
          },
          recover(id: string) {
            const known = lookup(id);
            return known !== undefined && Date.now() < known.expiresAt ? known.handle : undefined;
          },
        }),

    requestUrl(runtime, path) {
      return `${assertLive(runtime, 'address').origin}${path}`;
    },

    authHeaders(runtime) {
      const known = assertLive(runtime, 'authenticate');
      return Promise.resolve({
        authorization: `Bearer ${known.bearer}`,
        ...known.accessHeaders,
      });
    },

    accessHeaders(runtime) {
      return assertLive(runtime, 'address').accessHeaders;
    },

    async writeFile(runtime, name, content, providerCredential) {
      const known = assertLive(runtime, 'write a file');
      if (!WORKSPACE_FILE_NAME.test(name)) {
        throw new Error(`${driverId} runtime: ${JSON.stringify(name)} is not a plain file name.`);
      }
      if (provider.writeFile === undefined) {
        throw new Error(`${driverId} runtime: provider ${provider.id} cannot write a file.`);
      }
      await provider.writeFile(
        { sandboxId: known.sandboxId, expiresAt: known.expiresAt },
        name,
        content,
        requireCredential(providerCredential, provider.id, driverId),
      );
    },
  };
}
