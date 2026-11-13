import { log } from '../../telemetry/logger';
import type { DatabaseRoot } from '@agent-workspace/core/db';
import { after } from 'next/server';

import { readRuntimeSettings } from '../../compose/run-request';
import {
  createRunTokenIssuer,
  createUnavailableRunTokenIssuer,
  readGatewayIssuerSettings,
} from '../../gateway/issuer';
import { staleRunAfterMs } from '../../runs/launcher';
import { createRepositoryRunStore } from '../../runs/repository-store';
import type { RunStore } from '../../runs/store';
import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import { hostLaunchOptions, maximumRunDurationMs } from '../config';
import type { AgentsWiring } from './agents';
import type { RunResourcesWiring } from './run-resources';
import { wireRunStartPreflight } from './run-start-preflight';
import type { SubsystemsWiring } from './subsystems';

/**
 * A launch lives in the process that started it, so a replica that dies mid-run leaves the run
 * open. Where runs can launch, fail every run still open past the longest a launch can live, its
 * storage write-back included, and a margin (`../runs/stale-sweep.ts`).
 */
async function startStaleRunSweep(
  root: DatabaseRoot,
  runs: RunStore,
  gatewaySettings: ReturnType<typeof readGatewayIssuerSettings>,
  stopOnClose: (stop: () => void) => void,
): Promise<void> {
  if (!gatewaySettings.ok) return;
  const { startStaleRunSweeper } = await import('../../runs/stale-sweep');
  const stop = startStaleRunSweeper({
    lease: { tryAcquire: (name, ttlMs) => root.tryAcquireMaintenanceLease(name, ttlMs) },
    listStaleRunIds: (before) => root.listStaleRunIds(before),
    listExpiredApprovalRunIds: (before) => root.listExpiredApprovalRunIds(before),
    finish: (runId, status, error, emitStatusEvent) =>
      runs.finish(runId, status, error, emitStatusEvent),
    staleAfterMs: staleRunAfterMs(
      maximumRunDurationMs(process.env, gatewaySettings.settings.ttlSeconds),
    ),
    intervalMs: 60_000,
    onError: (error) => log.error('[compose] stale-run sweep failed', { error }),
  });
  stopOnClose(stop);
}

type RuntimeSettings = ReturnType<typeof readRuntimeSettings>;

/**
 * Whether the run API can be installed. RUNNER_URL configures the in-process "local" driver only
 * (§14.3's one fixed runtime URL). A deployment that instead allocates a runtime per session
 * through the runner manager (RUNNER_MANAGER_URL/RUNNER_MANAGER_TOKEN) has a real runtime with no
 * use for that fixed URL, so its absence is not itself a reason to leave the run API uninstalled -
 * only the absence of *every* runtime is. See docs/adr/ADR-cloud-run-service-driver.md.
 */
function hasLaunchableRuntime(
  runtime: RuntimeSettings,
  runnerManager: SubsystemsWiring['runnerManager'],
): boolean {
  if (runtime.ok) return true;
  log.error(`[compose] "local" runtime driver unavailable: ${runtime.reason}`);
  if (runnerManager !== null) return true;
  // Neither a fixed runtime URL nor a runner manager is configured, so there is truly nothing to
  // relay a run to. The three run routes go on answering 503 by name, which is the true statement
  // about a deployment with no runtime at all.
  log.error(
    '[compose] run API NOT installed: no runtime is configured (neither RUNNER_URL nor ' +
      'RUNNER_MANAGER_URL/RUNNER_MANAGER_TOKEN).',
  );
  return false;
}

/** The run-token issuer, or one that fails closed with the reason launches are disabled. */
function createRunGateway(
  gatewaySettings: ReturnType<typeof readGatewayIssuerSettings>,
  { root, scopes }: Pick<AgentsWiring, 'scopes'> & { readonly root: DatabaseRoot },
) {
  if (!gatewaySettings.ok) {
    log.error(
      `[compose] run launch disabled: ${gatewaySettings.reason} Run lookup and event routes remain installed, but a launch fails closed before the runner is called.`,
    );
    return createUnavailableRunTokenIssuer(gatewaySettings.reason);
  }
  return createRunTokenIssuer(gatewaySettings.settings, async ({ claims, tokenHash }) => {
    const scope = await scopes.forWorkspaceId(claims.workspaceId);
    if (scope === null) throw new Error(`cannot register a token for unknown workspace`);
    await root.runTokens.forScope(scope).register({
      id: claims.tokenId,
      runId: claims.runId,
      tokenHash,
      expiresAt: new Date(claims.expiresAt * 1_000),
    });
  });
}

type RunComposition = Pick<AgentsWiring, 'scopes'> & { readonly root: DatabaseRoot };

/** The repository-backed run store, with the stale-run sweep started where runs can launch. */
async function openRunStore(
  { root, scopes }: RunComposition,
  gatewaySettings: ReturnType<typeof readGatewayIssuerSettings>,
  stopOnClose: (stop: () => void) => void,
): Promise<RunStore> {
  const runs = createRepositoryRunStore({
    repositories: root.runs,
    events: root.runEvents,
    scopes,
    findRunWorkspace: (runId: string): Promise<string | null> => root.findRunWorkspace(runId),
  });
  await startStaleRunSweep(root, runs, gatewaySettings, stopOnClose);
  return runs;
}

/** The runtime driver registry and the profile store over it, or `null` without a registry. */
async function loadRuntimeProfiles({ root, scopes }: RunComposition) {
  const [{ createRepositoryRuntimeProfileStoreProvider }, { currentWebRuntimeRegistry }] =
    await Promise.all([import('../../runtimes/store'), import('../../runtimes/registry')]);
  const driverRegistry = currentWebRuntimeRegistry();
  if (driverRegistry === null) {
    log.error(
      '[compose] run API NOT installed: the runtime driver registry is unavailable, so an agent profile cannot select a launch driver.',
    );
    return null;
  }
  const runtimeProfiles = createRepositoryRuntimeProfileStoreProvider({
    repositories: root.runtimeProfiles,
    scopes,
  });
  return { driverRegistry, runtimeProfiles };
}

/** The run-API wiring, or `null` when no runtime can launch (the run routes then answer 503). */
export async function wireRunRuntime(
  dependencies: Pick<
    AgentsWiring,
    'scopes' | 'sessionRows' | 'agents' | 'deploymentDefaultModels'
  > &
    Pick<SubsystemsWiring, 'modelsApi' | 'runnerManager'> &
    Pick<
      RunResourcesWiring,
      'wave5Repositories' | 'readRunAgent' | 'runFileSizes' | 'pinnedVersionFor'
    > & {
      readonly root: DatabaseRoot;
      readonly policyCeiling: ProjectPolicy | null;
      /** Hand the composition a background driver's stop, so closing it stops the driver. */
      readonly stopOnClose: (stop: () => void) => void;
    },
) {
  const { root, scopes, runnerManager, stopOnClose } = dependencies;
  const runtime = readRuntimeSettings(process.env);
  if (!hasLaunchableRuntime(runtime, runnerManager)) return null;
  const gatewaySettings = readGatewayIssuerSettings(process.env);
  const hostLaunch = hostLaunchOptions(process.env, after);
  const gateway = createRunGateway(gatewaySettings, { root, scopes });

  const runs = await openRunStore({ root, scopes }, gatewaySettings, stopOnClose);
  const registryAndProfiles = await loadRuntimeProfiles({ root, scopes });
  if (registryAndProfiles === null) return null;
  const { driverRegistry, runtimeProfiles } = registryAndProfiles;
  const preflight = wireRunStartPreflight({
    ...dependencies,
    runtimeProfiles,
    workspaceDefault: (workspaceId) => root.getWorkspaceModelDefault(workspaceId),
  });

  return {
    runtime,
    gatewaySettings,
    hostLaunch,
    gateway,
    runs,
    driverRegistry,
    runtimeProfiles,
    ...preflight,
  };
}

export type RunRuntimeWiring = NonNullable<Awaited<ReturnType<typeof wireRunRuntime>>>;
