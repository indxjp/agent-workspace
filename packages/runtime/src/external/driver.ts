import { createExternalState } from './state.js';
/**
 * The `external` runtime driver (ADR-0120 LC1): one sandbox per session at a provider this package
 * calls over REST, reached over HTTPS with a per-sandbox bearer (LC3).
 *
 * The provider seam below takes and returns only this package's own types, so no vendor type
 * crosses the driver boundary. The provider API key is an argument of the calls that need it and is
 * held nowhere (LC6): not in the handle, not in the live table, not in any message.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import type { RuntimeConfig, RuntimeHandle, RuntimeRunSpec } from '../driver.js';
import { requireEngineImage } from '../engine-images.js';
import { RuntimeRefusalError } from './errors.js';
import { createSealer } from './stateless.js';

export type {
  ExternalSandboxRequest,
  ExternalSandbox,
  FoundExternalSandbox,
  ExternalFileTarget,
  ExternalProvider,
  ExternalDriverId,
  ExternalAgentStarter,
  ExternalDriverOptions,
  ExternalDriver,
} from './model.js';
import type {
  ExternalProvider,
  ExternalDriverId,
  ExternalDriverOptions,
  ExternalDriver,
} from './model.js';

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

class ExternalSessionDriver<TRequest, TEvent> {
  private readonly options: ExternalDriverOptions<TRequest, TEvent>;
  readonly provider: ExternalProvider;
  private readonly images: ExternalDriverOptions<TRequest, TEvent>['images'];
  private readonly maximumSessionSeconds: number;
  readonly driverId: ExternalDriverId;
  private readonly gatewayHost: string;
  readonly sealer: ReturnType<typeof createSealer> | undefined;
  private readonly state: ReturnType<typeof createExternalState>;
  constructor(options: ExternalDriverOptions<TRequest, TEvent>) {
    this.options = options;
    this.provider = options.provider;
    this.images = options.images;
    this.maximumSessionSeconds =
      this.provider.capabilities.maxSessionSeconds ?? FALLBACK_TIMEOUT_SECONDS;
    this.driverId = options.driverId ?? 'external';
    this.gatewayHost = gatewayHostOf(options.gatewayUrl, this.driverId);
    this.sealer =
      options.sealSecret === undefined
        ? undefined
        : createSealer(
            options.sealSecret,
            options.workload === undefined ? this.driverId : `${this.driverId}/${options.workload}`,
          );
    if (this.sealer !== undefined && this.provider.find === undefined) {
      throw new Error(
        `${this.driverId} runtime: provider ${this.provider.id} cannot find a sandbox again, so it cannot be used statelessly (ADR-0126).`,
      );
    }
    this.state = createExternalState(this.driverId, this.sealer);
  }
  /** The deadline an idle-bounded session sandbox gets, or `undefined` when none applies. */
  private idleBoundSeconds(spec: RuntimeRunSpec | undefined): number | undefined {
    const { sessionIdleSeconds } = this.options;
    if (
      sessionIdleSeconds === undefined ||
      this.sealer === undefined ||
      this.options.workload !== undefined ||
      spec?.timeoutSeconds !== undefined
    ) {
      return undefined;
    }
    const idle = Math.max(spec?.idleTimeoutSeconds ?? 0, sessionIdleSeconds);
    return Math.min(idle + SESSION_IDLE_MARGIN_SECONDS, this.maximumSessionSeconds);
  }

  private hardTimeoutSeconds(spec: RuntimeRunSpec | undefined): number {
    return Math.min(spec?.timeoutSeconds ?? this.maximumSessionSeconds, this.maximumSessionSeconds);
  }

  /** Everything `create` refuses before the provider is called; returns the provider key. */
  private creatableCredential(
    config: RuntimeConfig,
    providerCredential: string | undefined,
  ): string {
    if (config.sessionId.length === 0) {
      throw new Error(`${this.driverId} runtime: sessionId must be a non-empty string.`);
    }
    assertSupportedRunSpec(config.runSpec, this.provider, this.driverId);
    return requireCredential(providerCredential, this.provider.id, this.driverId);
  }

  readonly assertCreatable: ExternalDriver<TRequest, TEvent>['assertCreatable'] = (
    config,
    providerCredential,
  ) => {
    this.creatableCredential(config, providerCredential);
  };

  readonly create: ExternalDriver<TRequest, TEvent>['create'] = async (
    config,
    providerCredential,
    tags,
  ) => {
    const apiKey = this.creatableCredential(config, providerCredential);
    const spec = config.runSpec;
    const image = requireEngineImage(this.images, config.engine, this.driverId);
    const timeoutSeconds = this.idleBoundSeconds(spec) ?? this.hardTimeoutSeconds(spec);
    const lookupKey = this.sealer?.lookupKey(sessionKeyOf(config));
    const bearer =
      this.sealer !== undefined && lookupKey !== undefined
        ? this.sealer.bearer(lookupKey)
        : randomBytes(32).toString('base64url');
    const sandbox = await this.provider.create(
      {
        image,
        sessionKey: config.sessionId,
        bearer,
        networkPolicy: spec?.networkPolicy === 'open' ? 'open' : 'none',
        gatewayHost: this.gatewayHost,
        timeoutSeconds,
        ...(lookupKey === undefined ? {} : { lookupKey }),
        ...(this.options.workload === undefined ? {} : { workload: this.options.workload }),
        ...(tags === undefined ? {} : { tags }),
      },
      apiKey,
    );
    const createdAt = new Date();
    const expiresAt = sandbox.expiresAt ?? createdAt.getTime() + timeoutSeconds * 1_000;
    if (this.sealer !== undefined && lookupKey !== undefined) {
      return this.state.sealedHandle(this.sealer, {
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
      driver: this.driverId,
      externalId: sandbox.sandboxId,
      workspacePath: config.workspacePath,
      createdAt,
      expiresAt: new Date(expiresAt),
    };
    this.state.live.set(handle.id, {
      handle,
      sandboxId: sandbox.sandboxId,
      origin: sandbox.origin,
      bearer,
      accessHeaders: sandbox.accessHeaders,
      expiresAt,
    });
    return handle;
  };

  readonly startAgent: ExternalDriver<TRequest, TEvent>['startAgent'] = async (
    runtime,
    request,
  ) => {
    return await this.options.startAgent(
      this.state.assertLive(runtime, 'start an agent').handle,
      request,
    );
  };

  readonly destroy: ExternalDriver<TRequest, TEvent>['destroy'] = async (
    runtime,
    providerCredential,
  ) => {
    const known = this.state.assertLive(runtime, 'destroy');
    // Without the key the sandbox is left to its provider-side timeout, and stays addressable
    // here so the caller can retry with the key.
    await this.provider.destroy(
      known.sandboxId,
      requireCredential(providerCredential, this.provider.id, this.driverId),
    );
    this.state.live.delete(known.handle.id);
  };

  readonly isLive: ExternalDriver<TRequest, TEvent>['isLive'] = (runtime) => {
    const known = this.state.lookup(runtime.id);
    return Promise.resolve(
      known !== undefined &&
        known.handle.externalId === runtime.externalId &&
        Date.now() < known.expiresAt,
    );
  };

  readonly requestUrl: ExternalDriver<TRequest, TEvent>['requestUrl'] = (runtime, path) => {
    return `${this.state.assertLive(runtime, 'address').origin}${path}`;
  };

  readonly authHeaders: ExternalDriver<TRequest, TEvent>['authHeaders'] = (runtime) => {
    const known = this.state.assertLive(runtime, 'authenticate');
    return Promise.resolve({
      authorization: `Bearer ${known.bearer}`,
      ...known.accessHeaders,
    });
  };

  readonly accessHeaders: ExternalDriver<TRequest, TEvent>['accessHeaders'] = (runtime) => {
    return this.state.assertLive(runtime, 'address').accessHeaders;
  };

  readonly writeFile: ExternalDriver<TRequest, TEvent>['writeFile'] = async (
    runtime,
    name,
    content,
    providerCredential,
  ) => {
    const known = this.state.assertLive(runtime, 'write a file');
    if (!WORKSPACE_FILE_NAME.test(name)) {
      throw new Error(
        `${this.driverId} runtime: ${JSON.stringify(name)} is not a plain file name.`,
      );
    }
    if (this.provider.writeFile === undefined) {
      throw new Error(
        `${this.driverId} runtime: provider ${this.provider.id} cannot write a file.`,
      );
    }
    await this.provider.writeFile(
      { sandboxId: known.sandboxId, expiresAt: known.expiresAt },
      name,
      content,
      requireCredential(providerCredential, this.provider.id, this.driverId),
    );
  };

  readonly destroyTagged: NonNullable<ExternalDriver<TRequest, TEvent>['destroyTagged']> = async (
    tags: Readonly<Record<string, string>>,
    providerCredential?: string,
  ) => {
    const apiKey = requireCredential(providerCredential, this.provider.id, this.driverId);
    const ids = new Set((await this.provider.list?.(tags, apiKey)) ?? []);
    await Promise.all([...ids].map((id) => this.provider.destroy(id, apiKey)));
    for (const [id, entry] of this.state.live)
      if (ids.has(entry.sandboxId)) this.state.live.delete(id);
  };

  readonly find: NonNullable<ExternalDriver<TRequest, TEvent>['find']> = async (
    config: RuntimeConfig,
    providerCredential?: string,
  ) => {
    const apiKey = requireCredential(providerCredential, this.provider.id, this.driverId);
    const sealer = this.sealer;
    if (sealer === undefined) return undefined;
    const lookupKey = sealer.lookupKey(sessionKeyOf(config));
    const renew =
      this.options.workload === 'tool-host'
        ? this.hardTimeoutSeconds(config.runSpec)
        : this.idleBoundSeconds(config.runSpec);
    const found = await this.provider.find?.(lookupKey, apiKey, renew);
    if (found === undefined) return undefined;
    return this.state.sealedHandle(sealer, {
      sandboxId: found.sandboxId,
      origin: found.origin,
      accessHeaders: found.accessHeaders,
      createdAt: Date.now(),
      expiresAt: found.expiresAt,
      workspacePath: config.workspacePath,
      lookupKey,
    });
  };

  readonly recover: NonNullable<ExternalDriver<TRequest, TEvent>['recover']> = (id: string) => {
    const known = this.state.lookup(id);
    return known !== undefined && Date.now() < known.expiresAt ? known.handle : undefined;
  };
}

export function createExternalDriver<TRequest, TEvent>(
  options: ExternalDriverOptions<TRequest, TEvent>,
): ExternalDriver<TRequest, TEvent> {
  const driver = new ExternalSessionDriver(options);
  return {
    id: driver.driverId,
    capabilities: driver.provider.capabilities,
    assertCreatable: driver.assertCreatable,
    create: driver.create,
    startAgent: driver.startAgent,
    destroy: driver.destroy,
    isLive: driver.isLive,
    requestUrl: driver.requestUrl,
    authHeaders: driver.authHeaders,
    accessHeaders: driver.accessHeaders,
    writeFile: driver.writeFile,
    ...(driver.provider.list === undefined ? {} : { destroyTagged: driver.destroyTagged }),
    ...(driver.sealer === undefined ? {} : { find: driver.find, recover: driver.recover }),
  };
}
