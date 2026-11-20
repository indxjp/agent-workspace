import { createHash } from 'node:crypto';
import { log } from '../telemetry/logger';

import { DEPLOYMENT_POSTURE_ENV, readDeploymentPosture } from '@agent-workspace/core/posture';
import type { RuntimeDriverId } from '@agent-workspace/run-protocol';
import type { RuntimeRunSpec } from '@agent-workspace/runtime/driver';

import type { RuntimeManagerClient } from '../compose/runtime-manager-client';
import type { ProviderCredentialSpec } from '../compose/runtime-provider-credential';
import { registeredEngines } from '../engines/registry';
import { egressProxyConfiguredFromEnv } from '../runtimes/network-policy';
import {
  configuredPath,
  enforceableRuntimeNetworkPolicies,
  runnerManagerDriverId,
  runtimeNetworkPolicyRefusal,
} from './config';
import {
  createRuntimeVerificationRegistry,
  type SharedRuntimeVerifications,
} from './runtime-verification';

export function runnerManagerDriverLabel(driverId: RuntimeDriverId): string {
  const labels: Partial<Record<RuntimeDriverId, string>> = {
    docker: 'Docker',
    'cloud-run-service': 'Google Cloud Run (per-session service)',
    'aca-sessions': 'Azure Container Apps dynamic sessions',
  };
  return labels[driverId] ?? driverId;
}

type UnavailableRuntimeEntry = readonly [RuntimeDriverId, string, false, false];

/**
 * Static registry rows, excluding the driver represented by the live runner-manager row. `local`,
 * `docker`, `cloud-run-service` and `cloudflare-sandbox` have no static row here; the pin in
 * `runtimes/driver-catalogue.test.ts` records that.
 */
export function unavailableRuntimeRegistryEntries(
  managedDriverId: RuntimeDriverId,
): readonly UnavailableRuntimeEntry[] {
  const entries: readonly UnavailableRuntimeEntry[] = [
    ['sandbox-runtime', 'Sandboxed process', false, false],
    ['aca-sessions', 'Azure Container Apps dynamic sessions', false, false],
    ['aws-agentcore', 'Amazon Bedrock AgentCore Runtime', false, false],
    ['aws-ecs', 'Amazon ECS on Fargate', false, false],
    ['cloud-run-sandbox', 'Google Cloud Run sandboxes', false, false],
    ['gke-agent-sandbox', 'GKE Agent Sandbox', false, false],
    ['external', 'External provider', false, false],
    ['vercel-sandbox', 'Vercel Sandbox', false, false],
    ['kubernetes', 'Kubernetes', false, false],
  ];
  return entries.filter(([id]) => id !== managedDriverId);
}

/** What the registry needs to know about the one driver the runner manager is configured with. */
interface ManagedDriver {
  readonly id: RuntimeDriverId;
  readonly label: string;
  readonly runnerManager: RuntimeManagerClient | null;
  readonly verificationNetworkPolicy: RuntimeRunSpec['networkPolicy'];
}

const DEFAULT_RUNTIME_IMAGE = 'agent-workspace/runtime:dev';

function verificationCachePath(posture: ReturnType<typeof readDeploymentPosture>): string {
  return (
    configuredPath('AW_RUNTIME_VERIFICATION_FILE') ??
    (posture === 'production'
      ? '/var/lib/agent-workspace/runtime-verifications.json'
      : '.agent-workspace/runtime-verifications.json')
  );
}

/**
 * Only an explicit `AW_DEPLOYMENT_POSTURE=local` (what the local runtime `aw dev` starts sets)
 * has had HOST checked against loopback (`checkDeploymentPosture`). There, and only there, the
 * in-process driver counts as verified without the one-hour verification only the Runtimes
 * screen or the setup wizard records, which `aw dev` never visits: its Test Runtime is an echo
 * that cannot fail. The implicit `local` posture (no variable, `NODE_ENV` not `production`)
 * checked no HOST, so it keeps needing a Test Runtime like every other posture and driver.
 */
function isVerifiedWithoutTest(inProcessLocalDriver: boolean): boolean {
  return inProcessLocalDriver && (process.env[DEPLOYMENT_POSTURE_ENV] ?? '').trim().length > 0;
}

function buildConfigurationKeys(
  managed: ManagedDriver,
  inProcessLocalDriver: boolean,
  fingerprintInputs: { readonly image: string; readonly runnerManagerUrl: string | null },
): Map<string, string> {
  const configurationKeys = new Map<string, string>([['local', 'development-local']]);
  if (!(inProcessLocalDriver && managed.id === 'local')) {
    configurationKeys.set(
      managed.id,
      createHash('sha256')
        .update(
          JSON.stringify({
            image: fingerprintInputs.image,
            runnerManagerUrl: fingerprintInputs.runnerManagerUrl,
            verificationNetworkPolicy: managed.verificationNetworkPolicy,
          }),
        )
        .digest('hex'),
    );
  }
  return configurationKeys;
}

function buildRegistryEntries(managed: ManagedDriver, posture: string) {
  // `RUNTIME_IMAGE` is read by the caller only for the fingerprint used by `configurationKeys`;
  // whether the *managed* driver's image is actually ready is the runner manager's own concern, not
  // this process's — it validates its own digest at driver construction (`requireDigest` in
  // apps/runner/src/manager-start.ts) and again on every `/verify` round-trip. A deployment where
  // the manager runs as a separate Cloud Run service (unlike a docker-compose setup where both
  // processes share one `.env`) never sets `RUNTIME_IMAGE` on the web container at all, so gating
  // this on a local regex match here always read "not reachable" and made the driver unselectable
  // no matter how healthy the manager was.
  const managedImageReady = managed.runnerManager !== null;
  return [
    ['local', 'This machine (development only)', posture === 'local', posture === 'local'],
    [managed.id, managed.label, managed.runnerManager !== null, managedImageReady],
    ...unavailableRuntimeRegistryEntries(managed.id),
  ].map(([id, label, connectionExists, imageReachable]) => {
    const refusal = runtimeNetworkPolicyRefusal(String(id));
    return {
      id: String(id),
      label: String(label),
      connectionExists: connectionExists === true,
      imageReachable: imageReachable === true,
      // Only the managed row can report a pool-fixed policy: it is the one driver this process
      // knows the deployment's own configuration for. The rest stay unrestricted, and the
      // fingerprint in `configurationKeys` deliberately does not see this field — an entry that
      // merely reports what the pool already enforces must not invalidate a verification approval.
      // With no runner manager the policy was never read from the environment, and the row is
      // already `connectionExists: false`, so it reports no restriction rather than a fallback.
      networkPolicies:
        String(id) === managed.id && managed.runnerManager !== null
          ? enforceableRuntimeNetworkPolicies(
              managed.id,
              managed.verificationNetworkPolicy,
              egressProxyConfiguredFromEnv(process.env),
            )
          : null,
      // ADR-0131: shown on the Runtimes screen; the driver still refuses every run itself.
      ...(refusal === null ? {} : { refusal }),
    };
  });
}

function runtimeTestConfig(driverId: string) {
  return {
    sessionId: crypto.randomUUID(),
    // ENG-07 (#306): a `Test Runtime` probe says which engine's image it is probing, and it
    // must be one this deployment offers: the catalogue's first engine need not have an image.
    // The probe takes the first *installed* engine; a deployment offering a second verifies it
    // by probing again with that engine, which the Runtimes page will ask for once it offers
    // the choice. A deployment offering none sends an empty engine, which the manager refuses.
    engine: registeredEngines().find((candidate) => candidate.installed)?.id ?? '',
    workspacePath: `/tmp/agent-workspace-runtime-tests/${driverId}/${crypto.randomUUID()}`,
  };
}

/** Install the live registry used by the Runtimes page and its Test Runtime endpoint. */
export async function installDriverRegistry(
  runnerManager: RuntimeManagerClient | null,
  runnerManagerUrl: string | null,
  verificationNetworkPolicy: RuntimeRunSpec['networkPolicy'],
  resolveProviderCredential?: (
    workspaceId: string,
    spec: ProviderCredentialSpec,
  ) => Promise<string | undefined>,
  sharedVerifications?: SharedRuntimeVerifications,
): Promise<void> {
  // Read before the try block (contract C2): an invalid posture or RUNTIME_DRIVER must fail
  // composition, not be logged as "registry NOT installed" and leave the process running.
  const posture = readDeploymentPosture(process.env);
  // The managed driver is whichever driver the runner manager itself is configured with (see
  // {@link runnerManagerDriverId}) — `'docker'` unless RUNTIME_DRIVER says otherwise, so an
  // existing compose deployment sees the same row it always has.
  const managedDriverId = runnerManagerDriverId(process.env);
  const managed: ManagedDriver = {
    id: managedDriverId,
    label: runnerManagerDriverLabel(managedDriverId),
    runnerManager,
    verificationNetworkPolicy,
  };
  try {
    const registryModule = await import('../runtimes/registry');
    // The web process never owns the runner manager's own lifecycle machinery (a Docker socket, a
    // Cloud Run Admin API client, …). That capability belongs to the runner manager; until it
    // positively reports the capability, the UI keeps this driver visible and unavailable. Most
    // importantly, the runner manager being unreachable cannot prevent the independent local
    // driver from registering.
    const image = configuredPath('RUNTIME_IMAGE') ?? DEFAULT_RUNTIME_IMAGE;
    const { loadRuntimeVerificationCache } = await import('../runtimes/verification-store');
    const verified = await loadRuntimeVerificationCache(verificationCachePath(posture));
    // S1-22 (issue #504, ADR-0109 as amended): under posture `local` the `local` driver is the
    // in-process runner. `aw dev` starts with `RUNTIME_DRIVER=local`, which makes the managed
    // driver `local` too; under posture `local` that entry must not replace the in-process driver's
    // key or take over its Test Runtime.
    const inProcessLocalDriver = posture === 'local';
    const registry = createRuntimeVerificationRegistry({
      managedDriverId,
      inProcessLocalDriver,
      verifiedWithoutTest: isVerifiedWithoutTest(inProcessLocalDriver),
      runnerManager,
      configurationKeys: buildConfigurationKeys(managed, inProcessLocalDriver, {
        image,
        runnerManagerUrl,
      }),
      verified,
      sharedVerifications,
      resolveProviderCredential,
    });
    registryModule.configureWebRuntimeRegistry(
      registryModule.createWebRuntimeRegistry({
        registry,
        entries: buildRegistryEntries(managed, posture),
        configFor: runtimeTestConfig,
        requestForEcho: String,
        renderEvent: String,
      }),
    );
    log.info(
      `[compose] runtime registry installed: local is development-only; ${managed.label} uses runner-manager create/readiness/echo/destroy verification (${image})`,
    );
  } catch (error) {
    log.error('[compose] runtime registry NOT installed', { error });
  }
}
