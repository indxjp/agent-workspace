/**
 * `POST /api/projects/:id/archive` and `POST /api/projects/:id/restore` — issue #183.
 *
 * Both routes are the same four steps over a different repository method and a different audit
 * action, so they share one parameterised handler rather than two near-identical route bodies:
 *
 *   1. **Read the project.** `projects.get` is workspace-scoped, so a foreign id and a nonexistent
 *      id are already the same `null` before any policy runs (issue #182's contract).
 *   2. **Authorise, then conceal the refusal.** The decision itself is the one every other project
 *      route takes — `requireProjectAccess`, which is §21's table plus the own/other split, so the
 *      workspace Owner and a Builder who created the project pass and a non-creator Builder, any
 *      Admin and any Viewer do not. What is different here is what a **403** becomes: #183 requires
 *      a refused caller to be answered exactly like a nonexistent id, so the refusal is rewritten
 *      into the byte-identical `404 project_not_found` this handler already returns for `null`.
 *      This is a deliberate divergence from `GET`/`PATCH /api/projects/:id`, which answer 403 —
 *      see `docs/adr/W9-PROJ-183-archive-routes-conceal-and-gate-execution.md`.
 *
 *      Only a 403 is concealed. A 401 stays a 401: telling an unauthenticated caller "no such
 *      project" would answer a question they never got far enough to ask, and would make a missing
 *      credential indistinguishable from a wrong one. A 503 (no runtime) and a 500 (undecidable
 *      authorisation) are not refusals of this caller at all and pass through untouched.
 *   3. **Apply the transition.** Both `archive` and `restore` are idempotent at the repository, so
 *      a repeated call is a `200` with the same resource rather than a conflict.
 *   4. **Audit the transition, not the request.** The pre-image and the post-image are compared and
 *      an event is written only when the archived state actually changed. That is what makes "each
 *      successful transition produces an audit event" checkable by counting rows: archiving twice
 *      leaves exactly one `project-archived`.
 */
import type { ProjectRecord, ProjectRepository } from '@agent-workspace/core/db';
import { isProjectArchived } from '@agent-workspace/core/db';

import { InfrastructureError } from '../errors';
import { errorResponse } from '../http/error-response';
import { isUuid, problem, requireProjectAccess, withProjects, type ProjectContext } from './http';
import { toProjectResource } from './resource';

/** One lifecycle transition: the repository method that performs it, and what it is called. */
interface ProjectTransition {
  readonly action: 'project-archived' | 'project-restored';
  /** `null` when `id` names no project in the caller's workspace. */
  apply(projects: ProjectRepository, id: string): Promise<ProjectRecord | null>;
  /** The `operation` an audit-write failure is reported under. */
  readonly operation: string;
}

const ARCHIVE: ProjectTransition = {
  action: 'project-archived',
  apply: (projects, id) => projects.archive(id),
  operation: 'write-archive-audit',
};

const RESTORE: ProjectTransition = {
  action: 'project-restored',
  apply: (projects, id) => projects.restore(id),
  operation: 'write-restore-audit',
};

/**
 * The one response a caller who may not see this project receives, whatever the reason.
 *
 * Built fresh per call because a `Response` body is a single-use stream; the status and body are
 * the constants, and `lifecycle.test.ts` compares them field by field against the response an
 * id that names nothing at all produces.
 */
function projectNotFound(): Response {
  return problem(404, 'project_not_found', 'Project not found.');
}

async function transitionProject(
  request: Request,
  id: string,
  transition: ProjectTransition,
): Promise<Response> {
  try {
    return await withProjects(request, async ({ projects, files, mcpServers, audit, actor }) => {
      // `projects.id` is a `uuid` column, so a malformed segment names nothing and gets step 1's
      // answer — issue #200. Handing it to `projects.get` instead reaches PostgreSQL as an invalid
      // literal (`22P02`), an unclassified persistence failure and so a 5xx: two ids that both name
      // nothing would then be told apart by their shape. Inside the `withProjects` callback, never
      // above it — step 2's precedence is the point, and a 401 must stay a 401 even when the id is
      // malformed.
      if (!isUuid(id)) return projectNotFound();
      const before = await projects.get(id);
      if (before === null) return projectNotFound();
      const access = await requireProjectAccess(request, actor, before.ownerPrincipalId);
      if (!access.ok) {
        return access.response.status === 403 ? projectNotFound() : access.response;
      }
      const after = await transition.apply(projects, id);
      // The project was there a moment ago and nothing in this repository deletes one, so this is
      // a concurrent workspace deletion rather than an authorisation answer — concealed the same
      // way regardless, because the caller's question is still "is there such a project".
      if (after === null) return projectNotFound();
      if (isProjectArchived(before) !== isProjectArchived(after)) {
        await recordTransition(audit, actor, after, transition);
      }
      return Response.json(
        toProjectResource(after, await files.list(id), await mcpServers.list(id)),
      );
    });
  } catch (error) {
    return errorResponse(error, { component: 'projects', operation: transition.action });
  }
}

/**
 * Best-effort audit, following `POST /api/projects`: the transition has already committed, so a
 * failed audit write is logged as an `InfrastructureError` rather than turned into a 5xx that
 * would invite a retry of a write that already happened.
 */
async function recordTransition(
  audit: ProjectContext['audit'],
  actor: ProjectContext['actor'],
  project: ProjectRecord,
  transition: ProjectTransition,
): Promise<void> {
  try {
    await audit.write({
      actorPrincipalId: actor.principalId,
      actorUserId: actor.userId,
      actorLabel: actor.userLabel,
      action: transition.action,
      subjectId: project.id,
      subjectLabel: project.name,
    });
  } catch (error) {
    console.error(
      `[projects] ${transition.action} audit write failed`,
      new InfrastructureError({
        component: 'projects',
        operation: transition.operation,
        cause: error,
      }),
    );
  }
}

/** `POST /api/projects/:id/archive`. */
export function archiveProject(request: Request, id: string): Promise<Response> {
  return transitionProject(request, id, ARCHIVE);
}

/** `POST /api/projects/:id/restore`. */
export function restoreProject(request: Request, id: string): Promise<Response> {
  return transitionProject(request, id, RESTORE);
}
