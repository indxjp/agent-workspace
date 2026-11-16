import { createHash } from 'node:crypto';
import { DEFAULT_SERVICE_TIMEOUT_SECONDS } from './cloud-run-contract.js';

import { resolveCloudRunOptions } from './cloud-run-config.js';
import { type CloudRunServiceStatus } from './cloud-run-contract.js';
import type { RuntimeConfig, RuntimeHandle } from './driver.js';

/** Label values are lowercase, at most 63 characters and may not carry a session id: hash them. */
export function labelValue(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 40);
}

/** `awSessionKey` becomes `aw-session-key`. */
export function labelKey(tag: string): string {
  return tag.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}

export const PROFILE_LABEL = 'agent-workspace-profile';
export const EXPIRES_LABEL = 'agent-workspace-expires';

export function createCloudRunState() {
  const live = new Map<string, RuntimeHandle>();
  const credentialExpiry = new Map<string, number>();
  const intakeKeys = new Map<string, string>();
  return { live, credentialExpiry, intakeKeys };
}

export class CloudRunServiceRegistry {
  constructor(
    private readonly options: ReturnType<typeof resolveCloudRunOptions>,
    private readonly state: ReturnType<typeof createCloudRunState>,
  ) {}

  servicePath(id: string): string {
    const { project, region, serviceIdPrefix } = this.options;

    return `projects/${project}/locations/${region}/services/${serviceIdPrefix}${id}`;
  }

  async ownServices(): Promise<readonly CloudRunServiceStatus[]> {
    const { client, project, region } = this.options;

    const prefix = `${this.servicePath('')}`;
    return (await client.listServices(project, region)).filter((service) =>
      service.name.startsWith(prefix),
    );
  }

  /** A manager that lost its table cannot end a sandbox by id: delete those past their lifetime. */

  async sweepExpired(): Promise<void> {
    const { now, client } = this.options;

    const nowSeconds = Math.floor(now() / 1_000);
    for (const service of await this.ownServices()) {
      const expires = Number(service.labels?.[EXPIRES_LABEL]);
      if (Number.isFinite(expires) && expires <= nowSeconds) {
        await client.deleteService(service.name);
      }
    }
  }

  forget(serviceName: string): void {
    const { live, intakeKeys, credentialExpiry } = this.state;

    const id = serviceName.slice(this.servicePath('').length);
    live.delete(id);
    intakeKeys.delete(id);
    credentialExpiry.delete(id);
  }

  assertLive(runtime: RuntimeHandle, operation: string): RuntimeHandle {
    const { live } = this.state;

    const known = live.get(runtime.id);
    if (known === undefined || known.externalId !== runtime.externalId) {
      throw new Error(
        `cloud-run runtime: cannot ${operation}; handle ${JSON.stringify(runtime.id)} was not created by this driver or is no longer live.`,
      );
    }
    return known;
  }

  async find(config: RuntimeConfig): Promise<RuntimeHandle | undefined> {
    const { now } = this.options;
    const { live, intakeKeys } = this.state;

    if (config.runtimeProfileId === undefined) return undefined;
    const profile = labelValue(config.runtimeProfileId);
    // The sweep counts from creation: a sandbox without a full run left would be deleted mid-run.
    const usableUntil = Math.floor(now() / 1_000) + (config.runSpec?.timeoutSeconds ?? 0);
    const match = (await this.ownServices()).find(
      (service) =>
        service.labels?.[PROFILE_LABEL] === profile &&
        !(Number(service.labels?.[EXPIRES_LABEL]) < usableUntil) &&
        service.ready &&
        service.url !== '' &&
        service.intakeKey !== undefined,
    );
    if (match?.intakeKey === undefined) return undefined;
    const id = match.name.slice(this.servicePath('').length);
    const expires = Number(match.labels?.[EXPIRES_LABEL]);
    const handle: RuntimeHandle = {
      id,
      driver: 'cloud-run-service',
      externalId: match.url,
      workspacePath: config.workspacePath,
      createdAt: new Date(),
      ...(Number.isFinite(expires) ? { expiresAt: new Date(expires * 1_000) } : {}),
    };
    intakeKeys.set(id, match.intakeKey);
    live.set(id, handle);
    return handle;
  }

  async destroyTagged(tags: Readonly<Record<string, string>>): Promise<void> {
    const { client } = this.options;

    const wanted = Object.entries(tags).map(([tag, value]) => [labelKey(tag), labelValue(value)]);
    for (const service of await this.ownServices()) {
      if (wanted.every(([key, value]) => key !== undefined && service.labels?.[key] === value)) {
        await client.deleteService(service.name);
        this.forget(service.name);
      }
    }
  }
  remember(
    config: RuntimeConfig,
    provisioned: {
      readonly id: string;
      readonly url: string;
      readonly proxyExpirationSeconds: number | undefined;
      readonly intakeKey: string | undefined;
    },
  ): RuntimeHandle {
    const { id, url, proxyExpirationSeconds, intakeKey } = provisioned;
    const { live, credentialExpiry, intakeKeys } = this.state;
    const spec = config.runSpec;
    const handle: RuntimeHandle = {
      id,
      driver: 'cloud-run-service',
      externalId: url,
      workspacePath: config.workspacePath,
      createdAt: new Date(),
      ...(spec?.timeoutSeconds === undefined
        ? {}
        : { expiresAt: new Date(Date.now() + spec.timeoutSeconds * 1_000) }),
    };
    // The credential in the service env is static: past its exp the proxy refuses the runtime.
    // A reused runtime must keep a full run's lifetime on its credential, so it stops counting as
    // live once less than the longest run (timeoutSeconds) remains before exp.
    if (proxyExpirationSeconds !== undefined) {
      credentialExpiry.set(
        id,
        (proxyExpirationSeconds - (spec?.timeoutSeconds ?? DEFAULT_SERVICE_TIMEOUT_SECONDS)) *
          1_000,
      );
    }
    if (intakeKey !== undefined) intakeKeys.set(id, intakeKey);
    live.set(id, handle);
    return handle;
  }
}
