/** Checks that a run spec and pool configuration fit one fixed, pre-provisioned ACA session pool. */
import type { RuntimeRunSpec } from './driver.js';
import { requireValue } from './aca-sessions-rest-client.js';

export type AcaSessionsNetworkStatus = 'EgressEnabled' | 'EgressDisabled';

export type AcaSessionsPoolConfiguration = Readonly<{
  /** CPU cores configured on customContainerTemplate.containers[].resources. */
  cpu?: number;
  /** Memory configured on the pool, normalized to MiB. */
  memoryMb?: number;
  /** dynamicPoolConfiguration.cooldownPeriodInSeconds. */
  cooldownPeriodInSeconds?: number;
  /** Control-plane id of the registered runtime connection that owns this endpoint. */
  runtimeConnectionId?: string;
}>;

export function assertCompatibleRunSpec(
  spec: RuntimeRunSpec | undefined,
  networkStatus: AcaSessionsNetworkStatus,
  pool: AcaSessionsPoolConfiguration,
): void {
  if (spec === undefined) return;
  if (spec.driver !== 'aca-sessions') {
    throw new Error(`aca-sessions runtime: run spec selects incompatible driver ${spec.driver}.`);
  }
  if (spec.networkPolicy === 'restricted') {
    throw new Error(
      'aca-sessions runtime: restricted network policy and domain allowlists are not supported by a session pool (ADR-0117 decision 7).',
    );
  }
  if (spec.allowedDomains !== undefined && spec.allowedDomains.length > 0) {
    throw new Error(
      'aca-sessions runtime: allowedDomains cannot be enforced by a session pool (ADR-0117 decision 7).',
    );
  }
  if (spec.persistPaths !== undefined && spec.persistPaths.length > 0) {
    throw new Error(
      'aca-sessions runtime: persistPaths cannot be enforced inside an ephemeral dynamic session.',
    );
  }
  if (spec.filesystem !== 'read-write') {
    throw new Error(
      'aca-sessions runtime: read-only filesystem profiles cannot be enforced by a custom session pool.',
    );
  }
  if (spec.diskMb !== undefined) {
    throw new Error(
      'aca-sessions runtime: diskMb cannot be configured or verified for a custom session pool.',
    );
  }
  if (spec.timeoutSeconds !== undefined) {
    throw new Error(
      'aca-sessions runtime: timeoutSeconds is a hard run limit, but ACA exposes only an idle cooldown.',
    );
  }
  if (spec.driverConfig !== undefined && Object.keys(spec.driverConfig).length > 0) {
    throw new Error(
      'aca-sessions runtime: driverConfig contains unsupported per-run ACA settings; pool settings are fixed at deployment.',
    );
  }
  const configuredPolicy = networkStatus === 'EgressEnabled' ? 'open' : 'none';
  if (spec.networkPolicy !== configuredPolicy) {
    throw new Error(
      `aca-sessions runtime: run spec requests ${spec.networkPolicy} network access but the pool is ${networkStatus}.`,
    );
  }
  assertFixedPoolValue('cpu', spec.cpu, pool.cpu);
  assertFixedPoolValue('memoryMb', spec.memoryMb, pool.memoryMb);
  assertFixedPoolValue('idleTimeoutSeconds', spec.idleTimeoutSeconds, pool.cooldownPeriodInSeconds);
  assertFixedPoolValue('runtimeConnectionId', spec.runtimeConnectionId, pool.runtimeConnectionId);
}

function assertFixedPoolValue(
  field: string,
  requested: number | string | undefined,
  configured: number | string | undefined,
): void {
  if (requested === undefined) return;
  if (configured === undefined) {
    throw new Error(
      `aca-sessions runtime: ${field} was requested but the registered pool's fixed value is unknown.`,
    );
  }
  if (requested !== configured) {
    throw new Error(
      `aca-sessions runtime: requested ${field} ${JSON.stringify(requested)} does not match the pool's fixed value ${JSON.stringify(configured)}.`,
    );
  }
}

export function validatePoolConfiguration(pool: AcaSessionsPoolConfiguration): void {
  if (pool.cpu !== undefined && (!Number.isFinite(pool.cpu) || pool.cpu <= 0)) {
    throw new Error('aca-sessions runtime: pool cpu must be a positive finite number.');
  }
  if (pool.memoryMb !== undefined && (!Number.isSafeInteger(pool.memoryMb) || pool.memoryMb <= 0)) {
    throw new Error('aca-sessions runtime: pool memoryMb must be a positive safe integer.');
  }
  if (
    pool.cooldownPeriodInSeconds !== undefined &&
    (!Number.isSafeInteger(pool.cooldownPeriodInSeconds) || pool.cooldownPeriodInSeconds <= 0)
  ) {
    throw new Error(
      'aca-sessions runtime: pool cooldownPeriodInSeconds must be a positive safe integer.',
    );
  }
  if (pool.runtimeConnectionId !== undefined) {
    requireValue(pool.runtimeConnectionId, 'pool runtimeConnectionId');
  }
}

/**
 * Refuse a run whose engine this pool's image does not carry, before an allocation is made.
 *
 * ENG-07's dispatch invariant, in the shape a pool-fixed provider can hold it: the other drivers
 * pick an image from the map, and this one has exactly one image, so the same invariant is the
 * equality below. The sentence names the run's engine and the pool's, and no image reference —
 * this driver has none to name.
 */
export function assertPoolEngine(poolEngine: string, requestedEngine: string): void {
  if (requestedEngine !== poolEngine) {
    throw new Error(
      `aca-sessions runtime: this session pool carries engine ${JSON.stringify(poolEngine)} and a run for ${JSON.stringify(requestedEngine)} cannot be served by it. An ACA dynamic-session pool is provisioned with one container image, so one pool offers one engine; provision a second pool for the other engine (ADR-0073 D6).`,
    );
  }
}
