/**
 * The archived-**project** execution boundary issue #183 asks for: "Refuse every new session and
 * run for an archived project at the server boundary; active sessions that predate archival may
 * finish."
 *
 * One owned module, composed from `apps/web/server/composition/register.ts` and from
 * `apps/web/app/api/projects/[id]/sessions/route.ts` at every seam that creates a NEW session or
 * run — deliberately the same shape as `apps/web/server/workspaces/run-gate.ts`, which is the
 * identical problem one level up (an archived *workspace*).
 *
 * `docs/adr/W9-WS-119-run-gate-module-and-project-sessions.md`'s finding 2 is the trap this shape
 * avoids: inlining `project.archivedAt !== null` at each call site leaves a unit test of the
 * predicate proving nothing about the lines that call it, because deleting them keeps every test
 * green. Here each call site is one line delegating to {@link ProjectRunGate}, and
 * `archive-gate-integration.test.ts` drives the closures `register()` actually installs.
 *
 * Nothing here reads or refuses anything but *creation*. `get`, `list`, transcripts and event
 * streams are untouched, so a run already in flight when its project is archived finishes
 * normally and history keeps resolving its project — both are acceptance criteria of #183, and
 * both are asserted rather than assumed.
 */
import { isProjectArchived, type ProjectRows, type ProjectSessionRows } from './store';

/**
 * `null` (no such project in this workspace) is treated the same as archived, exactly as
 * `isWorkspaceUsableForRuns` treats a missing workspace row: a request naming a project this
 * workspace cannot resolve has nothing usable to start work in either.
 *
 * Note this takes a project **row**, so "no project at all" — a session with `projectId === null`,
 * which is every session started outside `/api/projects/:id/sessions` — is not expressible here
 * and is answered by {@link ProjectRunGate.isUsableForNewWork} instead.
 */
export function isProjectUsableForNewWork(
  project: { readonly archivedAt: Date | null } | null,
): boolean {
  return project !== null && !isProjectArchived(project);
}

/** A gate closed over one workspace-scoped project repository, so a call site needs only an id. */
export interface ProjectRunGate {
  /**
   * `true` when `projectId` is `null` — work that belongs to no project is not work in an
   * archived one — and otherwise when it names an active project of this workspace.
   */
  isUsableForNewWork(projectId: string | null): Promise<boolean>;
}

/** Build a {@link ProjectRunGate} over the same `ProjectRepository` `/api/projects` reads. */
export function createProjectRunGate(repository: Pick<ProjectRows, 'get'>): ProjectRunGate {
  return {
    async isUsableForNewWork(projectId: string | null): Promise<boolean> {
      if (projectId === null) return true;
      return isProjectUsableForNewWork(await repository.get(projectId));
    },
  };
}

/**
 * Wrap a `SessionRepository` so its one row-creating method, `ensure`, refuses once `gate` says
 * the requested `projectId` is archived; every other method passes through unchanged.
 *
 * Defence in depth behind `POST /api/projects/:id/sessions`'s own `409 project_archived`: that
 * route is where a caller gets a named refusal, and this wrapper is what makes the refusal hold
 * for any future caller of the same provider. `EnsureSessionOutcome` is a closed union with no
 * "project archived" member, so — following `run-gate.ts`'s `guardSessionCreation` verbatim — the
 * refusal is reported as `{ kind: 'unknown-principal' }`, which preserves the exact principal
 * boundary even when the caller is an API key with no human user id. Every caller already treats
 * that outcome as a real refusal rather than as evidence a session was created.
 */
export function guardProjectSessionCreation(
  sessions: ProjectSessionRows,
  gate: ProjectRunGate,
): ProjectSessionRows {
  return {
    ...sessions,
    async ensure(input) {
      if (!(await gate.isUsableForNewWork(input.projectId ?? null))) {
        return { kind: 'unknown-principal', principalId: input.ownerPrincipalId };
      }
      return sessions.ensure(input);
    },
  };
}
