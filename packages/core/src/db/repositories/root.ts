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
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';

import {
  closePool,
  createDatabase,
  createPool,
  readDatabaseConfig,
  type Database,
} from '../client.js';
import { agents } from '../schema/agents.js';
import { auditEvents, type NewAuditEvent } from '../schema/audit-events.js';
import { workspaces } from '../schema/workspaces.js';
import {
  createDatabaseAuditEventRepositoryProvider,
  type AuditEventRepositoryProvider,
} from './audit-events.js';
import { createDatabaseAgentRepositoryProvider, type AgentRepositoryProvider } from './agents.js';
import {
  createDatabaseAgentGrantRepositoryProvider,
  type AgentGrantRepositoryProvider,
} from './agent-grants.js';
import {
  createDatabaseResourceCatalogRepositoryProvider,
  type ResourceCatalogRepositoryProvider,
} from './resource-catalogs.js';
import {
  createDatabaseAgentResourceRepositoryProvider,
  type AgentResourceRepositoryProvider,
} from './agent-resources.js';
import {
  createDatabaseAgentVersionRepositoryProvider,
  type AgentVersionRepositoryProvider,
} from './agent-versions.js';
import { createDatabaseDirectoryRoot, type DatabaseDirectoryRoot } from './directory.js';
import {
  createDatabaseProjectFileRepositoryProvider,
  type ProjectFileRepositoryProvider,
} from './project-files.js';
import {
  createDatabaseProjectMcpServerRepositoryProvider,
  type ProjectMcpServerRepositoryProvider,
} from './project-mcp-servers.js';
import {
  createDatabaseProjectRepositoryProvider,
  type ProjectRepositoryProvider,
} from './projects.js';
import {
  createDatabaseShareRepositoryProvider,
  createDatabaseShareViewRepositoryProvider,
  type ShareRepositoryProvider,
  type ShareViewRepositoryProvider,
} from './shares.js';
import {
  createDatabaseMcpServerRepositoryProvider,
  type McpServerRepositoryProvider,
} from './mcp-servers.js';
import {
  createDatabaseModelConnectionRepositoryProvider,
  type ModelConnectionRepositoryProvider,
} from './model-connections.js';
import {
  createDatabaseRunRepositoryProvider,
  createDatabaseRunEventRepositoryProvider,
  createDatabaseSessionRepositoryProvider,
  findRunWorkspace,
  listStaleRunIds,
  type RunRepositoryProvider,
  type RunEventRepositoryProvider,
  type SessionRepositoryProvider,
} from './runs.js';
import {
  createDatabaseRunTokenRepositoryProvider,
  type RunTokenRepositoryProvider,
} from './run-tokens.js';
import {
  createDatabaseRunFeedbackRepositoryProvider,
  type RunFeedbackRepositoryProvider,
} from './run-feedback.js';
import {
  createDatabaseEndpointClientRepositoryProvider,
  type EndpointClientRepositoryProvider,
} from './endpoint-clients.js';
import {
  createDatabaseAgentVersionEvaluationRepositoryProvider,
  type AgentVersionEvaluationRepositoryProvider,
} from './agent-version-evaluations.js';
import {
  createDatabaseBrowserTokenRepositoryProvider,
  findActiveBrowserTokenByHash,
  type ActiveBrowserToken,
  type BrowserTokenRepositoryProvider,
} from './browser-tokens.js';
import {
  createDatabaseOAuthTokenRepositoryProvider,
  findActiveOAuthAccessToken,
  findOAuthClient,
  type ActiveOAuthAccessToken,
  type OAuthClientRecord,
  type OAuthTokenRepositoryProvider,
} from './oauth-tokens.js';
import {
  createDatabaseRuntimeVerificationRepositoryProvider,
  type RuntimeVerificationRepositoryProvider,
} from './runtime-verifications.js';
import {
  createDatabaseSurfaceSessionKeyRepositoryProvider,
  type SurfaceSessionKeyRepositoryProvider,
} from './surface-session-keys.js';
import { createDatabaseCliSessionRepository, type CliSessionRepository } from './cli-sessions.js';
import {
  createDatabaseSessionTranscriptRepositoryProvider,
  type SessionTranscriptRepositoryProvider,
} from './session-transcripts.js';
import {
  createDatabaseSessionStateRepositoryProvider,
  type SessionStateRepositoryProvider,
} from './session-state.js';
// Added by W3-CP-06, outside this task's `Owns` cell — declared on its PR (see
// `docs/adr/W3-CP-06-a-profile-reference-not-a-copy-and-the-integrator-call.md`). This file is the
// only place `apps/web`'s composition root can obtain a scope-bound runtime-profile repository
// without a raw `Database` handle, which `@agent-workspace/core/db` deliberately does not hand out.
import {
  createDatabaseRuntimeProfileRepositoryProvider,
  type RuntimeProfileRepositoryProvider,
} from './runtime-profiles.js';
import { createDatabaseWorkspaceScopeResolver, type WorkspaceScopeResolver } from './scope.js';
import { createDatabaseWorkspaceRepository, type WorkspaceRepository } from './workspaces.js';

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
  readonly role: 'owner' | 'admin' | 'builder' | 'viewer';
}

interface MaintenanceLease {
  release(): Promise<void>;
}

/** What {@link DatabaseRoot.withWorkspaceSetupLock} answers. */
type WorkspaceSetupLockOutcome<T> =
  { readonly acquired: true; readonly value: T } | { readonly acquired: false };

/** How long a waiter sleeps between two tries of the setup lock: short at first, then capped. */
const SETUP_LOCK_RETRY_MS = [25, 50, 100, 200, 250] as const;

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
  readonly resourceCatalogs: ResourceCatalogRepositoryProvider;
  /** Run rows, for one scope at a time. */
  readonly runs: RunRepositoryProvider;
  /** Replayable SSE events, retained durably and scoped to the run's workspace. */
  readonly runEvents: RunEventRepositoryProvider;
  /** Issued gateway-token digests and revocation state, scoped by workspace and run. */
  readonly runTokens: RunTokenRepositoryProvider;
  /** Append-only thumbs up/down on a run, scoped by workspace (issue #539, C19). */
  readonly runFeedback: RunFeedbackRepositoryProvider;
  readonly endpointClients: EndpointClientRepositoryProvider;
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
   * `aw login`'s approvals and tokens (issue #242, SDK-10, S-22). Unscoped for the reason
   * {@link findBrowserTokenByHash} is: a user code or a token hash names its workspace, not the
   * other way round.
   */
  readonly cliSessions: CliSessionRepository;
  /** Resolve the tenant for a cookie-less public token without exposing any share content. */
  findShareWorkspace(token: string): Promise<string | null>;
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
  ): Promise<WorkspaceSetupLockOutcome<T>>;
  /** Append one immutable §36 row without exposing the unscoped database handle. */
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
  env: Readonly<Record<string, string | undefined>> = process.env,
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

  const scopes = createDatabaseWorkspaceScopeResolver(db);
  let closed = false;
  return {
    scopes,
    agents: createDatabaseAgentRepositoryProvider(db),
    agentGrants: createDatabaseAgentGrantRepositoryProvider(db),
    agentResources: createDatabaseAgentResourceRepositoryProvider(db),
    agentVersions: createDatabaseAgentVersionRepositoryProvider(db),
    resourceCatalogs: createDatabaseResourceCatalogRepositoryProvider(db),
    runs: createDatabaseRunRepositoryProvider(db),
    runEvents: createDatabaseRunEventRepositoryProvider(db),
    runTokens: createDatabaseRunTokenRepositoryProvider(db),
    runFeedback: createDatabaseRunFeedbackRepositoryProvider(db),
    endpointClients: createDatabaseEndpointClientRepositoryProvider(db),
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
    runtimeProfiles: createDatabaseRuntimeProfileRepositoryProvider(db),
    projects: createDatabaseProjectRepositoryProvider(db),
    projectFiles: createDatabaseProjectFileRepositoryProvider(db),
    projectMcpServers: createDatabaseProjectMcpServerRepositoryProvider(db),
    shares: createDatabaseShareRepositoryProvider(db),
    shareViews: createDatabaseShareViewRepositoryProvider(db),
    auditEventRepository: createDatabaseAuditEventRepositoryProvider(db),
    directory: createDatabaseDirectoryRoot(db),
    workspaces: createDatabaseWorkspaceRepository(db),
    listWorkspaceIds: async (): Promise<readonly string[]> =>
      (await db.query.workspaces.findMany({ columns: { id: true } })).map(({ id }) => id),
    tryAcquireMaintenanceLease: async (
      name: string,
      ttlMs: number,
    ): Promise<MaintenanceLease | null> => {
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
        throw new Error('maintenance lease TTL must be a positive safe integer');
      }
      const client = await pool.connect();
      const acquired = await client.query<{ acquired: boolean }>(
        'select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired',
        [name],
      );
      if (acquired.rows[0]?.acquired !== true) {
        client.release();
        return null;
      }
      let released = false;
      const release = async (): Promise<void> => {
        if (released) return;
        released = true;
        clearTimeout(expiry);
        try {
          await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [name]);
        } finally {
          client.release();
        }
      };
      const expiry = setTimeout(() => void release(), ttlMs);
      expiry.unref();
      return { release };
    },
    findRunWorkspace: (runId: string): Promise<string | null> => findRunWorkspace(db, runId),
    listStaleRunIds: (before: Date, limit?: number): Promise<readonly string[]> =>
      listStaleRunIds(db, before, limit),
    findBrowserTokenByHash: (tokenHash: string, now?: Date): Promise<ActiveBrowserToken | null> =>
      findActiveBrowserTokenByHash(db, tokenHash, now),
    findOAuthAccessTokenByHash: (
      tokenHash: string,
      now?: Date,
    ): Promise<ActiveOAuthAccessToken | null> => findActiveOAuthAccessToken(db, tokenHash, now),
    findOAuthClient: (clientId: string): Promise<OAuthClientRecord | null> =>
      findOAuthClient(db, clientId),
    cliSessions: createDatabaseCliSessionRepository(db),
    findShareWorkspace: async (token: string): Promise<string | null> =>
      (
        await db.query.shares.findFirst({
          columns: { workspaceId: true },
          // This unscoped lookup is used only by the anonymous /p surface. Workspace/private
          // shares must never disclose even which tenant owns their otherwise-valid token.
          where: (row, { and, eq }) => and(eq(row.token, token), eq(row.visibility, 'public')),
        })
      )?.workspaceId ?? null,
    resolveMembership: async (
      email: string,
      workspaceSlug: string,
    ): Promise<WorkspaceMembership | null> => {
      const workspace = await db.query.workspaces.findFirst({
        columns: { id: true },
        where: (row, { eq }) => eq(row.slug, workspaceSlug),
      });
      if (workspace === undefined) return null;

      const user = await db.query.users.findFirst({
        columns: { id: true, name: true },
        where: (row, { eq }) => eq(row.email, email),
      });
      if (user === undefined) return null;

      const membership = await db.query.memberships.findFirst({
        columns: { id: true, role: true },
        where: (row, { and, eq }) =>
          and(eq(row.workspaceId, workspace.id), eq(row.userId, user.id)),
      });
      // The explicit else. An identity exists because three rows were read and agreed, never
      // because nothing objected (ADR-0015).
      if (membership === undefined) return null;

      const principal = await db.query.workspacePrincipals.findFirst({
        columns: { id: true },
        where: (row, { and, eq, isNull }) =>
          and(
            eq(row.workspaceId, workspace.id),
            eq(row.membershipId, membership.id),
            eq(row.kind, 'membership'),
            isNull(row.revokedAt),
          ),
      });
      if (principal === undefined) return null;

      return {
        principalId: principal.id,
        userId: user.id,
        userLabel: user.name,
        workspaceId: workspace.id,
        role: membership.role,
      };
    },
    async getWorkspaceModelDefault(
      workspaceId: string,
    ): Promise<{ readonly connectionId: string; readonly model: string } | null> {
      const row = await db.query.workspaces.findFirst({
        columns: { defaultModelConnectionId: true, defaultModel: true },
        where: (candidate, { eq: matches }) => matches(candidate.id, workspaceId),
      });
      if (row === undefined || row.defaultModelConnectionId === null || row.defaultModel === null) {
        return null;
      }
      return { connectionId: row.defaultModelConnectionId, model: row.defaultModel };
    },
    async setWorkspaceModelDefault(
      workspaceId: string,
      value: { readonly connectionId: string; readonly model: string } | null,
    ): Promise<boolean> {
      const rows = await db
        .update(workspaces)
        .set({
          defaultModelConnectionId: value === null ? null : value.connectionId,
          defaultModel: value === null ? null : value.model,
        })
        .where(eq(workspaces.id, workspaceId))
        .returning({ id: workspaces.id });
      return rows.length > 0;
    },
    async getWorkspaceSetupAgentId(workspaceId: string): Promise<string | null> {
      const [row] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.workspaceId, workspaceId), isNotNull(agents.setupConfiguredAt)))
        .orderBy(desc(agents.setupConfiguredAt))
        .limit(1);
      return row?.id ?? null;
    },
    // `updated_at` is set to itself, overriding Drizzle's `$onUpdate`, and `materialised_version_id`
    // is left alone: marking or clearing the setup agent is not an edit (C21, plan §4).
    async setWorkspaceSetupAgentId(workspaceId: string, agentId: string): Promise<boolean> {
      const rows = await db
        .update(agents)
        .set({ setupConfiguredAt: new Date(), updatedAt: sql`${agents.updatedAt}` })
        .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)))
        .returning({ id: agents.id });
      return rows.length > 0;
    },
    async clearWorkspaceSetupAgentId(workspaceId: string, agentId: string): Promise<boolean> {
      const rows = await db
        .update(agents)
        .set({ setupConfiguredAt: null, updatedAt: sql`${agents.updatedAt}` })
        .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)))
        .returning({ id: agents.id });
      return rows.length > 0;
    },
    async withWorkspaceSetupLock<T>(
      workspaceId: string,
      waitMs: number,
      work: () => Promise<T>,
    ): Promise<WorkspaceSetupLockOutcome<T>> {
      const key = `agent-workspace:setup:${workspaceId}`;
      const deadline = Date.now() + Math.max(0, waitMs);
      const client = await pool.connect();
      // Only a client whose unlock failed may still hold the lock; it is destroyed, not pooled.
      let unlockFailure: Error | undefined;
      try {
        for (let attempt = 0; ; attempt += 1) {
          const tried = await client.query<{ acquired: boolean }>(
            'select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired',
            [key],
          );
          if (tried.rows[0]?.acquired === true) break;
          const remaining = deadline - Date.now();
          if (remaining <= 0) return { acquired: false };
          const pause = SETUP_LOCK_RETRY_MS[Math.min(attempt, SETUP_LOCK_RETRY_MS.length - 1)];
          await new Promise((resolve) => setTimeout(resolve, Math.min(pause ?? 250, remaining)));
        }
        try {
          return { acquired: true, value: await work() };
        } finally {
          await client
            .query('select pg_advisory_unlock(hashtextextended($1, 0))', [key])
            .catch((error: unknown) => {
              unlockFailure = error instanceof Error ? error : new Error(String(error));
            });
        }
      } finally {
        client.release(unlockFailure);
      }
    },
    async recordAuditEvent(event: RootAuditEvent): Promise<void> {
      await db.insert(auditEvents).values(event);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await closePool(pool);
    },
  };
}
