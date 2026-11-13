import type { Database } from '../client.js';
import { createDatabaseAuditEventRepositoryProvider } from './audit-events.js';
import { createDatabaseAgentRepositoryProvider } from './agents.js';
import { createDatabaseBuilderToolCallRepositoryProvider } from './builder-tool-calls.js';
import { createDatabaseAgentGrantRepositoryProvider } from './agent-grants.js';
import { createDatabaseStorageMigrationRunRepository } from './storage-migration-runs.js';
import { createDatabaseFileTextRepositoryProvider } from './file-texts.js';
import { createDatabaseResourceCatalogRepositoryProvider } from './resource-catalogs.js';
import { createDatabaseAgentResourceRepositoryProvider } from './agent-resources.js';
import { createDatabaseAgentVersionRepositoryProvider } from './agent-versions.js';
import { createDatabaseDirectoryRoot } from './directory.js';
import { createDatabaseProjectFileRepositoryProvider } from './project-files.js';
import { createDatabaseProjectMcpServerRepositoryProvider } from './project-mcp-servers.js';
import { createDatabaseProjectRepositoryProvider } from './projects.js';
import {
  createDatabaseShareRepositoryProvider,
  createDatabaseShareViewRepositoryProvider,
} from './shares.js';
import { createDatabaseMcpServerRepositoryProvider } from './mcp-servers.js';
import { createDatabaseModelConnectionRepositoryProvider } from './model-connections.js';
import { createDatabaseStorageConnectionRepositoryProvider } from './storage-connections.js';
import {
  createDatabaseRunRepositoryProvider,
  createDatabaseRunEventRepositoryProvider,
  createDatabaseSessionRepositoryProvider,
  findRunWorkspace,
  listExpiredApprovalRunIds,
  listStaleRunIds,
} from './runs.js';
import { createDatabaseRunTokenRepositoryProvider } from './run-tokens.js';
import { createDatabaseRunFeedbackRepositoryProvider } from './run-feedback.js';
import { createDatabaseEndpointClientRepositoryProvider } from './endpoint-clients.js';
import { createDatabaseTriggerRepositoryProvider, findTriggerForIngress } from './triggers.js';
import { createDatabaseAgentTeamRepositoryProvider } from './agent-teams.js';
import { createDatabaseWebhookDeliveryRepository } from './webhook-deliveries.js';
import { createDatabaseWebhookRepositoryProvider } from './webhooks.js';
import { createDatabaseAgentVersionEvaluationRepositoryProvider } from './agent-version-evaluations.js';
import {
  createDatabaseBrowserTokenRepositoryProvider,
  findActiveBrowserTokenByHash,
} from './browser-tokens.js';
import {
  createDatabaseOAuthTokenRepositoryProvider,
  findActiveOAuthAccessToken,
  findOAuthClient,
} from './oauth-tokens.js';
import { createDatabaseRuntimeVerificationRepositoryProvider } from './runtime-verifications.js';
import { createDatabaseSurfaceSessionKeyRepositoryProvider } from './surface-session-keys.js';
import { createDatabaseCliSessionRepository } from './cli-sessions.js';
import { createDatabaseSessionTranscriptRepositoryProvider } from './session-transcripts.js';
import { createDatabaseSessionStateRepositoryProvider } from './session-state.js';
// Added by W3-CP-06, outside this task's `Owns` cell — declared on its PR (see
// `docs/adr/W3-CP-06-a-profile-reference-not-a-copy-and-the-integrator-call.md`). This file is the
// only place `apps/web`'s composition root can obtain a scope-bound runtime-profile repository
// without a raw `Database` handle, which `@agent-workspace/core/db` deliberately does not hand out.
import { createDatabaseRuntimeProfileRepositoryProvider } from './runtime-profiles.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createDatabaseWorkspaceFeatureRepositoryProvider } from './workspace-features.js';
import { createDatabaseWorkspaceRepository } from './workspaces.js';
import type { DatabaseRoot } from './root.js';

type RootRepositories = Omit<
  DatabaseRoot,
  | 'listWorkspaceIds'
  | 'tryAcquireMaintenanceLease'
  | 'findShareWorkspace'
  | 'resolveMembership'
  | 'getWorkspaceModelDefault'
  | 'setWorkspaceModelDefault'
  | 'getWorkspaceSetupAgentId'
  | 'setWorkspaceSetupAgentId'
  | 'clearWorkspaceSetupAgentId'
  | 'withWorkspaceSetupLock'
  | 'withNamedLock'
  | 'recordAuditEvent'
  | 'close'
>;

/** The scope-bound providers of {@link DatabaseRoot} and its by-id lookups, all on one `db`. */
export function rootRepositories(db: Database): RootRepositories {
  return {
    scopes: createDatabaseWorkspaceScopeResolver(db),
    agents: createDatabaseAgentRepositoryProvider(db),
    agentGrants: createDatabaseAgentGrantRepositoryProvider(db),
    agentResources: createDatabaseAgentResourceRepositoryProvider(db),
    agentVersions: createDatabaseAgentVersionRepositoryProvider(db),
    agentTeams: createDatabaseAgentTeamRepositoryProvider(db),
    resourceCatalogs: createDatabaseResourceCatalogRepositoryProvider(db),
    fileTexts: createDatabaseFileTextRepositoryProvider(db),
    storageMigrationRuns: createDatabaseStorageMigrationRunRepository(db),
    runs: createDatabaseRunRepositoryProvider(db),
    runEvents: createDatabaseRunEventRepositoryProvider(db),
    runTokens: createDatabaseRunTokenRepositoryProvider(db),
    runFeedback: createDatabaseRunFeedbackRepositoryProvider(db),
    builderToolCalls: createDatabaseBuilderToolCallRepositoryProvider(db),
    endpointClients: createDatabaseEndpointClientRepositoryProvider(db),
    triggers: createDatabaseTriggerRepositoryProvider(db),
    webhooks: createDatabaseWebhookRepositoryProvider(db),
    webhookDeliveries: createDatabaseWebhookDeliveryRepository(db),
    agentVersionEvaluations: createDatabaseAgentVersionEvaluationRepositoryProvider(db),
    browserTokens: createDatabaseBrowserTokenRepositoryProvider(db),
    oauthTokens: createDatabaseOAuthTokenRepositoryProvider(db),
    surfaceSessionKeys: createDatabaseSurfaceSessionKeyRepositoryProvider(db),
    runtimeVerifications: createDatabaseRuntimeVerificationRepositoryProvider(db),
    sessions: createDatabaseSessionRepositoryProvider(db),
    sessionTranscripts: createDatabaseSessionTranscriptRepositoryProvider(db),
    sessionState: createDatabaseSessionStateRepositoryProvider(db),
    mcpServers: createDatabaseMcpServerRepositoryProvider(db),
    modelConnections: createDatabaseModelConnectionRepositoryProvider(db),
    storageConnections: createDatabaseStorageConnectionRepositoryProvider(db),
    runtimeProfiles: createDatabaseRuntimeProfileRepositoryProvider(db),
    projects: createDatabaseProjectRepositoryProvider(db),
    projectFiles: createDatabaseProjectFileRepositoryProvider(db),
    projectMcpServers: createDatabaseProjectMcpServerRepositoryProvider(db),
    shares: createDatabaseShareRepositoryProvider(db),
    shareViews: createDatabaseShareViewRepositoryProvider(db),
    auditEventRepository: createDatabaseAuditEventRepositoryProvider(db),
    directory: createDatabaseDirectoryRoot(db),
    workspaces: createDatabaseWorkspaceRepository(db),
    workspaceFeatures: createDatabaseWorkspaceFeatureRepositoryProvider(db),
    cliSessions: createDatabaseCliSessionRepository(db),
    findRunWorkspace: (runId) => findRunWorkspace(db, runId),
    listStaleRunIds: (before, limit) => listStaleRunIds(db, before, limit),
    listExpiredApprovalRunIds: (before, limit) => listExpiredApprovalRunIds(db, before, limit),
    findBrowserTokenByHash: (tokenHash, now) => findActiveBrowserTokenByHash(db, tokenHash, now),
    findOAuthAccessTokenByHash: (tokenHash, now) => findActiveOAuthAccessToken(db, tokenHash, now),
    findOAuthClient: (clientId) => findOAuthClient(db, clientId),
    findTriggerForIngress: (triggerId) => findTriggerForIngress(db, triggerId),
  };
}
