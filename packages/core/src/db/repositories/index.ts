/**
 * The repository layer's public surface — the shape Wave 2's six resource tracks copy.
 *
 * Four things are here and they are meant to be read in this order:
 *
 *   1. `scope.ts` — {@link WorkspaceScope}, which a repository takes and which cannot be written
 *      out of request data. Read it first; everything else is an application of it.
 *   2. `root.ts` — {@link openDatabaseRoot}, the only way application code reaches PostgreSQL. It
 *      returns scope-bound providers and no queryable handle, which is what makes "every query
 *      filters on the tenant" a property of the surface rather than of the constructor alone.
 *   3. `agents.ts` — the first repository, and the reference for a resource with a unique index
 *      and a foreign key to honour.
 *   4. `runs.ts` — the second, and the reference for a resource whose row cannot exist until
 *      another row does.
 *
 * A new resource copies the shape rather than the code: a record type, a discriminated outcome
 * union with one member per correction the caller can make, a `Repository` interface no method of
 * which takes a workspace id, a `RepositoryProvider` with a single `forScope` that opens with
 * {@link requireWorkspaceScope}, a line on {@link DatabaseRoot}, and a suite that runs against both
 * an in-memory implementation and this one.
 *
 * ## What is deliberately NOT re-exported here
 *
 * The `db`-taking factories — `createDatabaseAgentRepositoryProvider` and its three siblings,
 * `findRunWorkspace`, `isWorkspaceMember`, `createDatabaseWorkspaceScopeResolver` — and
 * `createIsolatedTestDatabase`. Each needs a raw {@link import('../client.js').Database}, and a
 * surface that hands one out is a surface on which the repository layer is optional. They live on
 * `./unscoped.ts`, behind the `@agent-workspace/core/db/unscoped` subpath, which refuses to load
 * outside a test process. `./root.ts` is what a composition root uses instead.
 *
 * `docs/adr/W2-DB-02-the-repository-shape.md` is the written form of these paragraphs;
 * `scope-forgery.test.ts` and `database-reachability.test.ts` are the executable form.
 */
export {
  createInMemoryWorkspaceScopeResolver,
  ForgedWorkspaceScopeError,
  requireWorkspaceScope,
  UnknownWorkspaceError,
  WorkspaceScope,
  type KnownWorkspace,
  type WorkspaceScopeResolver,
} from './scope.js';

// Process bootstrap is intentionally exposed through the same audited public barrel so the CLI
// can migrate and seed before opening listeners without gaining a raw Database handle.
export { prepareDatabase } from '../bootstrap.js';

export {
  openDatabaseRoot,
  type DatabaseRoot,
  type LockOutcome,
  type WorkspaceMembership,
} from './root.js';
export {
  type AcceptInvitationOutcome,
  type DirectoryApiKeyRecord,
  type DirectoryEndpointScope,
  type DatabaseDirectoryRoot,
  type DirectoryInvitationRecord,
  type DirectoryMembershipRecord,
  type DirectoryPrincipalRecord,
  type DirectoryUserRecord,
  type DatabaseWorkspaceDirectory,
  LOCAL_RUNTIME_API_KEY_NAME_PREFIX,
} from './directory.js';

export { type AuditEventRepository, type AuditEventRepositoryProvider } from './audit-events.js';
export { type KeysetPage, type KeysetPosition } from './keyset.js';
export { type AgentGrantRepository, type AgentGrantRepositoryProvider } from './agent-grants.js';
export {
  type AgentResourceAssignments,
  type AgentResourceAssignmentsInput,
  type AgentResourceRepository,
  type AgentResourceRepositoryProvider,
  type ReplaceAgentResourcesOutcome,
} from './agent-resources.js';
// #442 (S1-04, ADR-0101): the agent version store. `agentVersionVias` is the contracts'
// AGENT_VERSION_VIAS; the other value exports are core copies of AGENT_ENVIRONMENTS and
// AGENT_DEFINITION_REFERENCE_KINDS.
export {
  agentDefinitionReferenceKinds,
  agentVersionEnvironments,
  agentVersionVias,
  appliedRuntimeProfileId,
  bodyDeclaresSubagents,
  bodyHasDescription,
  bodySubagentNames,
  narrowFileGrants,
  narrowStorageGrants,
  storageGrantChange,
  resolveFromRows,
  type AgentDefinitionReferenceKind,
  type AgentVersionEnvironment,
  type AgentSubagentCandidate,
  type AgentVersionListing,
  type AgentVersionPointerRecord,
  type AgentVersionRecord,
  type AgentVersionRepository,
  type AgentVersionRepositoryProvider,
  type AgentVersionVia,
  type AgentPointerAudit,
  type AgentPointerMoveReason,
  type AgentPointerMoveRecord,
  type ApplyAndPointInput,
  type ApplyAndPointOutcome,
  type SubagentNestingOutcome,
  type CreateAgentVersionInput,
  type CreateAgentVersionOutcome,
  type CreateAgentWithFirstVersionInput,
  type CreateAgentWithFirstVersionOutcome,
  type DefinitionReference,
  type DefinitionReferences,
  type FileGrant,
  type MaterialisedAgent,
  type PointedSurface,
  type ReferenceGoneOutcome,
  type ReferenceIds,
  type ReferenceNames,
  type ResolveDefinitionOutcome,
  type ResolvedReferences,
  type StorageGrantRef,
} from './agent-versions.js';
export {
  FILE_TEXT_MAX_CHARS,
  type FileTextHit,
  type FileTextPassage,
  type FileTextRepository,
  type FileTextRepositoryProvider,
  type FileTextSource,
  type StaleFile,
} from './file-texts.js';
export {
  type WorkspaceFeatureRepository,
  type WorkspaceFeatureRepositoryProvider,
} from './workspace-features.js';
export {
  CatalogPathPendingError,
  CatalogPathTakenError,
  renamedKey,
  type CatalogFile,
  type CatalogPort,
  type CatalogSkill,
  type CatalogSkillRevision,
  type DeleteCatalogSkillOutcome,
  type MarkSkillDeletingOutcome,
  type PendingSkillDelete,
  parsePendingSkillDelete,
  type ReserveOutcome,
  type ResourceCatalogRepository,
  type ResourceCatalogRepositoryProvider,
} from './resource-catalogs.js';
export { createInMemoryCatalog } from './memory-catalog.js';
export {
  createInMemoryStorageMigrationRuns,
  type StorageMigrationRun,
  type StorageMigrationRunInput,
  type StorageMigrationRunRepository,
} from './storage-migration-runs.js';
export { type ProjectFileRepository, type ProjectFileRepositoryProvider } from './project-files.js';
export {
  type ProjectMcpServerRepository,
  type ProjectMcpServerRepositoryProvider,
} from './project-mcp-servers.js';
export {
  // issue #183: the server-side archived-project execution gate answers with this one predicate
  // rather than re-deriving `archivedAt !== null` at each call site that creates a session or run.
  isProjectArchived,
  type CreateProjectInput,
  type ProjectListFilter,
  type ProjectRecord,
  type ProjectRepository,
  type ProjectRepositoryProvider,
  type UpdateProjectPatch,
} from './projects.js';
export {
  type CreateShareInput,
  type LinkShareRunOutcome,
  type ReserveShareMessageOutcome,
  type ShareRecord,
  type ShareRepository,
  type ShareRepositoryProvider,
  type ShareViewRepository,
  type ShareViewRepositoryProvider,
} from './shares.js';

export {
  type AgentPermissions,
  type AgentRecord,
  type AgentRepository,
  type AgentRepositoryProvider,
  type AgentStoredPolicy,
  type CreateAgentInput,
  type CreateAgentOutcome,
  type CreateAgentWithAssignmentsOutcome,
  type DeleteAgentOutcome,
  type AgentRestoreActor,
  type ReplaceAgentPolicyOutcome,
  type RestoreAgentOutcome,
  type UpdateAgentOutcome,
  type UpdateAgentPatch,
} from './agents.js';

export {
  engineIds,
  isTerminalRunStatus,
  runStatuses,
  terminalRunStatuses,
  type EngineId,
  type CreateRunInput,
  type CreateRunOutcome,
  type EnsureSessionInput,
  type EnsureSessionOutcome,
  type RunOutput,
  type RunRecord,
  type RecordRunUsageInput,
  type RecordRunUsageOutcome,
  type RunEventRepository,
  type RunEventRepositoryProvider,
  type RunRepository,
  type RunRepositoryProvider,
  type RunStatus,
  type RunTransitionOutcome,
  type RecordRunToolSandboxOutcome,
  type SnapshotRunToolsOutcome,
  type StoredRunEvent,
  type SessionRecord,
  type SessionRepository,
  type SessionRepositoryProvider,
  type SessionMutationOutcome,
  type SessionVisibility,
  type UpdateSessionInput,
} from './runs.js';

export { type RunTokenRepository, type RunTokenRepositoryProvider } from './run-tokens.js';
export {
  type EndpointClientPatch,
  type EndpointClientRecord,
  type EndpointClientRepository,
  type EndpointClientRepositoryProvider,
  type NewEndpointClientInput,
} from './endpoint-clients.js';
export {
  type NewTriggerInput,
  type TriggerForIngress,
  type TriggerRecord,
  type TriggerRepository,
  type TriggerRepositoryProvider,
} from './triggers.js';
// #1845: the Builder tool-call journal.
export { type BuilderToolCallRepositoryProvider } from './builder-tool-calls.js';
// #539 (S2-05c, C19): the core copies of the contracts' RUN_FEEDBACK_RATINGS and comment cap.
export {
  RUN_FEEDBACK_COMMENT_MAX_LENGTH,
  RUN_FEEDBACK_RATINGS,
  type RunFeedbackRating,
  type RunFeedbackRepository,
  type RunFeedbackRepositoryProvider,
} from './run-feedback.js';
export {
  type AgentVersionEvaluationRepository,
  type AgentVersionEvaluationRepositoryProvider,
  type RecordedAgentVersionEvaluation,
  type StoredAgentVersionEvaluation,
} from './agent-version-evaluations.js';
export {
  type ActiveBrowserToken,
  type BrowserTokenRepository,
  type BrowserTokenRepositoryProvider,
} from './browser-tokens.js';
export {
  type ActiveOAuthAccessToken,
  type IssueOAuthTokenInput,
  type OAuthClientRecord,
  type OAuthConsumeOutcome,
  type OAuthTokenRecord,
  type OAuthTokenRepository,
  type OAuthTokenRepositoryProvider,
} from './oauth-tokens.js';
export { type SurfaceSessionKeyRepository } from './surface-session-keys.js';
export {
  type ActiveCliSession,
  type CliSessionRepository,
  type CliTokenExchangeOutcome,
  type RecordCliApprovalInput,
  type RecordCliApprovalOutcome,
} from './cli-sessions.js';

export {
  type SessionTranscriptRepository,
  type SessionTranscriptRepositoryProvider,
  type StoredTranscriptEntry,
  type StoredTranscriptSession,
  type TranscriptKeyRecord,
} from './session-transcripts.js';

export {
  SESSION_STATE_PAGE_LIMIT,
  type LegacySessionStateBlob,
  type SessionStateBlobInput,
  type SessionStateEntryInput,
  type SessionStateRepository,
  type SessionStateRepositoryProvider,
  type SessionStateStreamKey,
  type StoredSessionStateBlob,
  type StoredSessionStateEntry,
  type StoredSessionStateStream,
} from './session-state.js';

// W2-CP-05 (connectors, spec §8) added this repository outside its dispatched `Owns:` globs — see
// `./mcp-servers.ts`'s header for why that is declared here rather than worked around. The two
// enums are re-exported the same way `./runs.ts` re-exports `runStatuses` from the schema.
export {
  connectorKinds,
  mcpAuthTypes,
  mcpTransports,
  remoteMcpTransports,
  toolConnectorKinds,
  type ConnectorKind,
  type CreateMcpServerInput,
  type CreateMcpServerOutcome,
  type DeleteMcpServerOutcome,
  type McpAuthType,
  type McpServerRecord,
  type McpServerRepository,
  type McpServerRepositoryProvider,
  type McpTransport,
  type CreateToolConnectorInput,
  type CreateToolConnectorOutcome,
  type ToolConnectorKind,
  type ToolConnectorRecord,
  type UpdateMcpServerInput,
  type UpdateMcpServerOutcome,
  type UpdateToolConnectorInput,
  type UpdateToolConnectorOutcome,
} from './mcp-servers.js';

export {
  type CreateModelConnectionInput,
  type CreateModelConnectionOutcome,
  type DeleteModelConnectionOutcome,
  type ModelConnectionRecord,
  type ModelConnectionRepository,
  type ModelConnectionRepositoryProvider,
  type UpdateModelConnectionOutcome,
  type UpdateModelConnectionPatch,
} from './model-connections.js';

export {
  type CreateStorageConnectionOutcome,
  type CreateStorageConnectionRecordInput,
  type StorageConnectionRecord,
  type StorageConnectionRepository,
  type StorageConnectionRepositoryProvider,
  type UpdateStorageConnectionOutcome,
  type UpdateStorageConnectionRecordInput,
} from './storage-connections.js';
export { createInMemoryStorageConnectionRepositoryProvider } from './memory-storage-connections.js';

export {
  type CreateRuntimeProfileInput,
  type CreateRuntimeProfileOutcome,
  type DeleteRuntimeProfileOutcome,
  type EnsureWorkspaceDefaultOptions,
  type EnsureWorkspaceDefaultRuntimeProfileOutcome,
  type RuntimeProfileRecord,
  type RuntimeProfileRepository,
  type RuntimeProfileRepositoryProvider,
  type UpdateRuntimeProfileOutcome,
  type UpdateRuntimeProfilePatch,
} from './runtime-profiles.js';
