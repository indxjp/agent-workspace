import { and, asc, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  projectFiles,
  projectMcpServers,
  projects,
  runs,
  sessions,
  type NewProject,
  type Project,
} from '../schema/index.js';
import { refuseToolConnectorBindings } from './project-mcp-servers.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';

export type ProjectRecord = Project;
export type CreateProjectInput = Omit<
  NewProject,
  'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'ownerPrincipalId' | 'createdBy'
> & {
  readonly ownerPrincipalId: string;
  readonly createdBy?: string | null;
};
export type UpdateProjectPatch = Partial<
  Pick<
    Project,
    | 'name'
    | 'instructions'
    | 'defaultAgentId'
    | 'visibility'
    // issue #129: written together or not at all — the caller (this task has none in its own
    // Owns globs; a later task's route enforces the pair) is responsible for never sending one
    // without the other, exactly like `defaultAgentId`'s own single-column patch shape.
    | 'defaultModelConnectionId'
    | 'defaultModel'
  >
>;

/**
 * `runs` never duplicates `session_id -> project_id` onto itself (see `../schema/runs.ts`'s
 * header on why `agent_id` is deliberately absent for the same reason), so a completed run's
 * project attribution is reached only through `runs.session_id -> sessions.project_id` — and
 * that column, unlike `sessions.agent_id`, DOES have an update path: `moveSession` below. A move
 * that rewrote `project_id` out from under a session that already has runs would silently change
 * those runs' project attribution after the fact, which issue #125's acceptance criteria forbids
 * ("Edits after a run do not rewrite the run's historical model/project/agent attribution") and
 * the card's own Verifier attack #3 checks for directly. Rather than add a `runs.project_id`
 * snapshot column (a schema change; deferred — see `docs/adr/W9-PROJ-125-*.md` §5), `moveSession`
 * refuses the move outright once any run exists for the session: the session simply never moves,
 * so there is nothing for a later read to get wrong.
 */
type MoveSessionOutcome =
  { readonly kind: 'moved' } | { readonly kind: 'not-found' } | { readonly kind: 'has-runs' };

/**
 * Which lifecycle slice {@link ProjectRepository.list} returns (issue #182).
 *
 * A named union rather than an `includeArchived` boolean: a bare `true` at a call site says
 * nothing about what it includes, and a boolean cannot express "archived only", which the
 * history-oriented callers this state exists for need.
 */
export type ProjectListFilter = 'active' | 'archived' | 'all';

export interface ProjectRepository {
  /**
   * Projects in this workspace, oldest first.
   *
   * The default is `'active'` — archived projects are excluded unless a caller asks for them.
   * Note the deliberate divergence from `SessionRepository.list()`, where no argument means *every*
   * status: issue #182 requires that a default project listing exclude archived projects at the
   * repository contract, and the route that reads this (`apps/web/app/api/projects/route.ts`) is
   * not this task's to change. See `docs/adr/W9-PROJ-182-*.md`.
   */
  list(filter?: ProjectListFilter): Promise<readonly ProjectRecord[]>;
  /** One project by id, archived or not — history stays readable. `null` if it is not in scope. */
  get(id: string): Promise<ProjectRecord | null>;
  create(input: CreateProjectInput): Promise<ProjectRecord>;
  createWithAssociations(
    input: CreateProjectInput,
    fileIds: readonly string[],
    mcpServerIds: readonly string[],
  ): Promise<ProjectRecord>;
  update(id: string, patch: UpdateProjectPatch): Promise<ProjectRecord | null>;
  updateWithAssociations(
    id: string,
    patch: UpdateProjectPatch,
    fileIds?: readonly string[],
    mcpServerIds?: readonly string[],
  ): Promise<ProjectRecord | null>;
  moveSession(projectId: string, sessionId: string): Promise<MoveSessionOutcome>;
  /**
   * Set `archivedAt` to now, unless it is already set (idempotent: archiving twice keeps the first
   * timestamp rather than moving it forward). `null` if `id` names no project in this workspace.
   *
   * Non-destructive by construction: no row is deleted and `sessions.project_id` is not touched,
   * so every session and run stays attributed to the same project across the transition. Together
   * with {@link restore} this is the only writer of the column — `update` cannot reach it, because
   * {@link UpdateProjectPatch} deliberately omits it.
   */
  archive(id: string): Promise<ProjectRecord | null>;
  /**
   * Clear `archivedAt`. Idempotent on an already-active project (it stays `null` and the row is
   * still returned). `null` if `id` names no project in this workspace.
   */
  restore(id: string): Promise<ProjectRecord | null>;
}

/** The lifecycle predicate for one project row, expressed once (`isWorkspaceArchived`'s shape). */
export function isProjectArchived(project: Pick<ProjectRecord, 'archivedAt'>): boolean {
  return project.archivedAt !== null;
}

/** The `archivedAt` predicate each {@link ProjectListFilter} adds on top of the tenant scope. */
function archivedPredicate(filter: ProjectListFilter): SQL | undefined {
  switch (filter) {
    case 'active':
      return isNull(projects.archivedAt);
    case 'archived':
      return isNotNull(projects.archivedAt);
    case 'all':
      return undefined;
  }
}
export interface ProjectRepositoryProvider {
  forScope(scope: WorkspaceScope): ProjectRepository;
}

export function createDatabaseProjectRepositoryProvider(db: Database): ProjectRepositoryProvider {
  return {
    forScope(scope) {
      const { workspaceId } = requireWorkspaceScope(scope, 'ProjectRepositoryProvider');
      return {
        list: (filter = 'active') =>
          db
            .select()
            .from(projects)
            .where(and(eq(projects.workspaceId, workspaceId), archivedPredicate(filter)))
            .orderBy(asc(projects.createdAt), asc(projects.id)),
        async get(id) {
          return (
            (
              await db
                .select()
                .from(projects)
                .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, id)))
                .limit(1)
            )[0] ?? null
          );
        },
        async create(input) {
          return (
            await db
              .insert(projects)
              .values({ ...input, workspaceId, createdBy: input.createdBy ?? null })
              .returning()
          )[0]!;
        },
        async createWithAssociations(input, fileIds, mcpServerIds) {
          return db.transaction(async (tx) => {
            const created = (
              await tx
                .insert(projects)
                .values({ ...input, workspaceId, createdBy: input.createdBy ?? null })
                .returning()
            )[0];
            if (created === undefined) throw new Error('project insert returned no row');
            await refuseToolConnectorBindings(tx, workspaceId, mcpServerIds);
            if (fileIds.length > 0)
              await tx
                .insert(projectFiles)
                .values(fileIds.map((fileId) => ({ workspaceId, projectId: created.id, fileId })));
            if (mcpServerIds.length > 0)
              await tx.insert(projectMcpServers).values(
                mcpServerIds.map((mcpServerId) => ({
                  workspaceId,
                  projectId: created.id,
                  mcpServerId,
                })),
              );
            return created;
          });
        },
        async update(id, patch) {
          return (
            (
              await db
                .update(projects)
                .set(patch)
                .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, id)))
                .returning()
            )[0] ?? null
          );
        },
        async updateWithAssociations(id, patch, fileIds, mcpServerIds) {
          return db.transaction(async (tx) => {
            const existing = (
              await tx
                .select()
                .from(projects)
                .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, id)))
                .limit(1)
            )[0];
            if (existing === undefined) return null;
            const updated =
              Object.keys(patch).length === 0
                ? existing
                : (
                    await tx
                      .update(projects)
                      .set(patch)
                      .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, id)))
                      .returning()
                  )[0];
            if (updated === undefined) throw new Error('project update returned no row');
            if (fileIds !== undefined) {
              await tx
                .delete(projectFiles)
                .where(
                  and(eq(projectFiles.workspaceId, workspaceId), eq(projectFiles.projectId, id)),
                );
              if (fileIds.length > 0)
                await tx
                  .insert(projectFiles)
                  .values(fileIds.map((fileId) => ({ workspaceId, projectId: id, fileId })));
            }
            if (mcpServerIds !== undefined) {
              await refuseToolConnectorBindings(tx, workspaceId, mcpServerIds);
              await tx
                .delete(projectMcpServers)
                .where(
                  and(
                    eq(projectMcpServers.workspaceId, workspaceId),
                    eq(projectMcpServers.projectId, id),
                  ),
                );
              if (mcpServerIds.length > 0)
                await tx.insert(projectMcpServers).values(
                  mcpServerIds.map((mcpServerId) => ({
                    workspaceId,
                    projectId: id,
                    mcpServerId,
                  })),
                );
            }
            return updated;
          });
        },
        async moveSession(projectId, sessionId) {
          const project = await this.get(projectId);
          if (!project) return { kind: 'not-found' };
          // Refuse the move outright once the session has any run: see `MoveSessionOutcome`'s
          // own doc comment for why this, and not a rewrite, is what keeps a run's project
          // attribution historical.
          return db.transaction(async (tx) => {
            await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${sessionId}, 1))`);
            const existingRun = (
              await tx
                .select({ id: runs.id })
                .from(runs)
                .where(and(eq(runs.workspaceId, workspaceId), eq(runs.sessionId, sessionId)))
                .limit(1)
            )[0];
            if (existingRun !== undefined) return { kind: 'has-runs' };
            const moved = (
              await tx
                .update(sessions)
                .set({ projectId })
                .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.id, sessionId)))
                .returning({ id: sessions.id })
            )[0];
            return moved !== undefined ? { kind: 'moved' } : { kind: 'not-found' };
          });
        },
        async archive(id) {
          return (
            (
              await db
                .update(projects)
                // `coalesce` rather than a bare `now()`: archiving an already-archived project
                // keeps the moment it was first archived, which is what makes a repeated call a
                // no-op for `archived_at` instead of a silently rewritten timestamp. Note that
                // `updated_at` is still bumped by its `$onUpdate`, so the row is not untouched.
                .set({ archivedAt: sql`coalesce(${projects.archivedAt}, now())` })
                .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, id)))
                .returning()
            )[0] ?? null
          );
        },
        async restore(id) {
          return (
            (
              await db
                .update(projects)
                .set({ archivedAt: null })
                .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, id)))
                .returning()
            )[0] ?? null
          );
        },
      };
    },
  };
}
