/**
 * The projects domain's persistence port — the one module of `apps/web/server/projects` that names
 * `@agent-workspace/core/db` (F-08, W3-5). The routes, the lifecycle handler and the archive gate
 * depend on the narrow views declared here; the composition root
 * (`../composition/wiring/projects.ts`) hands the tenant-scoped repositories in, which satisfy them
 * structurally. Copies the shape of `../sessions/store.ts`.
 */
import {
  isProjectArchived,
  type AgentRepository,
  type AgentVersionRepository,
  type AuditEventRepository,
  type ProjectFileRepository,
  type ProjectListFilter,
  type ProjectMcpServerRepository,
  type ProjectRecord,
  type ProjectRepository,
  type SessionRepository,
} from '@agent-workspace/core/db';

/** The project row the routes render, and the `?archived=` list filter. */
export type { ProjectListFilter, ProjectRecord };

/** The one lifecycle predicate the domain shares with the repository that sets `archivedAt`. */
export { isProjectArchived };

/** The project-row operations `/api/projects/**` perform inside one workspace. */
export type ProjectRows = Pick<
  ProjectRepository,
  | 'get'
  | 'list'
  | 'createWithAssociations'
  | 'updateWithAssociations'
  | 'archive'
  | 'restore'
  | 'moveSession'
>;

/** The session-row operations `POST /api/projects/:id/sessions` performs. */
export type ProjectSessionRows = Pick<SessionRepository, 'get' | 'ensure'>;

/** The port: everything one workspace's project routes read or write. */
export interface ProjectsWorkspaceStore {
  readonly projects: ProjectRows;
  readonly files: Pick<ProjectFileRepository, 'list'>;
  readonly mcpServers: Pick<ProjectMcpServerRepository, 'list'>;
  readonly audit: Pick<AuditEventRepository, 'write'>;
  /**
   * issue #125: `POST /api/projects/:id/sessions`'s "start a session" branch resolves
   * `defaultAgentId` against this (the same workspace-scoped lookup every other agent read in
   * this repository uses) before persisting it.
   */
  readonly agents: Pick<AgentRepository, 'get'>;
  /** issue #125: where the resolved agent is persisted, once, at session creation. */
  readonly sessions: ProjectSessionRows;
  /** issue #612: the agent's pointers, so a new session pins the version `local` points at. */
  readonly agentVersions: Pick<AgentVersionRepository, 'list'>;
}
