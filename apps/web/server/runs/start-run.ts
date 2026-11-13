/**
 * The start of a run once its caller is authenticated and may run the agent: the path behind
 * `POST /api/agents/:id/runs` and `POST /api/agent-teams/:id/runs` alike. `api.ts` re-exports
 * {@link startAuthorisedRun}, so `runs/api` stays the one public import path.
 */
import { AGENT_VERSION_PROBLEM_CODES } from '@indx-workspace/contracts/agent-versions';
import {
  RUN_IDEMPOTENCY_PROBLEM_CODES,
  RUN_START_PROBLEM_CODES,
} from '@indx-workspace/contracts/runs';

import { refuseOverVisitorLimit, requireSessionScopeMatch, type RunHandlerCaller } from './access';
import { resolveRunAttachments } from './attachments';
import type { AgentRef } from './environment';
import { apiError, json, readJsonBody } from './http';
import { MAX_IDEMPOTENCY_KEY_CHARS, startRunOnSession, type StartRunBody } from './service';
import { parseStartRunBody } from './start-run-body';
import { acceptedStart, readIdempotencyKey, replayStart } from './start-run-idempotency';
import { IdempotencyKeyTakenError, type RunIdempotency } from './store';
import { publishedEngineId } from '../engines/session-engine';
import { enforceCeiling } from '../agents';

/**
 * What a team run start pins on the lead's run (ADR-0104 acceptance decisions 4 and 11): the
 * lead's version, which a new session runs, and the team version the run records.
 */
export interface TeamRunPin {
  readonly agentVersionId: string;
  readonly agentTeamVersionId: string;
}

type Refusable<T> = T | { readonly kind: 'refused'; readonly response: Response };

type StartRunInput = Parameters<typeof startRunOnSession>[3];

const NO_PERMISSIONS = {
  readFiles: false,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
} as const;

/**
 * Issue #535: a run's explicit `modelOverride` outside the deployment ceiling's `models` answers
 * `403 policy_cannot_widen` before any session or run exists. Only the override is judged here,
 * against a ceiling reduced to `models`, so `model:<id>` is the only detail; the stored engine and
 * the ladder-resolved model are preflight's (S2-04c, `RUN_START_PROBLEM_CODES`), so the two never
 * refuse the same field twice.
 */
async function modelOverrideRefusal(
  caller: RunHandlerCaller,
  agent: AgentRef,
  body: StartRunBody,
): Promise<Response | null> {
  const override = body.modelOverride;
  const ceiling = caller.env.ceilingFor?.(caller.request, caller.principal.workspaceId);
  const models = ceiling?.policy.models;
  if (override === null || ceiling === undefined || models === undefined) return null;
  const ceilingRefusal = await enforceCeiling(
    {
      permissions: NO_PERMISSIONS,
      limits: { maxTurns: null, maxBudgetUsd: null },
      engine: publishedEngineId(agent.engine),
      model: override.model,
      tools: [],
    },
    { ...ceiling, policy: { models } },
    { id: agent.id, label: 'run start' },
  );
  return ceilingRefusal === null
    ? null
    : json(ceilingRefusal.body, RUN_START_PROBLEM_CODES.policy_cannot_widen);
}

/** A step's refusal, carrying the response that ends the start. */
const refusedWith = (
  response: Response,
): { readonly kind: 'refused'; readonly response: Response } => ({
  kind: 'refused',
  response,
});

/** The `400 invalid_body` answer, with the reason the body was refused. */
const invalidBody = (reason: string): Response => apiError(400, 'invalid_body', reason);

/** The rules on a parsed body that need no lookup: a team's version pin, the subject, the session scope. */
function bodyRuleRefusal(
  caller: RunHandlerCaller,
  team: TeamRunPin | null,
  body: StartRunBody,
): Response | null {
  if (team !== null && body.version !== undefined) {
    return invalidBody(
      '"version" is not accepted here: the team version pins the version its lead runs.',
    );
  }
  // ADR-0142 D2: only a backend acting for its own users names a subject. A session or a browser
  // token states who it is already, so it cannot assert someone else.
  if (body.subject !== undefined && caller.principal.via !== 'api-key') {
    return apiError(
      RUN_START_PROBLEM_CODES.run_subject_forbidden,
      'run_subject_forbidden',
      '"subject" may only be set by an API key; remove it from the request.',
    );
  }
  // §3.1's session scope: "start runs in that session", never a new one and never another. A body
  // that omits `sessionId` is refused the same way a body naming a different session is, rather
  // than silently starting a fresh session the token was never scoped to.
  return requireSessionScopeMatch(caller.principal, body.sessionId);
}

/** The body, then the rules on it that need no lookup. */
async function refuseStartBody(
  caller: RunHandlerCaller,
  team: TeamRunPin | null,
): Promise<Refusable<{ readonly kind: 'ok'; readonly body: StartRunBody }>> {
  const raw = await readJsonBody(caller.request);
  if (raw.kind !== 'ok') return refusedWith(invalidBody(raw.reason));
  const parsed = parseStartRunBody(raw.value);
  if (parsed.kind !== 'ok') return refusedWith(invalidBody(parsed.reason));
  const ruleRefusal = bodyRuleRefusal(caller, team, parsed.body);
  if (ruleRefusal !== null) return refusedWith(ruleRefusal);
  return { kind: 'ok', body: parsed.body };
}

/**
 * ADR-0151: a replay is answered before anything a fresh start would do — no visitor turn, no
 * preflight, no session — so it returns the original run even when a new start would be refused.
 * A start that is not a replay then meets the visitor limits.
 */
async function answerReplayOrAdmit(
  caller: RunHandlerCaller,
  agentId: string,
  body: StartRunBody,
  team: TeamRunPin | null,
): Promise<Refusable<{ readonly kind: 'admitted'; readonly idempotency?: RunIdempotency }>> {
  const { request, env, principal } = caller;
  const idempotency = readIdempotencyKey({ request, principal, agentId, body, team });
  if (idempotency === 'invalid') {
    return refusedWith(
      apiError(
        RUN_IDEMPOTENCY_PROBLEM_CODES.invalid_idempotency_key,
        'invalid_idempotency_key',
        `Idempotency-Key must be 1 to ${String(MAX_IDEMPOTENCY_KEY_CHARS)} characters.`,
      ),
    );
  }
  if (idempotency !== undefined) {
    const replay = await replayStart(env.store, principal, idempotency);
    if (replay !== null) return refusedWith(replay);
  }
  const overLimit = await refuseOverVisitorLimit(env, principal, 'turn', request.headers);
  if (overLimit !== null) return refusedWith(overLimit);
  return idempotency === undefined ? { kind: 'admitted' } : { kind: 'admitted', idempotency };
}

/**
 * The version a new session runs: a team's pin, or the named `version`. Issue #697: a named
 * version is looked up in the principal's workspace, so another workspace's number is as unknown
 * as one that was never saved.
 */
async function resolveAgentVersionId(
  caller: RunHandlerCaller,
  agent: AgentRef,
  version: number | undefined,
  pinned: string | undefined,
): Promise<Refusable<{ readonly kind: 'ok'; readonly agentVersionId: string | undefined }>> {
  if (version === undefined) return { kind: 'ok', agentVersionId: pinned };
  const found = await caller.env.findAgentVersion?.(caller.principal, agent.id, version);
  if (found === undefined || found === null) {
    return refusedWith(
      apiError(
        AGENT_VERSION_PROBLEM_CODES.agent_version_not_found,
        'agent_version_not_found',
        `the agent has no version ${String(version)}.`,
      ),
    );
  }
  return { kind: 'ok', agentVersionId: found.id };
}

/** The attachments a body names, resolved for the principal; none when it names none. */
function resolveBodyAttachments(caller: RunHandlerCaller, body: StartRunBody) {
  if (body.attachments === undefined) return Promise.resolve({ kind: 'ok', files: [] } as const);
  return resolveRunAttachments(caller.principal, body.attachments, body.sessionId);
}

/** Everything a start has resolved by the time it reaches `startRunOnSession`. */
interface ResolvedStart {
  readonly body: StartRunBody;
  readonly attachmentFiles: NonNullable<StartRunInput['attachments']>;
  readonly agentVersionId: string | undefined;
  readonly idempotency: RunIdempotency | undefined;
  readonly team: TeamRunPin | null;
}

/** The input `startRunOnSession` takes: the body, with what the steps before it resolved. */
function startInputOf(resolved: ResolvedStart): StartRunInput {
  const { body, attachmentFiles, agentVersionId, idempotency, team } = resolved;
  return {
    ...body,
    attachments: attachmentFiles,
    ...(agentVersionId === undefined ? {} : { agentVersionId }),
    ...(idempotency === undefined ? {} : { idempotency }),
    ...(team === null ? {} : { agentTeamVersionId: team.agentTeamVersionId }),
  };
}

/** Start the run; two starts with one key that raced, the other committing first, answer with its run. */
async function startWithRaceReplay(
  caller: RunHandlerCaller,
  agent: AgentRef,
  input: StartRunInput,
): Promise<Response> {
  const { env, principal } = caller;
  let started: Awaited<ReturnType<typeof startRunOnSession>>;
  try {
    started = await startRunOnSession(env, principal, agent, input);
  } catch (error) {
    if (!(error instanceof IdempotencyKeyTakenError) || input.idempotency === undefined) {
      throw error;
    }
    const replay = await replayStart(env.store, principal, input.idempotency);
    if (replay === null) throw error;
    return replay;
  }
  if (started.kind === 'refused') {
    return apiError(started.status, started.code, started.message, started.details);
  }
  return acceptedStart(started.run);
}

/**
 * The rest of `POST /api/agents/:id/runs` once the caller is authenticated and may run `agentId`:
 * the body, the subject and scope rules, the start key, the visitor limits, the agent, the
 * attachments, the ceiling, the version and the start. `POST /api/agent-teams/:id/runs` reaches
 * the same path with the lead and `team`, so a team run meets every refusal a run of its lead does.
 */
export async function startAuthorisedRun(
  caller: RunHandlerCaller,
  agentId: string,
  team: TeamRunPin | null,
): Promise<Response> {
  const parsed = await refuseStartBody(caller, team);
  if (parsed.kind === 'refused') return parsed.response;
  const { body } = parsed;
  const admitted = await answerReplayOrAdmit(caller, agentId, body, team);
  if (admitted.kind === 'refused') return admitted.response;

  // A follow-up's agent carries its conversation's pinned engine (issue #612), which the model
  // override's ceiling check below and the engine pin in `startRunOnSession` (`service.ts`) read.
  const agent = await caller.env.findAgent(caller.principal, agentId, body.sessionId);
  // 404 rather than 403 when the agent belongs to another workspace: §25's isolation rule is not
  // satisfied by a status code that confirms the row exists.
  if (agent === null) {
    return apiError(404, 'agent_not_found', `no agent ${agentId} in this workspace.`);
  }

  const attachments = await resolveBodyAttachments(caller, body);
  if (attachments.kind === 'refused') return attachments.response;

  const overCeiling = await modelOverrideRefusal(caller, agent, body);
  if (overCeiling !== null) return overCeiling;

  const version = await resolveAgentVersionId(caller, agent, body.version, team?.agentVersionId);
  if (version.kind === 'refused') return version.response;

  return startWithRaceReplay(
    caller,
    agent,
    startInputOf({
      body,
      attachmentFiles: attachments.files,
      agentVersionId: version.agentVersionId,
      idempotency: admitted.idempotency,
      team,
    }),
  );
}
