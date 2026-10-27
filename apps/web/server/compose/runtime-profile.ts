import type {
  RuntimeCapabilities,
  RuntimeDriverId,
  RuntimeRunSpec,
} from '@agent-workspace/runtime/driver';
import { networkPolicyFloor } from '@indx-workspace/contracts/policy-ceiling';

import type { AgentRecord } from '../agents/contract';
import { restrictedUnenforceableReason } from '../runtimes/network-policy';
import type { RuntimeRegistryEntry, WebRuntimeRegistry } from '../runtimes/registry';
import type { RuntimeProfileRecord, RuntimeProfileStoreProvider } from '../runtimes/store';
import type { LaunchContext } from '../runs/environment';
import { missingRuntimeProfile, runStartRefusalError } from './run-preflight';
import type { RuntimeSettings } from './run-request';

/** How the run's files reach the target: the driver's `RuntimeCapabilities.fileTransfer`. */
export type FileTransfer = RuntimeCapabilities['fileTransfer'];

export type RuntimeLaunchTarget = RuntimeRunSpec &
  Readonly<{
    runnerUrl: string;
    workspaceRoot: string;
    toolSandboxOrigin?: string;
    fileTransfer: FileTransfer;
  }>;

export type RuntimeDriverTarget = Readonly<{
  driver: RuntimeDriverId;
  runnerUrl: string;
  workspaceRoot: string;
  /** The driver's declared `fileTransfer`; the launcher hydrates by it, never by the driver id. */
  fileTransfer: FileTransfer;
  /** Allocate/resolve a session-affine runtime instead of using the legacy fixed URL. */
  allocate?: (
    context: LaunchContext,
    spec: RuntimeRunSpec,
  ) => Promise<Readonly<{ runnerUrl: string; workspaceRoot?: string; toolSandboxOrigin?: string }>>;
  /** Return a reason when this concrete target cannot enforce the selected constraints. */
  validate?: (spec: RuntimeRunSpec) => string | null;
}>;

export interface RuntimeRunResolver {
  resolve(context: LaunchContext): Promise<RuntimeLaunchTarget>;
}

/**
 * Refuse a driver that cannot run this profile now. An enabled driver whose Test Runtime pass has
 * lapsed — it lasts 24 hours, and an image upgrade changes what it approved — is re-verified once
 * when it has passed here before; otherwise, or when that fails, the run is refused with
 * `runtime_not_verified` and the fix, never an opaque preparation failure (BH061-002).
 */
async function assertAvailable(
  profile: RuntimeProfileRecord,
  registry: WebRuntimeRegistry,
  workspaceId: string,
): Promise<void> {
  const entry = (await registry.list(workspaceId)).find(
    (candidate: RuntimeRegistryEntry) => candidate.id === profile.driver,
  );
  if (entry === undefined) {
    throw new Error(
      `runtime profile ${profile.id} selects unsupported driver ${profile.driver}; refusing to launch`,
    );
  }
  if (entry.state !== 'enabled') {
    throw new Error(
      `runtime profile ${profile.id} selects unavailable driver ${profile.driver}: ` +
        (entry.reason ?? 'the runtime is disabled'),
    );
  }
  if (entry.testPassed) return;
  const scope = {
    workspaceId,
    ...(profile.runtimeConnectionId === null
      ? {}
      : { runtimeConnectionId: profile.runtimeConnectionId }),
  };
  if ((await registry.renew?.(profile.driver, scope)) === true) return;
  throw runStartRefusalError({
    code: 'runtime_not_verified',
    message:
      `Test Runtime has no current pass for the ${profile.driver} runtime: it never passed, or ` +
      'its pass expired (a pass lasts 24 hours) or the runtime image changed and re-verifying ' +
      'it failed; run Test Runtime on the Runtimes page (POST /api/runtimes/test), then retry',
  });
}

function resolvedSpec(profile: RuntimeProfileRecord): RuntimeRunSpec {
  if (
    profile.networkPolicy !== 'none' &&
    profile.networkPolicy !== 'restricted' &&
    profile.networkPolicy !== 'open'
  ) {
    throw new Error(`runtime profile ${profile.id} has invalid network policy`);
  }
  if (profile.filesystem !== 'read-only' && profile.filesystem !== 'read-write') {
    throw new Error(`runtime profile ${profile.id} has invalid filesystem mode`);
  }
  return {
    runtimeProfileId: profile.id,
    driver: profile.driver as RuntimeDriverId,
    ...(profile.runtimeConnectionId === null
      ? {}
      : { runtimeConnectionId: profile.runtimeConnectionId }),
    ...(profile.cpu === null ? {} : { cpu: profile.cpu }),
    ...(profile.memoryMb === null ? {} : { memoryMb: profile.memoryMb }),
    ...(profile.diskMb === null ? {} : { diskMb: profile.diskMb }),
    networkPolicy: profile.networkPolicy,
    ...(profile.allowedDomains === null ? {} : { allowedDomains: [...profile.allowedDomains] }),
    filesystem: profile.filesystem,
    ...(profile.persistPaths === null ? {} : { persistPaths: [...profile.persistPaths] }),
    ...(profile.timeoutSeconds === null ? {} : { timeoutSeconds: profile.timeoutSeconds }),
    ...(profile.idleTimeoutSeconds === null
      ? {}
      : { idleTimeoutSeconds: profile.idleTimeoutSeconds }),
    ...(profile.driverConfig === null ? {} : { driverConfig: { ...profile.driverConfig } }),
  };
}

/** The in-process HTTP runner cannot enforce container resource or isolation controls. */
export function localRuntimeRunSpecRejection(spec: RuntimeRunSpec): string | null {
  const unsupported: string[] = [];
  if (spec.cpu !== undefined) unsupported.push('cpu');
  if (spec.memoryMb !== undefined) unsupported.push('memoryMb');
  if (spec.diskMb !== undefined) unsupported.push('diskMb');
  if (spec.networkPolicy !== 'open') unsupported.push(`networkPolicy=${spec.networkPolicy}`);
  if (spec.allowedDomains !== undefined && spec.allowedDomains.length > 0)
    unsupported.push('allowedDomains');
  if (spec.filesystem !== 'read-write') unsupported.push(`filesystem=${spec.filesystem}`);
  if (spec.driverConfig !== undefined && Object.keys(spec.driverConfig).length > 0)
    unsupported.push('driverConfig');
  return unsupported.length === 0
    ? null
    : `the local runner cannot enforce ${unsupported.join(', ')}`;
}

/** Resolve the agent's persisted profile into the exact driver target and constraints for a run. */
export function createRuntimeRunResolver(
  options: Readonly<{
    /**
     * The run's agent configuration, whose runtime profile is the one launched: the session's
     * pinned version's, or the row's for a legacy session (issue #612). `null` when it is gone.
     */
    agentFor: (context: LaunchContext) => Promise<AgentRecord | null>;
    profiles: RuntimeProfileStoreProvider;
    registry: WebRuntimeRegistry;
    targets: readonly RuntimeDriverTarget[];
    /** The run's met `unrestrictedNetwork` switch and remote connector hosts (ADR-0117, #785). */
    networkGrantFor: (
      context: LaunchContext,
    ) => Promise<Readonly<{ unrestrictedNetwork: boolean; connectorHosts: readonly string[] }>>;
    /** `AGENT_WORKSPACE_EGRESS_PROXY_IMAGE` is set, so docker/kubernetes enforce `restricted`. */
    egressProxyConfigured: boolean;
    /** Told when an `open` profile was lowered, so an operator can see why the run has no internet. */
    onNetworkLowered?: (
      context: LaunchContext,
      lowered: Readonly<{ applied: 'restricted' | 'none'; allowedDomains: readonly string[] }>,
    ) => void;
  }>,
): RuntimeRunResolver {
  const targets = new Map(options.targets.map((target) => [target.driver, target]));
  return {
    async resolve(context) {
      const workspaceId = context.principal.workspaceId;
      const agent = await options.agentFor(context);
      if (agent === null) {
        throw new Error(`agent ${context.agent.id} is unavailable in workspace ${workspaceId}`);
      }
      // Issue #393: the same refusal `runs.start` answers before queueing, thrown here for a
      // profile removed between the start and the launch, so the run's error carries its code.
      const profile =
        agent.runtimeProfileId === null
          ? null
          : await options.profiles.forWorkspace(workspaceId).get(agent.runtimeProfileId);
      if (profile === null) throw runStartRefusalError(missingRuntimeProfile(agent));
      await assertAvailable(profile, options.registry, workspaceId);
      const target = targets.get(profile.driver as RuntimeDriverId);
      if (target === undefined) {
        throw new Error(
          `runtime profile ${profile.id} selects driver ${profile.driver}, but no launch target is configured`,
        );
      }
      // ADR-0117 decision 9: `local` can enforce no network policy (decision 7), so it is exempt.
      // Every other driver gets the lowered policy before `validate` and `allocate`; one that cannot
      // enforce it refuses the run, never falls back to `open`. `restricted` is refused here with
      // its own code when the driver or the deployment has no egress proxy (ADR-0117 decision 7).
      let floored = profile;
      if (profile.networkPolicy === 'open' && profile.driver !== 'local') {
        const floor = networkPolicyFloor({
          networkPolicy: profile.networkPolicy,
          ...(await options.networkGrantFor(context)),
        });
        if (floor.lowered) {
          const allowedDomains = floor.allowedDomains ?? [];
          const unenforceable =
            floor.networkPolicy === 'restricted'
              ? restrictedUnenforceableReason(profile.driver, options.egressProxyConfigured)
              : null;
          if (unenforceable !== null) {
            throw runStartRefusalError({
              code: 'network_policy_unenforceable',
              message:
                `open lowered to restricted (${allowedDomains.join(', ')}) because the agent ` +
                `lacks unrestrictedNetwork; ${profile.driver} ${unenforceable}; ` +
                'grant unrestrictedNetwork or remove remote connectors',
            });
          }
          floored = {
            ...profile,
            networkPolicy: floor.networkPolicy,
            allowedDomains: allowedDomains.length === 0 ? null : [...allowedDomains],
          };
          options.onNetworkLowered?.(context, {
            applied: floor.networkPolicy === 'none' ? 'none' : 'restricted',
            allowedDomains,
          });
        }
      }
      const spec = resolvedSpec(floored);
      const rejection = target.validate?.(spec) ?? null;
      if (rejection !== null) {
        throw new Error(
          `runtime profile ${profile.id} cannot run on driver ${profile.driver}: ${rejection}`,
        );
      }
      const allocation = await target.allocate?.(context, spec);
      return {
        ...spec,
        runnerUrl: allocation?.runnerUrl ?? target.runnerUrl,
        workspaceRoot: allocation?.workspaceRoot ?? target.workspaceRoot,
        fileTransfer: target.fileTransfer,
        ...(allocation?.toolSandboxOrigin === undefined
          ? {}
          : { toolSandboxOrigin: allocation.toolSandboxOrigin }),
      };
    },
  };
}

export function runtimeSettingsFor(target: RuntimeLaunchTarget): RuntimeSettings {
  return {
    runnerUrl: target.runnerUrl,
    workspaceRoot: target.workspaceRoot,
    ...(target.toolSandboxOrigin === undefined ? {} : { toolSandbox: true }),
  };
}
