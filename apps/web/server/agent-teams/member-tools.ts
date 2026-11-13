/**
 * `POST /api/runs/:id/members/mcp` — a team lead run's member tools (ADR-0104 acceptance decisions
 * 3 to 9, issue #1517, spec 04 §5.18).
 *
 * A stateless MCP endpoint over the same JSON-RPC reading as the tool endpoint and the Builder's
 * door (`tool-endpoint/handler.ts`): `initialize`, `ping` and notifications are answered locally,
 * `tools/list` lists one tool per member of the lead run's pinned team version, and `tools/call`
 * starts a child run of that member and answers with its output.
 *
 * The lead run's own run token is the only credential (decision 4): a cookie, an API key or the
 * token of any other run is refused, and so is a lead run that is not running, a child run and a
 * run of no team. A member call is an ordinary run start (`startRunOnSession`) for the person the
 * lead run acts for (decision 9), with `parent_run_id` set to the lead (decision 5): the member
 * runs its own pinned definition met with the ceiling at its own launch, never the lead's, and the
 * person must be allowed to run the member agent (decision 10). The child is awaited until it
 * stops or the lead's run token expires; a tool error is a tool result for the lead, never an HTTP
 * problem, and never carries provider text (only the public failure code of `parseRunFailure`).
 */
import { createHash } from 'node:crypto';

import {
  AGENT_TEAM_CHILD_RUNS_MAX,
  type AgentTeamToolErrorCode,
} from '@indx-workspace/contracts/agent-teams';
import {
  isStoppedRunStatus,
  parseRunFailure,
  RUN_CHILDREN_MAX,
} from '@indx-workspace/contracts/runs';
import type { RunTokenCodec } from '@agent-workspace/gateway/tokens';
import { z } from 'zod';

import { resolveAgentRunOwnership } from '../agents/run-ownership';
import { applicationContext } from '../application-context';
import { systemClock } from '../clock';
import { verifyActiveRunToken, type RunTokenDatabase } from '../integrations';
import type { DirectoryRoot } from '../identity';
import { log } from '../telemetry/logger';
import { answerLocally, readCall, toolCallName } from '../tool-endpoint/handler';
import {
  getRunApi,
  type AgentRef,
  type RunReadEnvironment,
  type RunStartEnvironment,
  type RunPrincipal,
} from '../runs/environment';
import { apiError, isUuid, type RunRecord } from '../execution';
import { interruptRunFor, requireRunPermission } from '../runs/api';
import { MAX_PROMPT_CHARS, startRunOnSession } from '../runs/service';
import type { AgentTeamVersionRecord, LeadRunCaller, MemberCallerVerifier } from './runtime';

/** The path of a lead run's member endpoint, which compose gives the lead as its `agent` server. */
export function memberEndpointPath(runId: string): string {
  return `/api/runs/${runId}/members/mcp`;
}

/** What {@link createMemberCallerVerifier} reads: the token codec, the database and the directory. */
export interface MemberCallerDeps<Scope> {
  readonly tokens: RunTokenCodec;
  readonly database: RunTokenDatabase<Scope>;
  readonly directory: {
    forWorkspace(
      workspaceId: string,
    ): Pick<ReturnType<DirectoryRoot['forWorkspace']>, 'findMembershipByPrincipal'>;
  };
}

/**
 * The member endpoint's verifier: a validly signed, unexpired, unrevoked run token registered for
 * its run, and the person its `caller` claim names. Only a membership caller is a person here.
 * shortcut: a root started by an API key (with or without `subject`) has no person, so its member
 * calls answer `team_member_forbidden`; upgrade when the run token names the key that started the
 * run, as the Builder's door will. `null` deps (no `GATEWAY_TOKEN_SECRET`) verifies nothing.
 */
export function createMemberCallerVerifier<Scope>(
  deps: MemberCallerDeps<Scope> | null,
): MemberCallerVerifier {
  return async (authorization) => {
    if (deps === null) return null;
    const active = await verifyActiveRunToken(authorization, deps.tokens, deps.database);
    if (active === null) return null;
    const { claims } = active;
    const caller = claims.caller;
    const member =
      caller?.principalKind === 'membership'
        ? await deps.directory
            .forWorkspace(claims.workspaceId)
            .findMembershipByPrincipal(caller.sub)
        : null;
    return {
      runId: claims.runId,
      workspaceId: claims.workspaceId,
      expiresAtMs: claims.expiresAt * 1000,
      person:
        member === null
          ? null
          : {
              principalId: member.principalId,
              ownerPrincipalId: member.principalId,
              userId: member.userId,
              workspaceId: claims.workspaceId,
              role: member.role,
              scope: null,
              via: 'session',
              kind: 'membership',
            },
    };
  };
}

/** What the member endpoint is composed of. */
export interface MemberToolsEnvironment {
  readonly verifyCaller: MemberCallerVerifier;
  /** The run routes' environment: the store, the agent and session lookups and the launcher. */
  readonly runs: RunReadEnvironment & RunStartEnvironment;
  /** One team version of the workspace, even of a deleted team; `null` when there is none. */
  readonly teamVersion: (
    workspaceId: string,
    versionId: string,
  ) => Promise<AgentTeamVersionRecord | null>;
  /** Whether `principal` may run `agentId` (`decide()` for `POST /api/agents/:id/runs`). */
  readonly mayRunAgent: (principal: RunPrincipal, agentId: string) => Promise<boolean>;
  /** Epoch milliseconds; defaults to the system clock. */
  readonly now?: () => number;
  /** How often a waiting call reads the child run; defaults to one second. */
  readonly pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;

const MemberCallArgumentsSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(MAX_PROMPT_CHARS),
});

const ToolUseMetaSchema = z.object({
  _meta: z.object({ 'claudecode/toolUseId': z.string().min(1).max(128) }),
});

/** A member tool's input, as `tools/list` publishes it. */
const MEMBER_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_PROMPT_CHARS,
      description: 'The task for this team member, written as a complete request.',
    },
  },
  required: ['prompt'],
  additionalProperties: false,
} as const;

interface ToolAnswer {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  readonly isError: boolean;
}

/** A tool error for the lead: a typed code, a fixed message and, for a failure, its public code. */
function memberToolError(
  code: AgentTeamToolErrorCode,
  message: string,
  failure?: string | null,
): ToolAnswer {
  const body = { ok: false, code, message, ...(failure === undefined ? {} : { failure }) };
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: true };
}

function answered(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: '2.0', id: id ?? null, result });
}

const unauthenticatedMember = (): Response =>
  apiError(401, 'unauthenticated', "this endpoint requires the lead run's run token.");

/** The lead run and its pinned team version, once the token, the path and the run all agree. */
interface Admitted {
  readonly caller: LeadRunCaller;
  readonly lead: RunRecord;
  readonly version: AgentTeamVersionRecord;
}

async function admit(
  request: Request,
  runId: string,
  env: MemberToolsEnvironment,
): Promise<Admitted | Response> {
  const caller = await env.verifyCaller(request.headers.get('authorization'));
  if (caller === null) return unauthenticatedMember();
  if (!isUuid(runId) || caller.runId !== runId) {
    return apiError(403, 'forbidden', 'this run token is not the token of this run.');
  }
  const lead = await env.runs.store.get(runId);
  if (lead?.workspaceId !== caller.workspaceId || lead.status !== 'running') {
    return apiError(403, 'forbidden', 'this run is not running, so it calls no team member.');
  }
  const versionId = lead.agentTeamVersionId ?? null;
  const isRoot = lead.parentRunId === null || lead.parentRunId === undefined;
  const version =
    versionId === null || !isRoot ? null : await env.teamVersion(lead.workspaceId, versionId);
  if (version === null) {
    return apiError(403, 'forbidden', "this run is not an agent team's lead run.");
  }
  return { caller, lead, version };
}

function toolList(version: AgentTeamVersionRecord) {
  return version.members.map((member) => ({
    name: member.name,
    description:
      `Hand a task to the team member "${member.name}" and wait for its answer. The member ` +
      'works with its own instructions and tools; give it everything it needs in the prompt.',
    inputSchema: MEMBER_INPUT_SCHEMA,
  }));
}

/**
 * Whether `principal` may run `agentId`: `decide()` for `POST /api/agents/:id/runs` with the
 * agent's own ownership, exactly as a start of that agent would be decided (decision 10).
 */
async function mayRunAgent(principal: RunPrincipal, agentId: string): Promise<boolean> {
  const probe = new Request(`http://member.invalid/api/agents/${agentId}/runs`, { method: 'POST' });
  const ownership = await resolveAgentRunOwnership(principal, agentId);
  return requireRunPermission(probe, principal, ownership) === null;
}

/** The route's entry: the member endpoint over the installed application context. */
export async function serveLeadRunMembers(request: Request, runId: string): Promise<Response> {
  // A request that presents no credential is unauthenticated whatever this deployment has
  // installed, as at every other route, so it never learns whether team runs are configured.
  if (request.headers.get('authorization') === null) return unauthenticatedMember();
  const runs = getRunApi();
  const teams = applicationContext()?.agentTeams;
  if (runs === null || teams === undefined) {
    return apiError(503, 'agent_teams_not_configured', 'agent team runs are not configured.');
  }
  return serveMemberTools(request, runId, {
    verifyCaller: teams.verifyMemberCaller ?? (() => Promise.resolve(null)),
    runs,
    teamVersion: async (workspaceId, versionId) =>
      (await teams.repository(workspaceId)).getVersion(versionId),
    mayRunAgent,
  });
}

export async function serveMemberTools(
  request: Request,
  runId: string,
  env: MemberToolsEnvironment,
): Promise<Response> {
  if (request.method !== 'POST') {
    const response = apiError(405, 'method_not_allowed', 'this endpoint accepts POST only.');
    response.headers.set('Allow', 'POST');
    return response;
  }
  const admitted = await admit(request, runId, env);
  if (admitted instanceof Response) return admitted;
  const call = await readCall(request);
  if (call instanceof Response) return call;
  const local = answerLocally(call);
  if (local !== null) return local;
  if (call.method === 'tools/list') {
    return answered(call.id, { tools: toolList(admitted.version) });
  }
  let result: ToolAnswer;
  try {
    result = await callMember(request, call.params, admitted, env);
  } catch (error) {
    // Only the run ids are logged: never the error, which may carry SQL, a prompt or a token.
    log.error('agent team member call failed', {
      op: 'agent-teams.member',
      runId: admitted.lead.id,
      workspaceId: admitted.lead.workspaceId,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    result = memberToolError('team_member_failed', 'The team member could not be run.', null);
  }
  return answered(call.id, result);
}

/** The start key of one member call (ADR-0151): the lead run and the engine's tool-use id. */
function memberCallKey(
  lead: RunRecord,
  person: RunPrincipal,
  params: unknown,
  memberName: string,
  prompt: string,
) {
  const toolUseId = ToolUseMetaSchema.safeParse(params).data?._meta['claudecode/toolUseId'];
  if (toolUseId === undefined) return undefined;
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ member: memberName, prompt }))
    .digest('hex');
  return {
    principalId: person.principalId,
    key: `agent-team:${lead.id}:${toolUseId}`,
    requestHash,
  };
}

async function callMember(
  request: Request,
  params: unknown,
  { caller, lead, version }: Admitted,
  env: MemberToolsEnvironment,
): Promise<ToolAnswer> {
  const member = version.members.find((candidate) => candidate.name === toolCallName(params));
  if (member === undefined) {
    return memberToolError('team_member_unknown', 'This team has no member by that name.');
  }
  const args = MemberCallArgumentsSchema.safeParse(
    (params as { arguments?: unknown } | null | undefined)?.arguments,
  );
  if (!args.success) {
    return memberToolError(
      'team_member_invalid_arguments',
      `A member call takes one "prompt" of 1 to ${String(MAX_PROMPT_CHARS)} characters.`,
    );
  }
  const person = caller.person;
  const agent = person === null ? null : await env.runs.findAgent(person, member.agentId);
  if (person === null || agent === null || !(await env.mayRunAgent(person, member.agentId))) {
    return memberToolError(
      'team_member_forbidden',
      'The person this run acts for may not run this team member.',
    );
  }
  const idempotency = memberCallKey(lead, person, params, member.name, args.data.prompt);
  const held =
    idempotency === undefined
      ? null
      : await env.runs.store.findByIdempotencyKey(
          lead.workspaceId,
          idempotency.principalId,
          idempotency.key,
        );
  const child =
    held?.run ??
    (await startMember(env, person, agent, lead, member, args.data.prompt, idempotency));
  if ('code' in child) return child.answer;
  return awaitMember(request, env, person, lead, child, caller.expiresAtMs);
}

type MemberStart = RunRecord | { readonly code: string; readonly answer: ToolAnswer };

/** Start the child run, reusing the member's session of this tree when its last run has stopped. */
async function startMember(
  env: MemberToolsEnvironment,
  person: RunPrincipal,
  agent: AgentRef,
  lead: RunRecord,
  member: AgentTeamVersionRecord['members'][number],
  prompt: string,
  idempotency: ReturnType<typeof memberCallKey>,
): Promise<MemberStart> {
  const children = await env.runs.store.listChildren(lead.workspaceId, lead.id, RUN_CHILDREN_MAX);
  const previous = children.filter((child) => child.agentId === member.agentId).at(-1);
  const sessionId =
    previous !== undefined && isStoppedRunStatus(previous.status) ? previous.sessionId : null;
  const started = await startRunOnSession(env.runs, person, agent, {
    prompt,
    sessionId,
    modelOverride: null,
    ...(sessionId === null ? { agentVersionId: member.agentVersionId } : {}),
    ...(lead.subject === null || lead.subject === undefined ? {} : { subject: lead.subject }),
    ...(idempotency === undefined ? {} : { idempotency }),
    parent: { runId: lead.id, maxChildren: AGENT_TEAM_CHILD_RUNS_MAX },
  });
  if (started.kind === 'started') return started.run;
  if (started.code === 'team_member_limit') {
    return {
      code: started.code,
      answer: memberToolError(
        'team_member_limit',
        `This run already started ${String(AGENT_TEAM_CHILD_RUNS_MAX)} member runs; answer without this member.`,
      ),
    };
  }
  return {
    code: started.code,
    answer: memberToolError(
      'team_member_refused',
      'The team member could not be started.',
      started.code,
    ),
  };
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Wait for the child to stop, reading it and the lead every poll interval, until the lead's token
 * expires, the lead's request is abandoned or the lead stops (an interrupt of the root, whose
 * cascade may have read the children before this one was inserted). A child left running then is
 * interrupted, so a member never outlives the call that started it, nor the lead.
 */
async function awaitMember(
  request: Request,
  env: MemberToolsEnvironment,
  person: RunPrincipal,
  lead: RunRecord,
  child: RunRecord,
  deadlineMs: number,
): Promise<ToolAnswer> {
  const now = env.now ?? (() => systemClock.now().getTime());
  const interval = env.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let current: RunRecord | null = child;
  let leadRunning = true;
  while (current !== null && !isStoppedRunStatus(current.status)) {
    if (!leadRunning) {
      await interruptRunFor(env.runs, person, current);
      return memberToolError(
        'team_member_cancelled',
        'This run was stopped, so the team member run was stopped too.',
      );
    }
    if (request.signal.aborted || now() >= deadlineMs) {
      await interruptRunFor(env.runs, person, current);
      return memberToolError(
        'team_member_timeout',
        'The team member did not answer before this run ran out of time; it was stopped.',
      );
    }
    await sleep(Math.max(0, Math.min(interval, deadlineMs - now())), request.signal);
    leadRunning = (await env.runs.store.get(lead.id))?.status === 'running';
    current = await env.runs.store.get(child.id);
  }
  return memberAnswer(current);
}

/** The stopped child as the lead's tool result: its output text, or a typed tool error. */
export function memberAnswer(run: RunRecord | null): ToolAnswer {
  switch (run?.status) {
    case 'completed':
      return { content: [{ type: 'text', text: run.output?.text ?? '' }], isError: false };
    case 'cancelled':
      return memberToolError('team_member_cancelled', 'The team member run was cancelled.');
    case 'awaiting_approval':
      return memberToolError(
        'team_member_paused',
        'The team member is waiting for a person to approve a tool call; answer without it.',
      );
    case 'failed':
      return memberToolError(
        'team_member_failed',
        'The team member run failed.',
        parseRunFailure(run.error)?.code ?? null,
      );
    default:
      return memberToolError('team_member_failed', 'The team member run could not be read.', null);
  }
}
