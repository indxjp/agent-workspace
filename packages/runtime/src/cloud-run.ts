/**
 * The `cloud-run-service` runtime driver (see `driver.ts`'s union comment and
 * `docs/adr/ADR-cloud-run-service-driver.md` for why this exists instead of the spec's
 * `cloud-run-sandbox`).
 *
 * One `create()` deploys one private Cloud Run v2 service running the runtime image; one
 * `destroy()` deletes that exact service. Same one-resource-per-session shape as `docker.ts`
 * (one container) and `kubernetes.ts` (one pod) — just over the Cloud Run Admin API instead of the
 * Docker socket or the Kubernetes API.
 */

import { resolveCloudRunOptions } from './cloud-run-config.js';
import {
  type CloudRunDriver,
  type CloudRunDriverOptions,
  type CloudRunRuntimeCapabilities,
  type CloudRunToolDriver,
} from './cloud-run-contract.js';
import { createRuntimeService } from './cloud-run-create.js';
import { CloudRunServiceRegistry, createCloudRunState } from './cloud-run-registry.js';
import type { RuntimeConfig, RuntimeHandle } from './driver.js';

/** The subpath `@agent-workspace/runtime/driver/cloud-run` carries its credential helpers too. */
export * from './gcp-auth.js';

/**
 * gen2 execution environment: a microVM with full Linux compatibility, not gVisor's syscall
 * emulation — spec appendix A.7.2 calls this out explicitly as the one to use for the runner.
 * Cloud Run has no bind-mountable persistent volume, so `persistentFilesystem` is false; the
 * manager still forwards `/files` over the same §14.3 HTTP contract every other driver uses, it is
 * just this driver's `create()` that cannot promise a volume survives past `destroy()`.
 */
export const CLOUD_RUN_RUNTIME_CAPABILITIES: CloudRunRuntimeCapabilities = {
  isolation: 'microvm',
  customImage: true,
  persistentFilesystem: false,
  sessionAffinity: true,
  maxSessionSeconds: 3600,
  networkPolicies: ['none'],
  execCommands: true,
  gpu: false,
  managedByProvider: true,
  typicalStartMs: 3_000,
  fileTransfer: 'push-archive',
};

/**
 * With an `egressProxy` (Terraform `gcp.sandboxInternet: true`) the driver proxies `restricted` and
 * `open` through the shared egress-proxy VM, so it claims `allowlist` too.
 */
export const CLOUD_RUN_PROXIED_RUNTIME_CAPABILITIES: CloudRunRuntimeCapabilities = {
  ...CLOUD_RUN_RUNTIME_CAPABILITIES,
  networkPolicies: ['none', 'allowlist', 'open'],
};

const FILE_INTAKE_TIMEOUT_MS = 30_000;

async function writeServiceFile(
  context: {
    readonly registry: CloudRunServiceRegistry;
    readonly environment: ReturnType<typeof resolveCloudRunOptions>;
    readonly state: ReturnType<typeof createCloudRunState>;
  },
  input: { readonly runtime: RuntimeHandle; readonly name: string; readonly content: string },
): Promise<void> {
  const { registry, environment, state } = context;
  const { fileIntake } = environment;
  const { intakeKeys } = state;
  const { runtime, name, content } = input;

  const known = registry.assertLive(runtime, 'write a file');
  const intakeKey = intakeKeys.get(known.id);
  if (fileIntake === undefined || intakeKey === undefined) {
    throw new Error('cloud-run runtime: this driver was built without fileIntake.');
  }
  const token = await fileIntake.identityToken(known.externalId);
  const response = await fetch(`${known.externalId}/files/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: {
      'x-serverless-authorization': `Bearer ${token}`,
      'x-aw-tool-intake': intakeKey,
      'content-type': 'application/json',
    },
    body: content,
    redirect: 'error',
    signal: AbortSignal.timeout(FILE_INTAKE_TIMEOUT_MS),
  });
  await response.body?.cancel();
  if (response.status !== 204) {
    throw new Error(
      `cloud-run runtime: writing ${name} to the service was refused with HTTP ${String(response.status)}.`,
    );
  }
}

export function createCloudRunDriver<TRequest, TEvent>(
  options: CloudRunDriverOptions<TRequest, TEvent> &
    Readonly<{ fileIntake: NonNullable<CloudRunDriverOptions<TRequest, TEvent>['fileIntake']> }>,
): CloudRunToolDriver<TRequest, TEvent>;
export function createCloudRunDriver<TRequest, TEvent>(
  options: CloudRunDriverOptions<TRequest, TEvent>,
): CloudRunDriver<TRequest, TEvent>;
export function createCloudRunDriver<TRequest, TEvent>(
  options: CloudRunDriverOptions<TRequest, TEvent>,
): CloudRunDriver<TRequest, TEvent> | CloudRunToolDriver<TRequest, TEvent> {
  const environment = resolveCloudRunOptions(options);
  const state = createCloudRunState();
  const registry = new CloudRunServiceRegistry(environment, state);
  const { egressProxy, fileIntake, now, client } = environment;
  const { live, credentialExpiry, intakeKeys } = state;

  const driver: CloudRunDriver<TRequest, TEvent> = {
    id: 'cloud-run-service',
    capabilities:
      egressProxy === undefined
        ? CLOUD_RUN_RUNTIME_CAPABILITIES
        : CLOUD_RUN_PROXIED_RUNTIME_CAPABILITIES,

    async create(
      config: RuntimeConfig,
      _credential?: string,
      tags: Readonly<Record<string, string>> = {},
    ): Promise<RuntimeHandle> {
      return createRuntimeService(config, { environment, registry }, tags);
    },

    async startAgent(runtime, request) {
      return await options.startAgent(registry.assertLive(runtime, 'start an agent'), request);
    },

    async destroy(runtime) {
      const known = registry.assertLive(runtime, 'destroy');
      await client.deleteService(registry.servicePath(known.id));
      live.delete(known.id);
      intakeKeys.delete(known.id);
      credentialExpiry.delete(known.id);
    },

    async isLive(runtime) {
      const known = live.get(runtime.id);
      if (known === undefined || known.externalId !== runtime.externalId) return false;
      const credentialExp = credentialExpiry.get(known.id);
      if (credentialExp !== undefined && credentialExp <= now()) return false;
      const status = await client.getService(registry.servicePath(known.id));
      return status !== null && status.ready;
    },

    writeFile: (runtime, name, content) =>
      writeServiceFile({ environment, state, registry }, { runtime, name, content }),
  };
  // Label lookups only for the tool driver: see `CloudRunToolDriver`.
  return fileIntake === undefined
    ? driver
    : {
        ...driver,
        find: (config) => registry.find(config),
        destroyTagged: (tags) => registry.destroyTagged(tags),
      };
}

export { createCloudRunAdminClient } from './cloud-run-admin.js';
export type {
  CloudRunAgentStarter,
  CloudRunDriver,
  CloudRunDriverOptions,
  CloudRunResourceClient,
  CloudRunRuntimeCapabilities,
  CloudRunServiceSpec,
  CloudRunServiceStatus,
  CloudRunToolDriver,
} from './cloud-run-contract.js';
