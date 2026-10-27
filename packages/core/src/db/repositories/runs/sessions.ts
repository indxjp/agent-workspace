import { desc, eq, notExists, sql, type SQL } from 'drizzle-orm';

import type { Database } from '../../client.js';
import type { EngineId } from '../../schema/agents.js';
import { runs } from '../../schema/runs.js';
import { type SessionStatus, sessions } from '../../schema/sessions.js';
import type { SessionRecord } from './types.js';
import {
  afterPosition,
  assertPageLimit,
  keysetTimestamp,
  toKeysetPage,
  type KeysetPage,
  type KeysetPosition,
} from '../keyset.js';
import { requireWorkspaceScope, type WorkspaceScope } from '../scope.js';
import {
  FOREIGN_KEY_VIOLATION,
  SESSION_AGENT_CONSTRAINT,
  SESSION_MEMBER_CONSTRAINT,
  SESSION_OWNER_CONSTRAINT,
  SESSION_PRIMARY_KEY,
  UNIQUE_VIOLATION,
  UUID_PATTERN,
  every,
  violatedBy,
} from './rows.js';

/** Everything creating a session row supplies. The workspace comes from the scope. */
export interface EnsureSessionInput {
  readonly id: string;
  readonly agentId: string;
  readonly ownerPrincipalId: string;
  readonly userId?: string | null;
  readonly projectId?: string | null;
  readonly title?: string | null;
  /**
   * The agent version to pin, written only when this call inserts the row: an `existing` session
   * keeps the version it started on (#612). A version of another agent or workspace is refused by
   * `sessions_agent_version_fk` and re-thrown.
   */
  readonly agentVersionId?: string | null;
}

/**
 * The engine's identity for a session: the id it reported and the engine that reported it. One
 * value, so neither half can be written without the other — a reported id always names its engine
 * (ADR-0065), which is the invariant migration 0025 establishes for rows written before this type.
 */
interface SessionEngineIdentity {
  readonly engineSessionId: string;
  readonly engine: EngineId;
}

export interface UpdateSessionInput {
  readonly title?: string | null;
  readonly projectId?: string | null;
  readonly engineIdentity?: SessionEngineIdentity;
}

export type SessionMutationOutcome =
  | { readonly kind: 'updated'; readonly session: SessionRecord }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'no-op'; readonly session: SessionRecord };

/**
 * What ensuring a session row can produce.
 *
 * `existing` and `created` are kept apart even though both mean "the row is there now": a caller
 * resuming a session and a caller starting one are different requests, and W2-CP-07 needs to be
 * able to tell them apart without a second query.
 */
export type EnsureSessionOutcome =
  | { readonly kind: 'created'; readonly session: SessionRecord }
  | { readonly kind: 'existing'; readonly session: SessionRecord }
  | { readonly kind: 'unknown-agent'; readonly agentId: string }
  | { readonly kind: 'not-a-member'; readonly userId: string }
  | { readonly kind: 'unknown-principal'; readonly principalId: string };

/**
 * Which of the workspace's sessions a list may return. Pushed into the query rather than applied
 * to its result, so a page is always full and its boundary is a row the caller may see.
 */
export type SessionVisibility =
  /** Owner and Admin oversight: every session in the workspace. */
  | { readonly kind: 'all' }
  /** Everyone else: the sessions owned by exactly this durable principal. */
  | { readonly kind: 'owner'; readonly principalId: string }
  /** A runner: only the one session its signed per-run claim names, by the engine's id. */
  | { readonly kind: 'engine-session'; readonly engineSessionId: string };

/** The largest page {@link SessionRepository.list} serves. */
const MAX_SESSION_LIST_LIMIT = 200;

interface SessionListInput {
  readonly visibility: SessionVisibility;
  readonly status?: SessionStatus;
  /** Rows per page, 1–{@link MAX_SESSION_LIST_LIMIT}; omitted for every remaining row. */
  readonly limit?: number;
  /** The previous page's `nextCursor`; omitted or `null` for the newest rows. */
  readonly cursor?: KeysetPosition | null;
}

/** Session-row persistence for exactly one workspace. See this file's header for its limits. */
export interface SessionRepository {
  ensure(input: EnsureSessionInput): Promise<EnsureSessionOutcome>;
  get(sessionId: string): Promise<SessionRecord | null>;
  getByEngineSessionId(engineSessionId: string): Promise<SessionRecord | null>;
  /**
   * Newest first by the immutable `(created_at, id)`, never by `updated_at`: a rename or a run
   * moves `updated_at`, and a row that moved while a caller paged would be skipped or seen twice.
   */
  list(input: SessionListInput): Promise<KeysetPage<SessionRecord>>;
  update(sessionId: string, input: UpdateSessionInput): Promise<SessionMutationOutcome>;
  archive(sessionId: string): Promise<SessionMutationOutcome>;
  restore(sessionId: string): Promise<SessionMutationOutcome>;
  /**
   * Delete a session that has no run, and report whether a row went. A run's `session_id` cascades,
   * so an unconditional delete could destroy a run whose insert committed even though its caller
   * saw a failure; a session holding any run is kept. Meant for the session a failed start opened.
   */
  discardIfUnused(sessionId: string): Promise<boolean>;
}

export interface SessionRepositoryProvider {
  forScope(scope: WorkspaceScope): SessionRepository;
}

/** The columns a session read selects. */
const SESSION_COLUMNS = {
  id: sessions.id,
  workspaceId: sessions.workspaceId,
  agentId: sessions.agentId,
  userId: sessions.userId,
  ownerPrincipalId: sessions.ownerPrincipalId,
  projectId: sessions.projectId,
  engineSessionId: sessions.engineSessionId,
  engine: sessions.engine,
  agentVersionId: sessions.agentVersionId,
  title: sessions.title,
  status: sessions.status,
  createdAt: sessions.createdAt,
  updatedAt: sessions.updatedAt,
} as const;

/** The PostgreSQL {@link SessionRepositoryProvider}. See this file's header for its narrow remit. */
export function createDatabaseSessionRepositoryProvider(db: Database): SessionRepositoryProvider {
  return {
    forScope(scope: WorkspaceScope): SessionRepository {
      // The run-time half of the scope gate, before any predicate is built. See `./scope.ts`.
      const checked = requireWorkspaceScope(scope, 'SessionRepositoryProvider');
      const tenant = eq(sessions.workspaceId, checked.workspaceId);

      const read = async (sessionId: string): Promise<SessionRecord | null> => {
        const rows = await db
          .select(SESSION_COLUMNS)
          .from(sessions)
          .where(every(tenant, eq(sessions.id, sessionId)))
          .limit(1);
        return rows[0] ?? null;
      };

      return {
        get: read,

        async getByEngineSessionId(engineSessionId): Promise<SessionRecord | null> {
          const rows = await db
            .select(SESSION_COLUMNS)
            .from(sessions)
            .where(every(tenant, eq(sessions.engineSessionId, engineSessionId)))
            .limit(1);
          return rows[0] ?? null;
        },

        async list(input): Promise<KeysetPage<SessionRecord>> {
          if (input.limit !== undefined) {
            assertPageLimit(input.limit, MAX_SESSION_LIST_LIMIT, 'session list');
          }
          const predicates: SQL[] = [tenant];
          if (input.status !== undefined) predicates.push(eq(sessions.status, input.status));
          const visibility = input.visibility;
          if (visibility.kind === 'owner') {
            predicates.push(eq(sessions.ownerPrincipalId, visibility.principalId));
          } else if (visibility.kind === 'engine-session') {
            predicates.push(eq(sessions.engineSessionId, visibility.engineSessionId));
          }
          if (input.cursor !== undefined && input.cursor !== null) {
            predicates.push(afterPosition(sessions.createdAt, sessions.id, input.cursor));
          }
          const query = db
            .select({ session: SESSION_COLUMNS, cursorAt: keysetTimestamp(sessions.createdAt) })
            .from(sessions)
            .where(every(...predicates))
            .orderBy(desc(sessions.createdAt), desc(sessions.id));
          const rows = await (input.limit === undefined ? query : query.limit(input.limit + 1));
          return toKeysetPage(rows, input.limit, (row) => row.session);
        },

        async ensure(input: EnsureSessionInput): Promise<EnsureSessionOutcome> {
          const already = await read(input.id);
          if (already !== null) return { kind: 'existing', session: already };
          try {
            const rows = await db
              .insert(sessions)
              .values({
                id: input.id,
                workspaceId: checked.workspaceId,
                userId: input.userId ?? null,
                ownerPrincipalId: input.ownerPrincipalId,
                agentId: input.agentId,
                projectId: input.projectId ?? null,
                title: input.title ?? null,
                agentVersionId: input.agentVersionId ?? null,
              })
              .returning(SESSION_COLUMNS);
            const row = rows[0];
            if (row === undefined) throw new Error('the insert returned no row');
            return { kind: 'created', session: row };
          } catch (error) {
            if (violatedBy(error, UNIQUE_VIOLATION, SESSION_PRIMARY_KEY)) {
              // Someone else inserted it between the read above and this insert. The row exists,
              // which is what `ensure` promises; re-read it rather than reporting a failure.
              const raced = await read(input.id);
              if (raced !== null) return { kind: 'existing', session: raced };
              throw error;
            }
            if (violatedBy(error, FOREIGN_KEY_VIOLATION, SESSION_AGENT_CONSTRAINT)) {
              return { kind: 'unknown-agent', agentId: input.agentId };
            }
            if (violatedBy(error, FOREIGN_KEY_VIOLATION, SESSION_MEMBER_CONSTRAINT)) {
              if (input.userId === undefined || input.userId === null) throw error;
              return { kind: 'not-a-member', userId: input.userId };
            }
            if (violatedBy(error, FOREIGN_KEY_VIOLATION, SESSION_OWNER_CONSTRAINT)) {
              return { kind: 'unknown-principal', principalId: input.ownerPrincipalId };
            }
            throw error;
          }
        },

        async update(sessionId, input): Promise<SessionMutationOutcome> {
          const changes: {
            title?: string | null;
            projectId?: string | null;
            engineSessionId?: string | null;
            engine?: EngineId | null;
            updatedAt?: ReturnType<typeof sql>;
          } = {};
          if (input.title !== undefined) changes.title = input.title;
          if (input.projectId !== undefined) changes.projectId = input.projectId;
          if (input.engineIdentity !== undefined) {
            changes.engineSessionId = input.engineIdentity.engineSessionId;
            changes.engine = input.engineIdentity.engine;
          }
          if (Object.keys(changes).length === 0) {
            const current = await read(sessionId);
            return current === null ? { kind: 'not-found' } : { kind: 'no-op', session: current };
          }
          changes.updatedAt = sql`now()`;
          const rows = await db
            .update(sessions)
            .set(changes)
            .where(every(tenant, eq(sessions.id, sessionId)))
            .returning(SESSION_COLUMNS);
          const row = rows[0];
          return row === undefined ? { kind: 'not-found' } : { kind: 'updated', session: row };
        },

        async archive(sessionId): Promise<SessionMutationOutcome> {
          const rows = await db
            .update(sessions)
            .set({ status: 'archived', updatedAt: sql`now()` })
            .where(every(tenant, eq(sessions.id, sessionId), eq(sessions.status, 'active')))
            .returning(SESSION_COLUMNS);
          const row = rows[0];
          if (row !== undefined) return { kind: 'updated', session: row };
          const current = await read(sessionId);
          return current === null ? { kind: 'not-found' } : { kind: 'no-op', session: current };
        },

        async discardIfUnused(sessionId): Promise<boolean> {
          if (!UUID_PATTERN.test(sessionId)) return false;
          const rows = await db
            .delete(sessions)
            .where(
              every(
                tenant,
                eq(sessions.id, sessionId),
                notExists(
                  db
                    .select({ one: sql`1` })
                    .from(runs)
                    .where(eq(runs.sessionId, sessions.id)),
                ),
              ),
            )
            .returning({ id: sessions.id });
          return rows.length > 0;
        },

        async restore(sessionId): Promise<SessionMutationOutcome> {
          const rows = await db
            .update(sessions)
            .set({ status: 'active', updatedAt: sql`now()` })
            .where(every(tenant, eq(sessions.id, sessionId), eq(sessions.status, 'archived')))
            .returning(SESSION_COLUMNS);
          const row = rows[0];
          if (row !== undefined) return { kind: 'updated', session: row };
          const current = await read(sessionId);
          return current === null ? { kind: 'not-found' } : { kind: 'no-op', session: current };
        },
      };
    },
  };
}
