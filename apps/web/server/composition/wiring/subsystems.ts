import { log } from '../../telemetry/logger';
import type { DatabaseRoot } from '@agent-workspace/core/db';
import type { SecretsService } from '@agent-workspace/core/secrets';
import type { RuntimeRunSpec } from '@agent-workspace/runtime/driver';
import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';

import {
  createRuntimeManagerClient,
  probeRuntimeManager,
  type RuntimeManagerClient,
} from '../../compose/runtime-manager-client';
import { createProviderCredentialResolver } from '../../compose/runtime-provider-credential';
import {
  configureSetupRuntimeDetection,
  setupRuntimeDetectionInputs,
} from '../../setup/runtime-detection';
import { configuredPath, runnerManagerDriverId, runtimeVerificationNetworkPolicy } from '../config';
import {
  installConnectorsApi,
  installDriverRegistry,
  installEndpointClientsApi,
  installModelsApi,
  installOAuthApi,
  installRuntimesApi,
  installSecretsApi,
  installStorageConnectionsApi,
} from '../services';
import { installSessionTranscripts } from '../session-rbac';
import { installSetupApi } from '../setup';
import { installFilesApi, installSkillsApi } from '../storage';
import type { AgentsWiring } from './agents';

export async function wireSubsystems({
  root,
  scopes,
  resolveWorkspace,
  identifyAuditActor,
  resourceCatalog,
  policyCeiling,
  captureSecretsService,
  stopOnClose,
}: Pick<AgentsWiring, 'scopes' | 'resolveWorkspace' | 'identifyAuditActor' | 'resourceCatalog'> & {
  readonly root: DatabaseRoot;
  readonly policyCeiling: ProjectPolicy | null;
  readonly captureSecretsService: (service: SecretsService | null) => void;
  /** Hand the composition a background driver's stop, so closing it stops the driver. */
  readonly stopOnClose: (stop: () => void) => void;
}) {
  // ── The sub-wave 2b-1 subsystems (ADR-0038) ──────────────────────────────────────────────────
  //
  // Four tracks each shipped a runtime seam and an ADR naming the exact call that installs it, and
  // none of them owned this file, so in a deployment built from their four branches every
  // /api/secrets/**, /api/files*, RBAC and session route answered 503. These are those calls.
  //
  // Each is installed independently and each is skipped for a *named* reason, never silently: a
  // subsystem whose configuration is absent leaves its own seam uninstalled and its own routes on
  // the 503 that says so by name. That is the same rule the run API above follows, and it is why
  // the RBAC block below installs nothing at all.
  const { secrets, secretsService } = await installSecretsApi(
    resolveWorkspace,
    scopes,
    root.storageConnections,
  );
  captureSecretsService(secretsService);
  const { models, modelsApi } = await installModelsApi(
    resolveWorkspace,
    identifyAuditActor,
    root,
    secretsService,
  );
  const connectors = await installConnectorsApi(
    resolveWorkspace,
    identifyAuditActor,
    root,
    secretsService,
  );
  const endpointClients = installEndpointClientsApi(root);
  const storageConnections = installStorageConnectionsApi(root, secretsService);
  const oauth = installOAuthApi(root);
  const { runtimes, runtimeSwitchAudit } = await installRuntimesApi(
    resolveWorkspace,
    identifyAuditActor,
    root,
    secretsService,
  );
  const runnerManagerUrl = configuredPath('RUNNER_MANAGER_URL');
  const runnerManagerToken = configuredPath('RUNNER_MANAGER_TOKEN');
  let runnerManager: RuntimeManagerClient | null = null;
  let runnerManagerVerificationPolicy: RuntimeRunSpec['networkPolicy'] = 'none';
  if (runnerManagerUrl !== null && runnerManagerToken !== null) {
    try {
      runnerManagerVerificationPolicy = runtimeVerificationNetworkPolicy(process.env);
      runnerManager = createRuntimeManagerClient(
        runnerManagerUrl,
        runnerManagerToken,
        globalThis.fetch,
        { verificationNetworkPolicy: runnerManagerVerificationPolicy },
      );
    } catch (error) {
      log.error('[compose] runner manager NOT configured', { error });
    }
  } else if (runnerManagerUrl !== null || runnerManagerToken !== null) {
    log.error(
      '[compose] runner manager NOT configured: RUNNER_MANAGER_URL and RUNNER_MANAGER_TOKEN must be set together.',
    );
  }
  const resolveProviderCredential = createProviderCredentialResolver({
    secrets: secretsService,
    scopes,
  });
  await installDriverRegistry(
    runnerManager,
    runnerManagerUrl,
    runnerManagerVerificationPolicy,
    resolveProviderCredential,
    {
      get: async (workspaceId, driverId) => {
        const scope = await scopes.forWorkspaceId(workspaceId);
        return scope === null ? null : root.runtimeVerifications.forScope(scope).get(driverId);
      },
      record: async (workspaceId, driverId, verification) => {
        const scope = await scopes.forWorkspaceId(workspaceId);
        if (scope === null) throw new Error('the workspace of the runtime verification is gone');
        await root.runtimeVerifications.forScope(scope).record(driverId, verification);
      },
    },
  );
  // Issue #378: the first-run wizard defaults to the driver this deployment actually runs. Only a
  // runner manager that was really created counts, so its URL is passed only alongside a client.
  configureSetupRuntimeDetection(
    setupRuntimeDetectionInputs(
      runnerManager === null ? null : runnerManagerUrl,
      runnerManagerDriverId(process.env),
      probeRuntimeManager,
    ),
  );
  const files = await installFilesApi(
    resolveWorkspace,
    scopes,
    resourceCatalog,
    root.fileTexts,
    root.sessionState,
    {
      lock: (name, work) => root.withNamedLock(name, work),
      workspaceIds: () => root.listWorkspaceIds(),
      audit: (event) => root.recordAuditEvent(event),
      stopOnClose,
    },
  );
  const skills = await installSkillsApi(
    resolveWorkspace,
    scopes,
    resourceCatalog,
    files.kind === 'serving' ? files.runtime.storage : undefined,
    {
      lock: (name, work) => root.withNamedLock(name, work),
      workspaceIds: () => root.listWorkspaceIds(),
      migrationRuns: root.storageMigrationRuns,
      owners: root.workspaces,
    },
  );
  const sessions = await installSessionTranscripts(
    identifyAuditActor,
    root,
    stopOnClose,
    files.kind === 'serving' ? files.runtime.storage : undefined,
  );
  const setup = await installSetupApi(root, modelsApi, {
    policyCeiling,
    runtimeSecrets: secretsService,
  });

  return {
    secrets,
    secretsService,
    models,
    modelsApi,
    connectors,
    endpointClients,
    files,
    runnerManager,
    runnerManagerUrl,
    resolveProviderCredential,
    oauth,
    runtimes,
    runtimeSwitchAudit,
    sessions,
    setup,
    skills,
    storageConnections,
  };
}

export type SubsystemsWiring = Awaited<ReturnType<typeof wireSubsystems>>;
