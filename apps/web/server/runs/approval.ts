/**
 * `POST /api/runs/:id/approval` — ADR-0145 D2 (P5-4, #1301): approve or reject the tool call a run
 * paused on. The decision starts a continuation run in the same session and completes the paused
 * run in the same transaction (`decides`), so exactly one of several concurrent decisions wins.
 *
 * Ordered like `interruptRun` in `./api.ts`: configured → authenticated → well-formed id → found →
 * session scope → an app backend's bound agent (ADR-0161's amendment of issue #1509) → a team
 * lead run's unscoped decider (ADR-0104 decision 10) → §21
 * (`runs.run.approval`) → awaiting approval → body → act. The body is parsed
 * after authorisation, so a caller who may not decide learns nothing from validation errors.
 */
import {
  RUN_APPROVAL_PROBLEM_CODES,
  RunApprovalRequestSchema,
  type RunApprovalRequest,
} from '@indx-workspace/contracts/runs';

import {
  findRunForPrincipal,
  notConfigured,
  renderRun,
  requireRunPermission,
  requireSessionScopeMatch,
  unauthenticated,
} from './api';
import {
  getRunApi,
  type RunReadEnvironment,
  type RunStartEnvironment,
  type RunPrincipal,
} from './environment';
import { apiError, isUuid, json, readJsonBody } from './http';
import { startRunOnSession } from './service';
import type { RunStartInput } from './start-input';
import type { ApprovalCall, RunRecord } from './store';

/** The folder a session's uploads live under; a run's attachments are recorded in its grants. */
const ATTACHMENTS_FOLDER = '.attachments';

/**
 * The paused run's file grants as a continuation's `fileScope`. The snapshot also records the
 * run's attachment paths (ADR-0146), which are not the agent's grants: the continuation carries no
 * attachments, so naming them would make launch refuse it with `run_file_scope_not_granted` after
 * the decision was consumed. They are dropped; every other grant narrows as before.
 */
function continuationFileScope(fileGrants: readonly string[]): string[] {
  return fileGrants.filter((path) => path.split('/', 1)[0]?.toLowerCase() !== ATTACHMENTS_FOLDER);
}

/**
 * The principal a continuation runs as (ADR-0145 D2.2, ADR-0157). The decider may be a member who
 * does not own the paused run (an Owner or Admin deciding another member's run); the continuation
 * runs in the paused run's session, which only its owner may open, so it takes that owner while the
 * decider's identity, role and scope stay as authorised above.
 */
function continuationPrincipal(
  principal: RunPrincipal,
  run: { readonly ownerPrincipalId?: string | undefined },
): RunPrincipal {
  return run.ownerPrincipalId === undefined || run.ownerPrincipalId === principal.ownerPrincipalId
    ? principal
    : { ...principal, ownerPrincipalId: run.ownerPrincipalId };
}

/**
 * ADR-0161's amendment (issue #1509): a decision starts a continuation on the paused run's agent,
 * so an `app-backend` caller decides only a run of an agent its endpoint client binds. `null`
 * admits it, and is the answer for every other principal. The agent is a row fact, so this is
 * checked here and not in `decide()`.
 */
function requireBoundAgent(principal: RunPrincipal, agentId: string): Response | null {
  const scope = principal.scope;
  if (scope === null || scope === undefined || scope.kind !== 'app-backend') return null;
  const wanted = agentId.toLowerCase();
  if ((scope.agentIds ?? []).some((bound) => bound.toLowerCase() === wanted)) return null;
  return apiError(
    403,
    'token_out_of_scope',
    `this app-backend-scoped credential reaches only the agents its endpoint client ${scope.id} ` +
      'binds, and this run is on another.',
  );
}

/**
 * ADR-0104 acceptance decision 10 (agents never exceed the person): a continuation of a team's lead
 * run keeps its team version, so its member calls reach agents a scope does not name, and the
 * member endpoint decides them for the person's unattenuated role. A scoped credential therefore
 * decides no approval of a lead run, as it starts no team run (`POST /api/agent-teams/:id/runs`).
 */
function requireUnscopedForTeamLead(
  principal: RunPrincipal,
  run: { readonly parentRunId?: string | null; readonly agentTeamVersionId?: string | null },
): Response | null {
  if (principal.scope === null || principal.scope === undefined) return null;
  const isTeamLead =
    (run.agentTeamVersionId ?? null) !== null && (run.parentRunId ?? null) === null;
  if (!isTeamLead) return null;
  return apiError(
    403,
    'token_out_of_scope',
    "a scoped credential decides no approval of an agent team's lead run, as it runs no team.",
  );
}

/** What a successful decision answers with: 202 Accepted, the continuation's events at `Location`. */
const DECISION_ACCEPTED_STATUS = 202;

/** The decision body's validation message: `path: problem` per issue, `$` for the root. */
function describeBodyIssues(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): string {
  return issues
    .map((issue) => `${issue.path.map(String).join('.') || '$'}: ${issue.message}`)
    .join('; ');
}

interface AuthorizedDecision {
  readonly env: RunReadEnvironment & RunStartEnvironment;
  readonly principal: RunPrincipal;
  readonly run: RunRecord;
  /** The tool call the run is paused on, which the decision admits or rejects. */
  readonly pending: ApprovalCall;
}

/**
 * Every check that runs before the body is read, in the order the file header documents. Returns
 * the refusal to send, or the paused run its caller may decide.
 */
async function authorizeDecision(
  request: Request,
  runId: string,
): Promise<Response | AuthorizedDecision> {
  const env = getRunApi();
  if (env === null) return notConfigured();
  const principal = await env.authenticate(request);
  if (principal === null) return unauthenticated();
  if (!isUuid(runId)) {
    return apiError(400, 'invalid_run_id', 'the run id in the path is not a UUID.');
  }
  const run = await findRunForPrincipal(env.store, principal, runId);
  if (run === null) return apiError(404, 'run_not_found', `no run ${runId} in this workspace.`);
  const refusal =
    requireSessionScopeMatch(principal, run.sessionId) ??
    requireBoundAgent(principal, run.agentId) ??
    requireUnscopedForTeamLead(principal, run) ??
    requireRunPermission(request, principal, (await env.ownsRun(principal, run)) ? 'own' : 'other');
  if (refusal !== null) return refusal;

  const pending = run.status === 'awaiting_approval' ? (run.pendingApproval ?? null) : null;
  if (pending === null) {
    return apiError(
      RUN_APPROVAL_PROBLEM_CODES.run_not_awaiting_approval,
      'run_not_awaiting_approval',
      `run ${runId} is ${run.status}, not awaiting_approval, so there is nothing to decide.`,
    );
  }
  return { env, principal, run, pending };
}

/**
 * What the continuation of `paused` is started with. A rejected call is not admitted: the
 * continuation meets the same gate again if it retries it.
 */
function continuationInput(
  paused: RunRecord,
  pending: ApprovalCall,
  body: RunApprovalRequest,
): RunStartInput {
  const approved = body.decision === 'approve';
  const verdict = approved ? 'approved' : 'rejected';
  return {
    prompt: body.comment === undefined ? verdict : `${verdict}: ${body.comment}`,
    sessionId: paused.sessionId,
    modelOverride:
      paused.modelConnectionId != null && paused.model != null
        ? { connectionId: paused.modelConnectionId, model: paused.model }
        : null,
    // The continuation answers in the shape the paused run was asked for (ADR-0143).
    ...(paused.outputSchema == null ? {} : { outputSchema: paused.outputSchema }),
    decides: { runId: paused.id, approvedToolCalls: approved ? [pending] : [] },
    // The paused run's snapshot is already narrowed; the continuation may not see more (ADR-0147).
    ...(paused.fileGrants === undefined
      ? {}
      : { fileScope: continuationFileScope(paused.fileGrants) }),
    // The continuation acts for whom the paused run acted for (ADR-0157). Only the stored row
    // supplies it: the approval body is strict and can never carry a subject.
    ...(paused.subject == null ? {} : { subject: paused.subject }),
  };
}

export async function decideRunApproval(request: Request, runId: string): Promise<Response> {
  const authorized = await authorizeDecision(request, runId);
  if (authorized instanceof Response) return authorized;
  const { env, principal, run, pending } = authorized;

  const raw = await readJsonBody(request);
  if (raw.kind !== 'ok') return apiError(400, 'invalid_body', raw.reason);
  const parsed = RunApprovalRequestSchema.safeParse(raw.value);
  if (!parsed.success) {
    return apiError(400, 'invalid_body', describeBodyIssues(parsed.error.issues));
  }

  // The session's own agent, at the version the session is pinned to (issue #612).
  const agent = await env.findAgent(principal, run.agentId, run.sessionId);
  if (agent === null) {
    return apiError(404, 'agent_not_found', `no agent ${run.agentId} in this workspace.`);
  }

  const started = await startRunOnSession(env, continuationPrincipal(principal, run), agent, {
    ...continuationInput(run, pending, parsed.data),
    // The continuation keeps the cap the paused run was started under (#1963): it is built from
    // the stored row, which is the only place the cap survives the pause. `startRunOnSession`
    // validates it again and stores it on the continuation's own row. It stays in this call so
    // limits-origin.test.ts sees every caller that passes `limits`.
    ...(run.limitsOverride == null ? {} : { limits: run.limitsOverride }),
  });
  if (started.kind === 'refused') {
    return apiError(started.status, started.code, started.message, started.details);
  }

  const events = `/api/runs/${started.run.id}/events`;
  return json({ run: renderRun(started.run), events }, DECISION_ACCEPTED_STATUS, {
    Location: events,
  });
}
