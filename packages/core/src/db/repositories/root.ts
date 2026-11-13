/**
 * `openDatabaseRoot` — the only way application code reaches PostgreSQL, and it hands back
 * scope-bound repositories rather than a queryable handle.
 *
 * ## The hole this closes
 *
 * Verification round 1 of W2-DB-02 found that the repository *constructor* gate held while the
 * repository *layer* was bypassable. `packages/core/src/db/index.ts` re-exported the connection
 * factory and every schema table beside the repositories, so this compiled from a real Next.js
 * route handler with `tsc` and `eslint` both silent:
 *
 * ```text
 * import { agents, createDatabase, createPool, readDatabaseConfig } from '@agent-workspace/core/db';
 * const db = createDatabase(createPool(readDatabaseConfig(process.env)));
 * await db.select().from(agents);        // every tenant's agents
 * await db.delete(agents);               // every tenant's agents, gone
 * ```
 *
 * A gate on the constructor of a thing nobody has to use is not a gate. So the public surface no
 * longer carries a way to *obtain* a {@link Database}: `createDatabase`, `createPool`, `connect`,
 * `readDatabaseConfig`, the `Database` type itself and every schema table moved to
 * `@agent-workspace/core/db/unscoped`, which is a declared escape with a run-time refusal
 * (`./unscoped.ts`), and what remains on `@agent-workspace/core/db` is this function.
 *
 * `scope-forgery.test.ts` compiles those statements against the public surface, one per line, and
 * requires a diagnostic on each line's own number, so this paragraph cannot go stale without a test
 * going red.
 *
 * ## What a composition root gets, and what it deliberately does not
 *
 * It gets four scope-bound providers, the two by-id lookups the application genuinely cannot
 * scope (a run's workspace, a session's membership), and `close()`. It does **not** get `db`.
 * There is no accessor, no `unsafeDatabase`, no options bag that returns one — a root that handed
 * the handle back would restore exactly the escape above with one more hop in it.
 *
 * ## Why the membership lookup is here rather than in `apps/web/instrumentation.ts`
 *
 * It is the one query a request must issue *before* it has a scope: it is what decides which
 * tenant the request acts as. It cannot be scope-bound without assuming its own answer. Wave 1's
 * composition root ran it against a raw handle; keeping the handle in `apps/web` for the sake of
 * three queries would mean keeping the escape for the sake of three queries. So the three queries
 * move here, where they are named, bounded — three `columns:` projections, no row content beyond
 * two ids — and reviewable as the exception they are.
 *
 * The membership is *checked* rather than inferred from the slug, which is why it is three
 * queries and not one. A valid session proves this deployment's secret signed those claims; it
 * does not prove the account it names still belongs to the workspace it names. Deriving a
 * workspace id from the slug alone would make revoking a membership do nothing until the token
 * expired.
 */
import {
  closePool,
  createDatabase,
  createPool,
  readDatabaseConfig,
  type Database,
} from '../client.js';
import type { MembershipRole } from '../schema/memberships.js';
import type { NewAuditEvent } from '../schema/audit-events.js';
import type { AuditEventRepositoryProvider } from './audit-events.js';
import type { AgentRepositoryProvider } from './agents.js';
import type { BuilderToolCallRepositoryProvider } from './builder-tool-calls.js';
import type { AgentGrantRepositoryProvider } from './agent-grants.js';
import type { StorageMigrationRunRepository } from './storage-migration-runs.js';
import type { FileTextRepositoryProvider } from './file-texts.js';
import type { ResourceCatalogRepositoryProvider } from './resource-catalogs.js';
import type { AgentResourceRepositoryProvider } from './agent-resources.js';
import type { AgentVersionRepositoryProvider } from './agent-versions.js';
import type { DatabaseDirectoryRoot } from './directory.js';
import type { ProjectFileRepositoryProvider } from './project-files.js';
import type { ProjectMcpServerRepositoryProvider } from './project-mcp-servers.js';
import type { ProjectRepositoryProvider } from './projects.js';
import type { ShareRepositoryProvider, ShareViewRepositoryProvider } from './shares.js';
import type { McpServerRepositoryProvider } from './mcp-servers.js';
import type { ModelConnectionRepositoryProvider } from './model-connections.js';
import type { StorageConnectionRepositoryProvider } from './storage-connections.js';
import type {
  RunRepositoryProvider,
  RunEventRepositoryProvider,
  SessionRepositoryProvider,
} from './runs.js';
import type { RunTokenRepositoryProvider } from './run-tokens.js';
import type { RunFeedbackRepositoryProvider } from './run-feedback.js';
import type { EndpointClientRepositoryProvider } from './endpoint-clients.js';
import type { TriggerForIngress, TriggerRepositoryProvider } from './triggers.js';
import type { AgentTeamRepositoryProvider } from './agent-teams.js';
import type { WebhookDeliveryRepository } from './webhook-deliveries.js';
import type { WebhookRepositoryProvider } from './webhooks.js';
import type { AgentVersionEvaluationRepositoryProvider } from './agent-version-evaluations.js';
import type { ActiveBrowserToken, BrowserTokenRepositoryProvider } from './browser-tokens.js';
import type {
  ActiveOAuthAccessToken,
  OAuthClientRecord,
  OAuthTokenRepositoryProvider,
} from './oauth-tokens.js';
import type { RuntimeVerificationRepositoryProvider } from './runtime-verifications.js';
import type { SurfaceSessionKeyRepositoryProvider } from './surface-session-keys.js';
import type { CliSessionRepository } from './cli-sessions.js';
import type { SessionTranscriptRepositoryProvider } from './session-transcripts.js';
import type { SessionStateRepositoryProvider } from './session-state.js';
import type { RuntimeProfileRepositoryProvider } from './runtime-profiles.js';
import type { WorkspaceScopeResolver } from './scope.js';
import type { WorkspaceFeatureRepositoryProvider } from './workspace-features.js';
import type { WorkspaceRepository } from './workspaces.js';
import { rootLocks } from './root-locks.js';
import { rootQueries } from './root-queries.js';
import { rootRepositories } from './root-repositories.js';

type RootAuditEvent = Omit<NewAuditEvent, 'actorPrincipalId' | 'actorUserId'> & {
  readonly actorPrincipalId: string | null;
  readonly actorUserId?: string | null;
};

/** The two database ids a request acts under, once a membership row has been read. */
export interface WorkspaceMembership {
  /** Exact durable authorization and ownership subject for this membership. */
  readonly principalId: string;
  /** `users.id`. */
  readonly userId: string;
  /** Stable display label copied into immutable audit rows. */
  readonly userLabel: string;
  /** `workspaces.id`. */
  readonly workspaceId: string;
  readonly role: MembershipRole;
}

interface MaintenanceLease {
  release(): Promise<void>;
}

/** What {@link DatabaseRoot.withWorkspaceSetupLock} and {@link DatabaseRoot.withNamedLock} answer. */
export type LockOutcome<T> =
  { readonly acquired: true; readonly value: T } | { readonly acquired: false };

/**
 * Everything a composition root needs from PostgreSQL, and nothing that can issue a query the
 * repository layer did not build.
 */
export interface DatabaseRoot {
  /** Turns the workspace slug a session carries, or a workspace id, into a `WorkspaceScope`. */
  readonly scopes: WorkspaceScopeResolver;
  /** Agent rows, for one scope at a time. */
  readonly agents: AgentRepositoryProvider;
  /** `agent_grants` — a Viewer's explicit "run this agent" grants (spec §21, issue #117). */
  readonly agentGrants: AgentGrantRepositoryProvider;
  readonly agentResources: AgentResourceRepositoryProvider;
  /**
   * `agent_versions` and `agent_version_pointers` — an agent's immutable history and which version
   * each environment runs (#442, S1-04, ADR-0101; C7 and C9 are enforced inside it).
   */
  readonly agentVersions: AgentVersionRepositoryProvider;
  /** Agent teams and their immutable versions, scoped by workspace (ADR-0104, issue #1516). */
  readonly agentTeams: AgentTeamRepositoryProvider;
  readonly resourceCatalogs: ResourceCatalogRepositoryProvider;
  /** `file_texts` — the text a file search extracted, cached with its `tsvector` (ADR-0147). */
  readonly fileTexts: FileTextRepositoryProvider;
  /** `storage_migration_runs` — the verify passes of the move off the old object naming (§06). */
  readonly storageMigrationRuns: StorageMigrationRunRepository;
  /** Run rows, for one scope at a time. */
  readonly runs: RunRepositoryProvider;
  /** Replayable SSE events, retained durably and scoped to the run's workspace. */
  readonly runEvents: RunEventRepositoryProvider;
  /** Issued gateway-token digests and revocation state, scoped by workspace and run. */
  readonly runTokens: RunTokenRepositoryProvider;
  /** Append-only thumbs up/down on a run, scoped by workspace (issue #539, C19). */
  readonly runFeedback: RunFeedbackRepositoryProvider;
  /** The Builder's tool-call journal, one row per `aw-control` call (issue #1845). */
  readonly builderToolCalls: BuilderToolCallRepositoryProvider;
  readonly endpointClients: EndpointClientRepositoryProvider;
  /** Inbound triggers and their delivery claims, scoped by workspace (ADR-0144). */
  readonly triggers: TriggerRepositoryProvider;
  /** Run-outcome webhook endpoints, scoped by workspace (N-3, ADR-SDK-18-N3-250). */
  readonly webhooks: WebhookRepositoryProvider;
  /**
   * The webhook delivery outbox as the delivery worker claims and settles it. Unscoped for the
   * reason {@link listStaleRunIds} is: the worker acts as no one workspace, and it sees ids, a URL
   * and attempt bookkeeping only (ADR-SDK-18-N3-250 D4).
   */
  readonly webhookDeliveries: WebhookDeliveryRepository;
  /** Append-only scored evaluations of an agent version, scoped by workspace (issue #618). */
  readonly agentVersionEvaluations: AgentVersionEvaluationRepositoryProvider;
  /** Issued browser-token digests and revocation state, scoped by workspace (issue #236). */
  readonly browserTokens: BrowserTokenRepositoryProvider;
  /** OAuth codes, access and refresh tokens of endpoint clients, scoped by workspace (ADR-0134 part 3). */
  readonly oauthTokens: OAuthTokenRepositoryProvider;
  /** Hosted surface sessions' resume-key digests, scoped by workspace (issue #538). */
  readonly surfaceSessionKeys: SurfaceSessionKeyRepositoryProvider;
  /** The last passing Test Runtime of each driver, scoped by workspace. */
  readonly runtimeVerifications: RuntimeVerificationRepositoryProvider;
  /** Session rows, for one scope at a time. */
  readonly sessions: SessionRepositoryProvider;
  /** Durable SDK transcript entries, ordered and retry-idempotent within one workspace. */
  readonly sessionTranscripts: SessionTranscriptRepositoryProvider;
  /** The engine-scoped session store of ENG-06: streams, entries and blob records. */
  readonly sessionState: SessionStateRepositoryProvider;
  /** Connector (`mcp_servers`) rows, for one scope at a time (spec §8, W2-CP-05). */
  readonly mcpServers: McpServerRepositoryProvider;
  /** Model-provider connections, scoped to one workspace (spec §13). */
  readonly modelConnections: ModelConnectionRepositoryProvider;
  /** Storage connections (the non-secret half), scoped to one workspace (the storage design, §05). */
  readonly storageConnections: StorageConnectionRepositoryProvider;
  /** Runtime-profile rows (spec §15.1), for one scope at a time. Added by W3-CP-06. */
  readonly runtimeProfiles: RuntimeProfileRepositoryProvider;
  readonly projects: ProjectRepositoryProvider;
  readonly projectFiles: ProjectFileRepositoryProvider;
  readonly projectMcpServers: ProjectMcpServerRepositoryProvider;
  readonly shares: ShareRepositoryProvider;
  readonly shareViews: ShareViewRepositoryProvider;
  readonly auditEventRepository: AuditEventRepositoryProvider;
  /** Durable users, memberships and hashed API keys. */
  readonly directory: DatabaseDirectoryRoot;
  /**
   * `workspaces` CRUD/listing (issue #119) — unscoped by construction, exposed directly rather
   * than behind a `.forScope(...)` provider, for the same reason {@link directory} is: the
   * workspace row itself has no `workspace_id` to scope by (`../schema/workspaces.ts`'s header).
   */
  readonly workspaces: WorkspaceRepository;
  /** `workspace_features` — the features a workspace has switched off (ADR-0160 D6). */
  readonly workspaceFeatures: WorkspaceFeatureRepositoryProvider;
  /** Enumerate tenant ids for bounded maintenance jobs without exposing workspace row content. */
  listWorkspaceIds(): Promise<readonly string[]>;
  /** Acquire a connection-scoped PostgreSQL advisory lease, or null when another replica owns it. */
  tryAcquireMaintenanceLease(name: string, ttlMs: number): Promise<MaintenanceLease | null>;
  /**
   * Which workspace a run belongs to, by run id alone — the declared exception `runs.ts`
   * documents, kept because `RunStore`'s port identifies a run by id. Returns a workspace id and
   * no row content.
   */
  findRunWorkspace(runId: string): Promise<string | null>;
  /** Ids of runs left `running` or `queued` since before `before` — see `listStaleRunIds`. */
  listStaleRunIds(before: Date, limit?: number): Promise<readonly string[]>;
  /** Ids of `awaiting_approval` runs whose approval deadline is before `before` — see `listExpiredApprovalRunIds`. */
  listExpiredApprovalRunIds(before: Date, limit?: number): Promise<readonly string[]>;
  /**
   * The active browser-token row for a globally-unique hash, before the caller knows which
   * workspace it names — the same exception `findRunWorkspace` is, for the reason
   * `browser_tokens_hash_key` gives one (issue #236, SDK-04, S-1). `null` for a hash that never
   * existed, is revoked, or is expired; the caller re-scopes by the returned `workspaceId` for
   * every query after this one.
   */
  findBrowserTokenByHash(tokenHash: string, now?: Date): Promise<ActiveBrowserToken | null>;
  /**
   * The live OAuth access token for a globally-unique hash, before the caller knows its workspace:
   * the same exception {@link findBrowserTokenByHash} is. `null` for an unknown, revoked or expired
   * token and for one whose endpoint client is revoked.
   */
  findOAuthAccessTokenByHash(tokenHash: string, now?: Date): Promise<ActiveOAuthAccessToken | null>;
  /**
   * The unrevoked endpoint client an OAuth `client_id` names, with the secret hash the token endpoint
   * checks. Unscoped for the same reason: the client id is the only thing the caller sends.
   */
  findOAuthClient(clientId: string): Promise<OAuthClientRecord | null>;
  /**
   * The trigger a fire URL names, with its secret hash, before the caller knows the workspace: the
   * trigger id is the only thing the public ingress receives (ADR-0144 D2). `null` for an unknown id.
   */
  findTriggerForIngress(triggerId: string): Promise<TriggerForIngress | null>;
  /**
   * `aw login`'s approvals and tokens (issue #242, SDK-10, S-22). Unscoped for the reason
   * {@link findBrowserTokenByHash} is: a user code or a token hash names its workspace, not the
   * other way round.
   */
  readonly cliSessions: CliSessionRepository;
  /**
   * Resolve the tenant for a cookie-less public link, by the hash of its token
   * (`hashApiKeySecret`), without exposing any share content.
   */
  findShareWorkspace(tokenHash: string): Promise<string | null>;
  /**
   * The identity a request acts under: the workspace named by the session's slug, the user named
   * by its subject, and a membership joining them. `null` unless all three rows exist.
   */
  resolveMembership(email: string, workspaceSlug: string): Promise<WorkspaceMembership | null>;
  /**
   * The workspace-wide model default (issue #129) — the last rung of the resolution ladder. There
   * is no scoped `WorkspaceRepository`: `workspaces` carries no `workspace_id` of its own (see
   * `schema/workspaces.ts`'s header), so a repository shaped like every other one here would have
   * nothing to scope by. `null` for an unknown workspace and for a known one with no default set
   * alike — the caller cannot tell them apart from this alone, and does not need to: resolution
   * treats both as "this layer supplies nothing" and falls through to the next.
   */
  getWorkspaceModelDefault(
    workspaceId: string,
  ): Promise<{ readonly connectionId: string; readonly model: string } | null>;
  /**
   * Set or clear the workspace-wide model default. `null` clears both columns together;
   * `workspaces_default_model_pair` refuses anything else. `false` means the workspace id does
   * not exist.
   */
  setWorkspaceModelDefault(
    workspaceId: string,
    value: { readonly connectionId: string; readonly model: string } | null,
  ): Promise<boolean>;
  /**
   * The agent first-run setup most recently configured in this workspace (PR #403 review), or
   * `null` when setup never marked one or that agent was deleted.
   */
  getWorkspaceSetupAgentId(workspaceId: string): Promise<string | null>;
  /**
   * Mark `agentId` as the agent first-run setup just configured. `false` when no agent with that id
   * exists in that workspace — another workspace's agent is never marked.
   */
  setWorkspaceSetupAgentId(workspaceId: string, agentId: string): Promise<boolean>;
  /**
   * Take back {@link setWorkspaceSetupAgentId}'s mark on `agentId`, for a setup attempt that is
   * rolled back (issue #415). `false` when no agent with that id exists in that workspace.
   */
  clearWorkspaceSetupAgentId(workspaceId: string, agentId: string): Promise<boolean>;
  /**
   * Run `work` while holding the PostgreSQL advisory lock on `workspaceId`'s first-run setup
   * (issue #415), so two setups of one workspace, in one process or in two replicas, never
   * interleave their writes or roll back each other's rows. The lock is session-level, on a pool
   * client held for the duration, and is released however `work` ends.
   *
   * The wait is bounded: the lock is tried until `waitMs` has passed, and `{ acquired: false }`
   * means another holder kept it that long and `work` never ran.
   */
  withWorkspaceSetupLock<T>(
    workspaceId: string,
    waitMs: number,
    work: () => Promise<T>,
  ): Promise<LockOutcome<T>>;
  /**
   * Run `work` while holding the PostgreSQL advisory lock named `name`, for a job that must run on
   * one server at a time. It tries once and never waits: `{ acquired: false }` means another server
   * holds it and `work` never ran. The lock is session-level, on a pool client held for the
   * duration, and is released however `work` ends.
   */
  withNamedLock<T>(name: string, work: () => Promise<T>): Promise<LockOutcome<T>>;
  /**
   * Append one immutable §36 row without exposing the unscoped database handle. An event that names
   * its `id` is written once: the same id again is a no-op, so a retried write is idempotent.
   */
  recordAuditEvent(event: RootAuditEvent): Promise<void>;
  /** Release every pooled connection. Idempotent. */
  close(): Promise<void>;
}

/**
 * Read the environment, open the pool, prove the connection works, and return the root.
 *
 * Throws — it does not return a degraded root — when `DATABASE_URL` is missing or unusable, or
 * when the server does not answer. The caller decides what an unreachable database means; in
 * `apps/web/instrumentation.ts` it means no seam is installed and every `/api/**` route keeps
 * answering 503 by name.
 *
 * The `select 1` is the ADR-0015 half. `createPool` opens no connection, so without it a
 * `DATABASE_URL` that merely parses — a host that is not there, a database that was never
 * created, credentials that were rotated — would produce a root that looks installed and fails
 * inside the first route handler.
 */
export async function openDatabaseRoot(
  env: Readonly<Record<string, string | undefined>>,
): Promise<DatabaseRoot> {
  const pool = createPool(readDatabaseConfig(env));
  let db: Database;
  try {
    db = createDatabase(pool);
    await pool.query('select 1');
  } catch (error) {
    // The pool is released before the failure propagates: a caller that only ever sees a thrown
    // error has no handle to close, and a leaked pool keeps the process alive on exit.
    await pool.end().catch(() => undefined);
    throw error;
  }

  let closed = false;
  return {
    ...rootRepositories(db),
    ...rootQueries(db),
    ...rootLocks(pool),
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await closePool(pool);
    },
  };
}
