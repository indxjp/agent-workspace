/**
 * `POST /api/runs/:id/approval` — ADR-0145 D2 (P5-4, #1301): approve or reject the tool call a run
 * paused on. The decision starts a continuation run in the same session and completes the paused
 * run in the same transaction (`decides`), so exactly one of several concurrent decisions wins.
 *
 * Ordered like `interruptRun` in `./api.ts`: configured → authenticated → well-formed id → found →
 * session scope → §21 (`runs.run.approval`) → awaiting approval → body → act. The body is parsed
 * after authorisation, so a caller who may not decide learns nothing from validation errors.
 */
import {
  RUN_APPROVAL_PROBLEM_CODES,
  RunApprovalRequestSchema,
} from '@indx-workspace/contracts/runs';

import {
  findRunForPrincipal,
  notConfigured,
  renderRun,
  requireRunPermission,
  requireSessionScopeMatch,
  unauthenticated,
} from './api';
import { getRunApi } from './environment';
import { apiError, isUuid, json, readJsonBody } from './http';
import { startRunOnSession } from './service';

export async function decideRunApproval(request: Request, runId: string): Promise<Response> {
  const env = getRunApi();
  if (env === null) return notConfigured();
  const principal = await env.authenticate(request);
  if (principal === null) return unauthenticated();
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

  const pending = run.status === 'awaiting_approval' ? (run.pendingApproval ?? null) : null;
  if (pending === null) {
    return apiError(
      RUN_APPROVAL_PROBLEM_CODES.run_not_awaiting_approval,
      'run_not_awaiting_approval',
      `run ${runId} is ${run.status}, not awaiting_approval, so there is nothing to decide.`,
    );
  }

  const raw = await readJsonBody(request);
  if (raw.kind !== 'ok') return apiError(400, 'invalid_body', raw.reason);
  const parsed = RunApprovalRequestSchema.safeParse(raw.value);
  if (!parsed.success) {
    return apiError(
      400,
      'invalid_body',
      parsed.error.issues
        .map((issue) => `${issue.path.map(String).join('.') || '$'}: ${issue.message}`)
        .join('; '),
    );
  }
  const { decision, comment } = parsed.data;

  // The session's own agent, at the version the session is pinned to (issue #612).
  const agent = await env.findAgent(principal, run.agentId, run.sessionId);
  if (agent === null) {
    return apiError(404, 'agent_not_found', `no agent ${run.agentId} in this workspace.`);
  }

  const verdict = decision === 'approve' ? 'approved' : 'rejected';
  // A rejected call is not admitted: the continuation meets the same gate again if it retries it.
  const started = await startRunOnSession(env, principal, agent, {
    prompt: comment === undefined ? verdict : `${verdict}: ${comment}`,
    sessionId: run.sessionId,
    modelOverride:
      run.modelConnectionId != null && run.model != null
        ? { connectionId: run.modelConnectionId, model: run.model }
        : null,
    // The continuation answers in the shape the paused run was asked for (ADR-0143).
    ...(run.outputSchema == null ? {} : { outputSchema: run.outputSchema }),
    decides: { runId: run.id, approvedToolCalls: decision === 'approve' ? [pending] : [] },
    // The paused run's snapshot is already narrowed; the continuation may not see more (ADR-0147).
    ...(run.fileGrants === undefined ? {} : { fileScope: run.fileGrants }),
    // The continuation acts for whom the paused run acted for (ADR-0157). Only the stored row
    // supplies it: the approval body is strict and can never carry a subject.
    ...(run.subject == null ? {} : { subject: run.subject }),
  });
  if (started.kind === 'refused') {
    return apiError(started.status, started.code, started.message, started.details);
  }

  const events = `/api/runs/${started.run.id}/events`;
  return json({ run: renderRun(started.run), events }, 202, { Location: events });
}
