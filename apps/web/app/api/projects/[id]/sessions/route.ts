import {
  json,
  problem,
  requireProjectAccess,
  withProjects,
} from '../../../../../server/projects/http';
import { ownerPrincipalIdOf } from '../../../../../server/rbac/owner-principal';
import { isProjectUsableForNewWork } from '../../../../../server/projects/archive-gate';
import { versionToPin } from '../../../../../server/agent-versions/session-version';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * `POST /api/projects/:id/sessions` — issue #125.
 *
 * Two request shapes, one route, because they are the two ways a session and a project meet:
 *
 *   * **No `sessionId` in the body: start one.** An optional `agentId` selects the composer's
 *     current agent; otherwise `:id`'s `defaultAgentId` is resolved. The chosen agent is persisted
 *     into the new session's `agent_id` in the same `ensure` call that
 *     creates the row — not written separately, so there is no window in which the row exists with
 *     the wrong agent or none. `sessions.agent_id` has no `update` path (see
 *     `packages/core/src/db/repositories/runs.ts`'s `UpdateSessionInput`, outside this task's Owns
 *     globs and unedited by it), so once persisted here a later edit to the project's
 *     `defaultAgentId` cannot reach this session's history — the acceptance criterion is met by an
 *     absence in a table this task does not own, not by a check this task adds.
 *   * **`sessionId` present: move** the existing session into `:id` — now also authorises against
 *     the session's *current* project (moving a session is an action on both projects, and until
 *     now only the destination was checked), AND is refused with `409 project_session_has_runs`
 *     once the session has any run at all. `sessions.project_id`, unlike `agent_id`, has no
 *     absence to lean on — it is precisely the column a move writes — so a run's project
 *     attribution can only stay historical by the session never moving once a run exists for it.
 *     See `MoveSessionOutcome` in `packages/core/src/db/repositories/projects.ts` for the full
 *     reasoning.
 *
 * Both branches are refused, with a name, before anything is persisted: an unresolvable
 * `defaultAgentId` (missing, or naming an agent no longer in this workspace) is exactly the
 * "actionable pre-launch error" the task card asks for, surfaced here — before the run
 * composition path (`../../../../../server/compose/resource-loader.ts`) is ever reached — rather
 * than as a run that fails later for a reason a session-start caller could have been told
 * immediately.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withProjects(request, async ({ projects, agents, sessions, agentVersions, actor }) => {
    const project = await projects.get(id);
    if (project === null) return problem(404, 'project_not_found', 'Project not found.');
    const access = await requireProjectAccess(request, actor, project.ownerPrincipalId);
    if (!access.ok) return access.response;
    // Issue #183: an archived project accepts no new work. Placed after the access check, so the
    // refusal never discloses the state of a project the caller could not otherwise see, and
    // before either branch writes anything. It covers both: starting a session in `:id`, and
    // moving one INTO `:id`. Moving a session *out* of an archived project stays allowed — the
    // destination is what this check reads — because that is how live work leaves a retired
    // project rather than being stranded in it.
    if (!isProjectUsableForNewWork(project)) {
      return problem(
        409,
        'project_archived',
        'This project is archived, so no new session can be started in it or moved into it. ' +
          'Restore the project first.',
      );
    }

    const body = await json(request);
    const rawSessionId =
      body && typeof body === 'object' && 'sessionId' in body ? body.sessionId : undefined;
    const sessionId = typeof rawSessionId === 'string' ? rawSessionId : '';

    if (sessionId) {
      const existing = await sessions.get(sessionId);
      if (existing === null) {
        return problem(404, 'project_or_session_not_found', 'Project or session not found.');
      }
      // Moving is an action on both ends: the destination is already authorised above, and the
      // session's current project (if it has one) must authorise it too, or a Builder could move
      // a session out of a project they cannot edit by naming only the project they can.
      if (existing.projectId !== null) {
        const source = await projects.get(existing.projectId);
        if (source !== null) {
          const sourceAccess = await requireProjectAccess(request, actor, source.ownerPrincipalId);
          if (!sourceAccess.ok) return sourceAccess.response;
        }
      }
      const outcome = await projects.moveSession(id, sessionId);
      if (outcome.kind === 'moved') return Response.json({ projectId: id, sessionId });
      if (outcome.kind === 'has-runs')
        return problem(
          409,
          'project_session_has_runs',
          "This session already has runs and cannot be moved: a run's project attribution " +
            'cannot be rewritten after it happened.',
        );
      return problem(404, 'project_or_session_not_found', 'Project or session not found.');
    }

    const rawAgentId =
      body && typeof body === 'object' && 'agentId' in body ? body.agentId : undefined;
    if (rawAgentId !== undefined && (typeof rawAgentId !== 'string' || rawAgentId.length === 0)) {
      return problem(400, 'invalid_body', 'agentId must be a non-empty string when present.');
    }
    const agentId = rawAgentId ?? project.defaultAgentId;
    if (agentId === null) {
      return problem(
        422,
        'project_default_agent_unresolvable',
        'This project has no default agent, so a session cannot be started in it.',
      );
    }
    const agent = await agents.get(agentId);
    if (agent === null) {
      return rawAgentId === undefined
        ? problem(
            422,
            'project_default_agent_unresolvable',
            "This project's default agent no longer exists in this workspace.",
          )
        : problem(
            422,
            'project_session_agent_not_found',
            'The selected agent does not exist in this workspace.',
          );
    }
    const outcome = await sessions.ensure({
      id: crypto.randomUUID(),
      agentId: agent.id,
      ownerPrincipalId: ownerPrincipalIdOf(actor),
      userId: actor.userId,
      projectId: id,
      // Issue #612: pinned on insert, so the session runs the version `local` points at now.
      agentVersionId: versionToPin((await agentVersions.list(agent.id))?.pointers ?? [], 'local'),
    });
    if (outcome.kind === 'created' || outcome.kind === 'existing') {
      return Response.json(
        { id: outcome.session.id, projectId: id, agentId: outcome.session.agentId },
        { status: outcome.kind === 'created' ? 201 : 200 },
      );
    }
    // The explicit else. `unknown-agent` and `not-a-member` are real, distinct refusals — see
    // `EnsureSessionOutcome` — surfaced by name rather than collapsed into a generic failure.
    return problem(
      422,
      'project_session_start_failed',
      `A session could not be started: ${outcome.kind}.`,
    );
  });
}
