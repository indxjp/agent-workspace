import {
  ACA_SESSIONS_MANAGEMENT_API_VERSION,
  createAcaSessionsDriver,
  createAcaSessionsRestClient,
  fetchAcaSessionsAccessToken,
} from '@agent-workspace/runtime/driver/aca-sessions';
import type { DriverOptions } from './manager-driver-settings.js';
import {
  noAgentStart,
  optionalDriverSetting,
  requiredDriverSetting,
} from './manager-driver-settings.js';

export function acaSessionsNetworkStatus(
  env: Readonly<Record<string, string | undefined>>,
): 'EgressEnabled' | 'EgressDisabled' {
  const value = env['ACA_SESSION_POOL_NETWORK_STATUS'] ?? 'EgressDisabled';
  if (value === 'EgressEnabled' || value === 'EgressDisabled') return value;
  throw new Error('ACA_SESSION_POOL_NETWORK_STATUS must be EgressEnabled or EgressDisabled');
}

/**
 * `RUNTIME_DRIVER=aca-sessions` routes the runtime contract through one pre-provisioned custom
 * container dynamic-session pool. The pool, rather than this process, owns image selection,
 * Hyper-V isolation, network mode, scale-to-zero, and session expiry.
 *
 * Two provider limitations are intentionally visible here. ACA network policy is a pool-wide
 * all-or-nothing setting, so one manager cannot promise both `none` and `open` profiles. Timed
 * sessions also expose an idle cooldown but no documented hard maximum lifetime, which is why the
 * driver reports `maxSessionSeconds: null`; application run timeouts remain the hard bound.
 *
 * The manager's allocation registry is process-local. Azure deployments must cap it at one active
 * replica, and a replica replacement invalidates manager URLs already returned to callers even
 * though ACA may keep those sessions alive until their idle timeout. The stable HMAC identifier
 * derived from `RUNNER_MANAGER_TOKEN` prevents tenant/session names from entering Azure routing
 * and lets a subsequent allocation request find the same provider session, but it is not a
 * substitute for a durable allocation registry.
 */
export function acaSessionsDriverOptions(
  env: Readonly<Record<string, string | undefined>>,
): DriverOptions {
  const poolManagementEndpoint = requiredDriverSetting(
    env,
    'ACA_SESSION_POOL_ENDPOINT',
    'aca-sessions',
  );
  const apiVersion =
    optionalDriverSetting(env, 'ACA_SESSION_POOL_API_VERSION', 'aca-sessions') ??
    optionalDriverSetting(env, 'ACA_SESSION_API_VERSION', 'aca-sessions') ??
    ACA_SESSIONS_MANAGEMENT_API_VERSION;
  const networkStatus = acaSessionsNetworkStatus(env);
  const identifierSecret = env['RUNNER_MANAGER_TOKEN'] ?? '';
  // ENG-07: one ACA session pool is provisioned with one container image, so it offers exactly one
  // engine and a run for any other is refused before an allocation is made (ADR-0073 D6). The pool's
  // engine is configured rather than inferred: nothing in the management API reports which adapter
  // the pool's image carries. The default is spelled out, not taken from the adapter list, so adding
  // an adapter whose id sorts first cannot silently change what an existing pool claims to carry.
  const engine = env['ACA_SESSION_POOL_ENGINE'] ?? 'claude-agent-sdk';
  let client: ReturnType<typeof createAcaSessionsRestClient>;
  try {
    client = createAcaSessionsRestClient({
      poolManagementEndpoint,
      apiVersion,
      getAccessToken: fetchAcaSessionsAccessToken,
    });
  } catch (error) {
    // The runtime calls it `poolManagementEndpoint`; the operator set ACA_SESSION_POOL_ENDPOINT.
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`runner manager: ACA_SESSION_POOL_ENDPOINT is refused. ${reason}`, {
      cause: error,
    });
  }
  const driver = createAcaSessionsDriver<never, never>({
    poolManagementEndpoint,
    networkStatus,
    engine,
    identifierSecret,
    client,
    startAgent: noAgentStart,
  });
  return {
    driver,
    expectedDriver: 'aca-sessions',
    runtimeRequestUrl: (handle, requestPath) => driver.requestUrl(handle, requestPath),
    runtimeAuthHeaders: async () => ({
      authorization: `Bearer ${await fetchAcaSessionsAccessToken()}`,
    }),
    configurationFingerprint: `aca-sessions:${poolManagementEndpoint}:${apiVersion}:${networkStatus}:${engine}`,
    readinessPath: '/ping',
  };
}
