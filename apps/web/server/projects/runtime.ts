import type {
  AgentRepository,
  AgentVersionRepository,
  AuditEventRepository,
  ProjectFileRepository,
  ProjectMcpServerRepository,
  ProjectRepository,
  SessionRepository,
} from '@agent-workspace/core/db';

export type ProjectActor =
  | {
      readonly kind: 'workspace';
      readonly workspaceId: string;
      readonly principalId: string;
      /**
       * The owner of what this actor writes (`Principal.ownerPrincipalId`, issue #509). Every
       * composition root sets it, so it is required (`rbac/owner-principal.ts`).
       */
      readonly ownerPrincipalId: string;
      readonly userId: string | null;
      readonly userLabel: string;
    }
  | { readonly kind: 'unauthenticated'; readonly reason: string }
  | { readonly kind: 'forbidden'; readonly reason: string };
export interface ProjectsRuntime {
  resolveActor(request: Request): Promise<ProjectActor>;
  forWorkspace(workspaceId: string): Promise<{
    projects: ProjectRepository;
    files: ProjectFileRepository;
    mcpServers: ProjectMcpServerRepository;
    audit: AuditEventRepository;
    /**
     * issue #125: `POST /api/projects/:id/sessions`'s "start a session" branch resolves
     * `defaultAgentId` against this (the same workspace-scoped lookup every other agent read in
     * this repository uses) before persisting it.
     */
    agents: AgentRepository;
    /** issue #125: where the resolved agent is persisted, once, at session creation. */
    sessions: SessionRepository;
    /** issue #612: the agent's pointers, so a new session pins the version `local` points at. */
    agentVersions: Pick<AgentVersionRepository, 'list'>;
  }>;
}
interface Registry {
  __agentWorkspaceProjectsRuntime__?: ProjectsRuntime;
}
const registry = globalThis as typeof globalThis & Registry;
export function configureProjectsRuntime(runtime: ProjectsRuntime): void {
  registry.__agentWorkspaceProjectsRuntime__ = runtime;
}
export function clearProjectsRuntime(): void {
  delete registry.__agentWorkspaceProjectsRuntime__;
}
export function currentProjectsRuntime(): ProjectsRuntime | null {
  return registry.__agentWorkspaceProjectsRuntime__ ?? null;
}
