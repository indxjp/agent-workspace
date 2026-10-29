/**
 * `@agent-workspace/core/db` — the database layer, as application code is allowed to see it.
 *
 * ## The shape rule this file is held to
 *
 * **Every `export` statement below re-exports from `./repositories/index.js`, and nothing else.**
 * That is not a description: `database-reachability.test.ts` parses this file, reads the path out
 * of `packages/core/package.json`'s `./db` export rather than from a literal, and fails by name on
 * an export statement naming any other module. So the public surface is the repository layer's
 * surface, and a re-export added from `./client.js`, `./schema/index.js`, `./seed.js` or
 * `./migrate.js` is a red test rather than a paragraph that has gone stale.
 *
 * A caller obtains {@link openDatabaseRoot}, which returns scope-bound repository providers, the
 * two by-id lookups that cannot be scoped without assuming their own answer, and `close()`.
 *
 * That is a change made by verification round 1 of W2-DB-02. This file previously read
 *
 * ```text
 * export * from './client.js';
 * export * from './schema/index.js';
 * ```
 *
 * which put the pooled-connection factory and every schema table beside the repositories, and the
 * verifier used them from a real Next.js route handler to select and delete every tenant's rows
 * with `tsc` and `eslint` both exiting 0. The repository constructor gate held; the repository
 * *layer* was optional. A gate on a layer nobody has to enter is not a gate (ADR-0015), and six
 * sub-wave tasks were about to copy the shape (ADR-0024).
 *
 * `scope-forgery.test.ts` compiles those exact statements against this file and requires a
 * diagnostic on each one's own line, so this paragraph cannot go stale without a test going red.
 *
 * ## The declared escape
 *
 * `@agent-workspace/core/db/unscoped` still exists and still hands out the raw handle and the
 * tables, because a conformance suite has to insert the rows the repository under test reads and
 * cannot do that through the layer it is testing. It is a **declared** escape:
 *
 *   * it is named — the subpath says `unscoped`, and `database-reachability.test.ts` prints every
 *     file that imports it whenever it fails;
 *   * it refuses at run time — `repositories/unscoped.ts` throws when it is loaded by a process
 *     that has not identified itself as a test runner, so a route handler that imports it fails at
 *     import in `next dev` and in production alike;
 *   * it is gated in CI — `database-reachability.test.ts` lists the tracked tree with no pathspec,
 *     classifies each path by extension into a module it parses or a file no import specifier
 *     resolves to, reads the layer's own directories out of `packages/core/package.json`'s `./db`
 *     export (so `dist/db/**` is classified alongside `src/db/**`), hands each specifier to
 *     `ts.resolveModuleName` under the compiler options of a **union** of contexts — every tracked
 *     TypeScript project whose `ts.createProgram` **program** contains the importing file (the
 *     program, not `parsed.fileNames`: it is the root names plus everything they import), the
 *     repository root `tsconfig.json`, and every tracked project whose configuration file sits at
 *     or above the importing file — compares the resolved real paths against those
 *     directories, and asserts that
 *     the edges its `decide()` classifier refuses are an empty list — printing the whole derived
 *     set, permitted and refused, when they are not.
 *
 * ## Why the repository barrel is re-exported by name
 *
 * `repositories/runs.ts` re-exports `runStatuses`, `terminalRunStatuses` and `RunStatus` from the
 * schema so that a repository consumer needs one import rather than two. Naming the exports makes
 * a future collision a compile error where it is introduced rather than a silently dropped binding
 * where it is consumed.
 *
 * ## Why `seed.ts`, `migrate.ts` and `drizzle.config.ts` are not re-exported
 *
 * Verification round 2 of W2-DB-02 found `runSeed` on this barrel and used it from a Next.js route
 * handler, against PostgreSQL, to insert an `owner` membership row into a workspace the caller had
 * no membership in — `seed()` resolves its workspace by slug with `onConflictDoNothing`, so calling
 * it with an *existing* tenant's slug finds that tenant and grants the caller's address `owner` on
 * it. Its `SeedOptions` are caller-supplied strings, not fixed rows: `workspaceSlug`, `adminEmail`
 * and `adminName` all come from the argument. That is a cross-tenant write with no
 * {@link WorkspaceScope} anywhere in it, and it defeats spec §25.
 *
 * `pnpm db:seed` and `pnpm db:migrate` do not read this barrel — `packages/core/package.json` runs
 * `node dist/db/seed.js` and `node dist/db/migrate.js`, and the production image's `CMD` in
 * `Dockerfile` runs those same two files — so removing them here costs those entry points nothing.
 * Both remain reachable by a relative import from inside `packages/core/`: `seed.test.ts` imports
 * `./seed.js` and `./migrate.js`, and `repositories/testing.ts` imports `../migrate.js` to build a
 * suite's private database. `database-reachability.test.ts` is the gate on who else may.
 *
 * `drizzle.config.ts` is author-time configuration for `drizzle-kit`, not part of the runtime API.
 */
export {
  FILE_TEXT_MAX_CHARS,
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
  connectorKinds,
  createInMemoryWorkspaceScopeResolver,
  engineIds,
  ForgedWorkspaceScopeError,
  isProjectArchived,
  isTerminalRunStatus,
  mcpAuthTypes,
  mcpTransports,
  openDatabaseRoot,
  prepareDatabase,
  remoteMcpTransports,
  requireWorkspaceScope,
  RUN_FEEDBACK_COMMENT_MAX_LENGTH,
  RUN_FEEDBACK_RATINGS,
  runStatuses,
  SESSION_STATE_PAGE_LIMIT,
  terminalRunStatuses,
  toolConnectorKinds,
  UnknownWorkspaceError,
  WorkspaceScope,
  type AgentGrantRepository,
  type AgentGrantRepositoryProvider,
  type AgentPermissions,
  type AgentRecord,
  type AgentRepository,
  type AgentRepositoryProvider,
  type AgentResourceAssignments,
  type AgentResourceAssignmentsInput,
  type AgentResourceRepository,
  type AgentResourceRepositoryProvider,
  type AgentStoredPolicy,
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
  type AuditEventRepository,
  type AuditEventRepositoryProvider,
  type KeysetPage,
  type KeysetPosition,
  type CreateAgentInput,
  type CreateAgentOutcome,
  type CreateAgentWithAssignmentsOutcome,
  type CatalogFile,
  type CatalogSkill,
  type CatalogSkillRevision,
  type DeleteCatalogSkillOutcome,
  type MarkSkillDeletingOutcome,
  type PendingSkillDelete,
  parsePendingSkillDelete,
  type CreateMcpServerInput,
  type CreateMcpServerOutcome,
  type CreateModelConnectionInput,
  type CreateModelConnectionOutcome,
  type CreateProjectInput,
  type CreateRunInput,
  type CreateRunOutcome,
  type CreateRuntimeProfileInput,
  type CreateRuntimeProfileOutcome,
  type CreateShareInput,
  type AcceptInvitationOutcome,
  type ActiveBrowserToken,
  type ActiveCliSession,
  type CliSessionRepository,
  type CliTokenExchangeOutcome,
  type RecordCliApprovalInput,
  type RecordCliApprovalOutcome,
  type BrowserTokenRepository,
  type BrowserTokenRepositoryProvider,
  type BuilderToolCallRepositoryProvider,
  type ActiveOAuthAccessToken,
  type IssueOAuthTokenInput,
  type OAuthClientRecord,
  type OAuthConsumeOutcome,
  type OAuthTokenRecord,
  type OAuthTokenRepository,
  type OAuthTokenRepositoryProvider,
  type SurfaceSessionKeyRepository,
  type DatabaseRoot,
  type LockOutcome,
  type DatabaseDirectoryRoot,
  type DatabaseWorkspaceDirectory,
  LOCAL_RUNTIME_API_KEY_NAME_PREFIX,
  type DirectoryApiKeyRecord,
  type DirectoryEndpointScope,
  type DirectoryInvitationRecord,
  type DirectoryMembershipRecord,
  type DirectoryPrincipalRecord,
  type DirectoryUserRecord,
  type DeleteAgentOutcome,
  type DeleteMcpServerOutcome,
  type DeleteModelConnectionOutcome,
  type DeleteRuntimeProfileOutcome,
  type EngineId,
  type EnsureSessionInput,
  type EnsureSessionOutcome,
  type EnsureWorkspaceDefaultOptions,
  type EnsureWorkspaceDefaultRuntimeProfileOutcome,
  type KnownWorkspace,
  type McpAuthType,
  type McpServerRecord,
  type UpdateMcpServerInput,
  type UpdateMcpServerOutcome,
  type McpServerRepository,
  type McpServerRepositoryProvider,
  type McpTransport,
  type ConnectorKind,
  type CreateToolConnectorInput,
  type CreateToolConnectorOutcome,
  type RecordRunToolSandboxOutcome,
  type SnapshotRunToolsOutcome,
  type ToolConnectorKind,
  type ToolConnectorRecord,
  type UpdateToolConnectorInput,
  type UpdateToolConnectorOutcome,
  type ModelConnectionRecord,
  type ModelConnectionRepository,
  type ModelConnectionRepositoryProvider,
  createInMemoryStorageConnectionRepositoryProvider,
  type CreateStorageConnectionOutcome,
  type CreateStorageConnectionRecordInput,
  type StorageConnectionRecord,
  type StorageConnectionRepository,
  type StorageConnectionRepositoryProvider,
  type UpdateStorageConnectionOutcome,
  type UpdateStorageConnectionRecordInput,
  type ProjectFileRepository,
  type ProjectFileRepositoryProvider,
  type ProjectListFilter,
  type ProjectMcpServerRepository,
  type ProjectMcpServerRepositoryProvider,
  type ProjectRecord,
  type FileTextHit,
  type FileTextPassage,
  type FileTextRepository,
  type FileTextRepositoryProvider,
  type FileTextSource,
  type StaleFile,
  type ResourceCatalogRepository,
  type ResourceCatalogRepositoryProvider,
  type CatalogPort,
  CatalogPathPendingError,
  CatalogPathTakenError,
  renamedKey,
  type ReserveOutcome,
  createInMemoryCatalog,
  createInMemoryStorageMigrationRuns,
  type StorageMigrationRun,
  type StorageMigrationRunInput,
  type StorageMigrationRunRepository,
  type AgentRestoreActor,
  type ReplaceAgentPolicyOutcome,
  type RestoreAgentOutcome,
  type ReplaceAgentResourcesOutcome,
  type ProjectRepository,
  type ProjectRepositoryProvider,
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
  type RunFeedbackRating,
  type RunFeedbackRepository,
  type RunFeedbackRepositoryProvider,
  type EndpointClientPatch,
  type EndpointClientRecord,
  type EndpointClientRepository,
  type EndpointClientRepositoryProvider,
  type NewEndpointClientInput,
  type NewTriggerInput,
  type TriggerForIngress,
  type TriggerRecord,
  type TriggerRepository,
  type TriggerRepositoryProvider,
  type RunTokenRepository,
  type RunTokenRepositoryProvider,
  type StoredRunEvent,
  type RuntimeProfileRecord,
  type RuntimeProfileRepository,
  type RuntimeProfileRepositoryProvider,
  type SessionRecord,
  type SessionRepository,
  type SessionRepositoryProvider,
  type SessionMutationOutcome,
  type SessionVisibility,
  type LegacySessionStateBlob,
  type SessionStateBlobInput,
  type SessionStateEntryInput,
  type SessionStateRepository,
  type SessionStateRepositoryProvider,
  type SessionStateStreamKey,
  type SessionTranscriptRepository,
  type SessionTranscriptRepositoryProvider,
  type StoredSessionStateBlob,
  type StoredSessionStateEntry,
  type StoredSessionStateStream,
  type LinkShareRunOutcome,
  type ReserveShareMessageOutcome,
  type ShareRecord,
  type ShareRepository,
  type ShareRepositoryProvider,
  type ShareViewRepository,
  type ShareViewRepositoryProvider,
  type StoredTranscriptEntry,
  type StoredTranscriptSession,
  type TranscriptKeyRecord,
  type UpdateAgentOutcome,
  type UpdateAgentPatch,
  type UpdateSessionInput,
  type UpdateModelConnectionOutcome,
  type UpdateModelConnectionPatch,
  type UpdateProjectPatch,
  type UpdateRuntimeProfileOutcome,
  type UpdateRuntimeProfilePatch,
  type WorkspaceFeatureRepository,
  type WorkspaceFeatureRepositoryProvider,
  type WorkspaceMembership,
  type WorkspaceScopeResolver,
} from './repositories/index.js';
export {
  type AgentVersionEvaluationRepository,
  type AgentVersionEvaluationRepositoryProvider,
  type RecordedAgentVersionEvaluation,
  type StoredAgentVersionEvaluation,
} from './repositories/index.js';
