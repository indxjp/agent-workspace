import type { RuntimeNetworkPolicy } from '../../contracts/runtimes';

export type RuntimeRegistryEntry = Readonly<{
  id: string;
  label: string;
  connectionExists: boolean;
  imageReachable: boolean;
  testPassed: boolean;
  state: 'enabled' | 'disabled';
  reason: string | null;
  /**
   * The §15.2 policies this deployment can enforce for the driver, or `null` when it can enforce
   * all of them. A managed pool that fixes egress at creation reports exactly the policy it was
   * created with, so the Runtimes screen drafts a runnable profile and `/api/runtime-profiles`
   * refuses one the pool could never honour.
   */
  networkPolicies: readonly RuntimeNetworkPolicy[] | null;
  /** Why the driver refuses every run here (ADR-0131), when it declares no network policy. */
  refusal?: string;
}>;

export type RuntimeTestTranscript = Readonly<{
  driverId: string;
  transcript: readonly string[];
  destroyed: boolean;
}>;

/**
 * Who is testing, and with which runtime connection's provider key (ADR-0120 LC6).
 * `providerCredential` is a key not yet stored as a connection (first-run setup tests before it
 * writes anything). It is server-only: no HTTP route may copy a request field into it.
 */
export type RuntimeTestScope = Readonly<{
  workspaceId: string;
  runtimeConnectionId?: string;
  providerCredential?: string;
}>;

export interface WebRuntimeRegistry {
  /** `workspaceId` lets a driver count as tested by a pass this workspace recorded elsewhere. */
  list(workspaceId?: string): Promise<readonly RuntimeRegistryEntry[]>;
  test(driverId: string, echo: string, scope?: RuntimeTestScope): Promise<RuntimeTestTranscript>;
  /**
   * Run Test Runtime again for a driver whose pass lapsed (it expired, or the runtime image
   * changed) and resolve whether it passed. Only a driver this workspace has passed before is
   * re-verified, so a run never stands in for an operator's first Test Runtime (BH061-002).
   */
  renew?(driverId: string, scope: RuntimeTestScope): Promise<boolean>;
}

export type RuntimeProbeConfig = Readonly<{
  sessionId: string;
  workspacePath: string;
  /** ENG-07 (#306): `engine` selects which engine's runtime image the probe starts. */
  engine: string;
}> &
  Partial<RuntimeTestScope>;

type RuntimeHandleShape = Readonly<{ id: string }>;

export interface TestableDriverRegistry<TRequest, TEvent> {
  wasVerified(driverId: string, workspaceId?: string): boolean | Promise<boolean>;
  /** A pass was ever recorded for the driver, current or not; see {@link WebRuntimeRegistry.renew}. */
  hasPassed?(driverId: string, workspaceId: string): boolean | Promise<boolean>;
  test(
    driverId: string,
    config: RuntimeProbeConfig,
    request: TRequest,
    renderEvent: (event: TEvent) => string,
  ): Promise<
    Readonly<{
      driverId: string;
      handle: RuntimeHandleShape;
      transcript: readonly string[];
      destroyed: true;
    }>
  >;
}

export type RuntimeRegistrySeed = Readonly<{
  id: string;
  label: string;
  connectionExists: boolean;
  imageReachable: boolean;
  /** Absent means "this driver is not restricted here"; see {@link RuntimeRegistryEntry}. */
  networkPolicies?: readonly RuntimeNetworkPolicy[] | null;
  refusal?: string;
}>;

export function createWebRuntimeRegistry<TRequest, TEvent>(
  options: Readonly<{
    registry: TestableDriverRegistry<TRequest, TEvent>;
    entries: readonly RuntimeRegistrySeed[];
    configFor(
      driverId: string,
    ): Readonly<{ sessionId: string; workspacePath: string; engine: string }>;
    requestForEcho(echo: string): TRequest;
    renderEvent(event: TEvent): string;
  }>,
): WebRuntimeRegistry {
  const entry = async (
    seed: RuntimeRegistrySeed,
    workspaceId: string | undefined,
  ): Promise<RuntimeRegistryEntry> => {
    const testPassed = await options.registry.wasVerified(seed.id, workspaceId);
    const reasons = [
      ...(seed.connectionExists ? [] : ['No runtime connection is configured.']),
      ...(seed.imageReachable ? [] : ['The runtime image is not reachable.']),
    ];
    return {
      ...seed,
      networkPolicies: seed.networkPolicies ?? null,
      testPassed,
      state: reasons.length === 0 ? 'enabled' : 'disabled',
      reason: reasons.length === 0 ? null : reasons.join(' '),
    };
  };
  const test = async (driverId: string, echo: string, scope?: RuntimeTestScope) => {
    const result = await options.registry.test(
      driverId,
      { ...options.configFor(driverId), ...scope },
      options.requestForEcho(echo),
      options.renderEvent,
    );
    return {
      driverId: result.driverId,
      transcript: result.transcript,
      destroyed: result.destroyed,
    };
  };
  // Runs that start together share one re-verification instead of each probing the driver.
  const renewals = new Map<string, Promise<boolean>>();
  const renew = async (driverId: string, scope: RuntimeTestScope): Promise<boolean> => {
    if (!(await options.registry.hasPassed?.(driverId, scope.workspaceId))) return false;
    try {
      await test(driverId, 'agent-workspace runtime re-verification', scope);
      return true;
    } catch (error) {
      console.error(
        `[runtimes] re-verifying ${driverId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  };
  return {
    list: (workspaceId) => Promise.all(options.entries.map((seed) => entry(seed, workspaceId))),
    test,
    renew(driverId, scope) {
      const key = `${scope.workspaceId}:${driverId}`;
      const pending = renewals.get(key);
      if (pending !== undefined) return pending;
      const renewal = renew(driverId, scope).finally(() => renewals.delete(key));
      renewals.set(key, renewal);
      return renewal;
    },
  };
}

interface GlobalRegistry {
  __agentWorkspaceDriverRegistry__?: WebRuntimeRegistry;
}

const globalRegistry = globalThis as typeof globalThis & GlobalRegistry;

export function configureWebRuntimeRegistry(registry: WebRuntimeRegistry): void {
  globalRegistry.__agentWorkspaceDriverRegistry__ = registry;
}

export function clearWebRuntimeRegistry(): void {
  delete globalRegistry.__agentWorkspaceDriverRegistry__;
}

export function currentWebRuntimeRegistry(): WebRuntimeRegistry | null {
  return globalRegistry.__agentWorkspaceDriverRegistry__ ?? null;
}

/**
 * What the runtime-profile routes ask before accepting a `networkPolicy`. `null` means the driver
 * advertises no restriction, which is every driver but a managed pool with fixed egress.
 */
export type RuntimeNetworkPolicyLookup = (
  driver: string,
) => Promise<readonly RuntimeNetworkPolicy[] | null>;

/**
 * The installed registry's answer for one driver. A deployment with no registry installed — the
 * unconfigured case the routes already answer 503 for elsewhere — restricts nothing.
 */
export const enforceableNetworkPoliciesFromRegistry: RuntimeNetworkPolicyLookup = async (
  driver,
) => {
  const registry = currentWebRuntimeRegistry();
  if (registry === null) return null;
  const entries = await registry.list();
  return entries.find((entry) => entry.id === driver)?.networkPolicies ?? null;
};
