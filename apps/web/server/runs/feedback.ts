/**
 * `POST /api/runs/:id/feedback` — issue #539 (S2-05c, C19, ADR-0105 "Feedback"): a thumbs up or
 * down, with an optional comment, on one run's answer. Answers `204`; every admitted call is
 * stored, and a surface visitor's ratings are rate-limited (`429 surface_rate_limited`; #606).
 *
 * Ordered like `readRun` in `./api.ts`: configured → authenticated → well-formed id → found →
 * session scope's row identity → §21 → visitor limit → body → act. The body is parsed after
 * authorisation, so a caller who may not rate the run learns nothing from validation errors.
 */
import {
  RUN_FEEDBACK_LIST_LIMIT,
  RUN_FEEDBACK_LIST_PROBLEM_CODES,
  RunFeedbackListQuerySchema,
  RunFeedbackRequestSchema,
  type RunFeedbackItem,
} from '@indx-workspace/contracts/feedback';
import { AgentFrameSchema, type AgentFrame } from '@indx-workspace/contracts/run-events';

import { finalAnswer } from '../evaluations/score';
import { ownerPrincipalIdOf } from '../rbac/owner-principal';
import { grantsFor } from '../rbac/permissions';
import { parseRole } from '../rbac/roles';
import { upgradeStoredEvent } from './agent-frames';
import {
  findRunForPrincipal,
  notConfigured,
  refuseOverVisitorLimit,
  requireRunPermission,
  requireSessionScopeMatch,
  unauthenticated,
} from './api';
import { featureRefusalResponse } from '../features/guard';
import { getRunApi, type AgentFeedbackRow } from './environment';
import { apiError, isUuid, json, readJsonBody } from './http';

export async function submitRunFeedback(request: Request, runId: string): Promise<Response> {
  const env = getRunApi();
  if (env === null || env.recordRunFeedback === undefined) return notConfigured();
  const principal = await env.authenticate(request);
  if (principal === null) return unauthenticated();
  const disabled = await featureRefusalResponse(request, principal.workspaceId);
  if (disabled !== null) return disabled;
  if (!isUuid(runId)) {
    return apiError(400, 'invalid_run_id', 'the run id in the path is not a UUID.');
  }
  const run = await findRunForPrincipal(env.store, principal, runId);
  if (run === null) return apiError(404, 'run_not_found', `no run ${runId} in this workspace.`);
  const scopeMismatch = requireSessionScopeMatch(principal, run.sessionId);
  if (scopeMismatch !== null) return scopeMismatch;
  const permission = requireRunPermission(
    request,
    principal,
    (await env.ownsRun(principal, run)) ? 'own' : 'other',
  );
  if (permission !== null) return permission;
  const overLimit = await refuseOverVisitorLimit(env, principal, 'feedback', request.headers);
  if (overLimit !== null) return overLimit;

  const raw = await readJsonBody(request);
  if (raw.kind !== 'ok') return apiError(400, 'invalid_body', raw.reason);
  const parsed = RunFeedbackRequestSchema.safeParse(raw.value);
  if (!parsed.success) {
    return apiError(
      400,
      'invalid_body',
      parsed.error.issues
        .map((issue) => `${issue.path.map(String).join('.') || '$'}: ${issue.message}`)
        .join('; '),
    );
  }
  await env.recordRunFeedback(principal, run, parsed.data);
  return new Response(null, { status: 204 });
}

/**
 * `GET /api/agents/:id/feedback` — issue #620: the newest ratings of an agent's runs, each with
 * the run's prompt and answer, so a thumbs-down can become an evaluation case (`aw eval add-case`).
 *
 * Configured → authenticated → well-formed id → §21 on the agent (every role reads any agent; a
 * browser token's scope reaches no `feedback` read) → query → read. A role whose runs grant is
 * narrower than `any` sees only the ratings of its own sessions' runs: the filter `GET /api/runs`
 * applies (`decideRunListAccess` in `./api.ts`).
 */
export async function listAgentFeedback(request: Request, agentId: string): Promise<Response> {
  const env = getRunApi();
  if (env === null || env.listAgentFeedback === undefined) return notConfigured();
  const principal = await env.authenticate(request);
  if (principal === null) return unauthenticated();
  const disabled = await featureRefusalResponse(request, principal.workspaceId);
  if (disabled !== null) return disabled;
  if (!isUuid(agentId)) {
    return apiError(
      RUN_FEEDBACK_LIST_PROBLEM_CODES.invalid_agent_id,
      'invalid_agent_id',
      'the agent id in the path is not a UUID.',
    );
  }
  const role = parseRole(principal.role);
  if (role === null) {
    return apiError(403, 'forbidden', 'the authenticated identity has no recognised role.');
  }
  // `unknown`: the agent's owner is not read, so a grant narrower than `any` would deny.
  const permission = requireRunPermission(request, principal, 'unknown');
  if (permission !== null) return permission;

  const params = new URL(request.url).searchParams;
  const keys = [...params.keys()];
  const parsed = RunFeedbackListQuerySchema.safeParse(Object.fromEntries(params));
  if (!parsed.success || new Set(keys).size !== keys.length) {
    return apiError(
      RUN_FEEDBACK_LIST_PROBLEM_CODES.invalid_query,
      'invalid_query',
      'the query takes at most one each of rating (up or down), since (an ISO 8601 date-time) and runId (a UUID).',
    );
  }
  const { rating, since, runId } = parsed.data;
  const rows = await env.listAgentFeedback(principal, {
    agentId,
    ...(rating === undefined ? {} : { rating }),
    ...(since === undefined ? {} : { since: new Date(since) }),
    ...(runId === undefined ? {} : { runId }),
    ...(grantsFor(role, 'runs').read === 'any'
      ? {}
      : { ownerPrincipalId: ownerPrincipalIdOf(principal) }),
    limit: RUN_FEEDBACK_LIST_LIMIT,
  });
  if (rows === null) {
    return apiError(
      RUN_FEEDBACK_LIST_PROBLEM_CODES.agent_not_found,
      'agent_not_found',
      `no agent ${agentId} in this workspace.`,
    );
  }
  return json({ items: rows.map(toItem) }, 200);
}

function toItem(row: AgentFeedbackRow): RunFeedbackItem {
  const frames = row.events.flatMap(upgradeStoredEvent).flatMap((event): AgentFrame[] => {
    const frame = AgentFrameSchema.safeParse(event.data);
    return frame.success ? [frame.data] : [];
  });
  return {
    runId: row.runId,
    rating: row.rating,
    comment: row.comment,
    input: row.input,
    answer: finalAnswer(frames),
    createdAt: row.createdAt.toISOString(),
  };
}
