/**
 * `agentPanelRoutes`: the server half of the agent panel bound to a record (issue #1509), as the
 * Next.js handlers of one catch-all route, `app/api/agent-panel/[...path]/route.ts`:
 *
 * ```ts
 * export const { GET, POST } = agentPanelRoutes({
 *   resources: [ticket],
 *   agents: { triage: process.env.AW_TRIAGE_AGENT_ID },
 * });
 * ```
 *
 * | Route                                                   | Does                                       |
 * | ------------------------------------------------------- | ------------------------------------------ |
 * | `POST /api/agent-panel/:resource/:id/runs`              | starts a run about the record              |
 * | `GET /api/agent-panel/:resource/:id/runs/:runId`        | the run, with the call it waits on         |
 * | `GET /api/agent-panel/:resource/:id/runs/:runId/events` | the run's events, resumed by Last-Event-ID |
 * | `POST /api/agent-panel/:resource/:id/runs/:runId/approval` | approves or rejects that call           |
 *
 * Every request is the signed-in person's: Agent Workspace says who they are, the resource's own
 * read `access` says whether they may see the record, and every platform call is made with the
 * person's own token, so the platform's role, agent grants and audit trail are theirs (ADR-0161).
 * An agent never exceeds the person.
 *
 * The panel keeps the platform sessions of each record, agent and person (`agent_panel_sessions`),
 * so a person's second prompt continues their own conversation; two people on one record never
 * continue or replace each other's. A session is never overwritten, so a run of an older one that
 * is still going stays the record's. A run is served only when its session is one the record has
 * had, and it is read with the person's own token, so these routes never become a way to read any
 * other run.
 *
 * Every failure is the one problem envelope (ADR-0075). A refusal of Agent Workspace's is passed on
 * by its code and status only, never its words.
 */
import type { RunResource } from '@indx-workspace/contracts/runs';
import { RunApprovalRequestSchema } from '@indx-workspace/contracts/runs';
import {
  AgentWorkspaceError,
  ApiProblemError,
  createClient,
  type AgentWorkspaceClient,
} from '@indx-workspace/sdk';
import { z } from 'zod';

import {
  agentPanelPath,
  AgentKeySchema,
  AgentPanelStartRequestSchema,
  type AgentPanelRun,
} from '../agent-panel-wire.js';
import type { AgentPanelKey } from '../db/agent-panel-sessions.js';
import { recordIdOf } from '../db/policy.js';
import type { Person } from '../person.js';
import type { DefinedResource } from '../resource.js';
import { panelSseResponse } from './agent-panel-sse.js';
import { currentPerson, personAuthOf } from './person.js';
import { NO_STORE, problem } from './problem.js';
import { jsonBodyOf, refusalOf, RequestRefusal } from './routes.js';
import { appRuntime, type AppRuntime } from './runtime.js';
import { WIRE_EVENT_ID } from './sse.js';

/** What {@link agentPanelRoutes} serves: the resources whose records have a panel, and its agents. */
export interface AgentPanelOptions {
  readonly resources: readonly DefinedResource[];
  /**
   * The agents the panel offers, by the panel's name for each (`triage`), to the Agent Workspace
   * agent id. An id may come from the environment, so `undefined` is accepted here and answered
   * `500 agent_panel_misconfigured` when that agent is asked for.
   */
  readonly agents: Readonly<Record<string, string | undefined>>;
}

/** What Next.js 16 passes the catch-all route's handlers besides the request. */
export interface AgentPanelRouteContext {
  readonly params: Promise<{ readonly path?: readonly string[] }>;
}

/** One handler of `app/api/agent-panel/[...path]/route.ts`. */
export type AgentPanelHandler = (
  request: Request,
  context: AgentPanelRouteContext,
) => Promise<Response>;

/** The handlers of `app/api/agent-panel/[...path]/route.ts`. */
export interface AgentPanelRoutes {
  readonly GET: AgentPanelHandler;
  readonly POST: AgentPanelHandler;
}

/** The fixed words of each refusal the panel's routes make themselves. */
const MESSAGES = {
  unauthenticated: 'Sign in to Agent Workspace to use this app.',
  not_found: 'No such record, or you cannot see it.',
  run_not_found: 'No such run for this record.',
  agent_not_offered: 'This agent is not offered on this record.',
  misconfigured: 'The agent panel is not configured: every offered agent needs its agent id.',
  session_busy:
    'The agent is still working on this record. Wait for it to finish, then send again.',
  refused: 'Agent Workspace refused the request.',
  upstream: 'Agent Workspace did not answer as expected. Try again later.',
  invalid_last_event_id: 'The Last-Event-ID header is not an event id of this stream.',
} as const;

/** A code Agent Workspace answered with, safe to pass on: snake_case, bounded. */
const PROBLEM_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** The platform refuses a stored session it cannot continue with these; a new one is started. */
const STALE_SESSION_CODES = new Set(['session_not_usable', 'session_engine_mismatch']);

const AgentsSchema = z.record(AgentKeySchema, z.string().optional());

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { 'cache-control': NO_STORE } });
}

/** The panel's view of a run: never its usage, cost or output. */
function panelRunOf(run: RunResource): AgentPanelRun {
  return {
    id: run.id,
    status: run.status,
    pendingApproval: run.status === 'awaiting_approval' ? run.pendingApproval : null,
    error: run.error,
  };
}

/**
 * The answer for a failure of Agent Workspace's: a refusal (`4xx`) by its code and status, with
 * the panel's own words; anything else `502 upstream_failure`.
 */
function upstreamProblem(error: unknown): Response {
  if (error instanceof ApiProblemError && error.status >= 400 && error.status < 500) {
    const code = PROBLEM_CODE.test(error.code) ? error.code : 'upstream_refused';
    return problem(
      code,
      error.status,
      code === 'session_busy' ? MESSAGES.session_busy : MESSAGES.refused,
    );
  }
  return problem('upstream_failure', 502, MESSAGES.upstream);
}

/** Where a request points: a resource's record, and what of its panel. */
interface PanelRequest {
  readonly resource: DefinedResource;
  readonly recordId: string;
  /** `[]` for `…/runs`, `[runId]`, `[runId, 'events']` or `[runId, 'approval']`. */
  readonly rest: readonly string[];
}

/** Everything a panel operation runs with, once the person may see the record. */
interface PanelScope extends PanelRequest {
  readonly person: Person;
  readonly runtime: AppRuntime;
  readonly client: AgentWorkspaceClient;
}

class PanelRefusal extends RequestRefusal {}

function notFound(): PanelRefusal {
  return new PanelRefusal('resource_not_found', 404, MESSAGES.not_found);
}

function panelRequestOf(
  resources: ReadonlyMap<string, DefinedResource>,
  path: readonly string[],
): PanelRequest {
  const [name, id, runs, ...rest] = path;
  const resource = name === undefined ? undefined : resources.get(name);
  const recordId = id === undefined ? undefined : recordIdOf(id);
  if (resource === undefined || recordId === undefined || runs !== 'runs') throw notFound();
  return { resource, recordId, rest };
}

/** The person, their client, and the record read as them; any refusal is thrown. */
async function scopeOf(request: Request, target: PanelRequest): Promise<PanelScope> {
  const runtime = appRuntime();
  const store = runtime.storeOf(target.resource);
  const person = await currentPerson(request);
  const auth = personAuthOf(request);
  if (person === null || auth === undefined) {
    throw new PanelRefusal('unauthenticated', 401, MESSAGES.unauthenticated);
  }
  // The resource's own read `access`: a record the person cannot see is `404`, as is a missing one.
  await store.get(person, target.recordId);
  const client = createClient({
    baseUrl: runtime.awUrl,
    auth,
    ...(runtime.fetch === undefined ? {} : { fetch: runtime.fetch }),
  });
  return { ...target, person, runtime, client };
}

function keyOf(scope: PanelScope, agent: string): AgentPanelKey {
  return {
    workspaceId: scope.person.workspaceId,
    resource: scope.resource.name,
    recordId: scope.recordId,
    agent,
    principalId: scope.person.principalId,
  };
}

/** The run `runId`, read as the person, when its session is one of this record's. */
async function recordRunOf(scope: PanelScope, runId: string): Promise<RunResource> {
  const notThisRecords = new PanelRefusal('run_not_found', 404, MESSAGES.run_not_found);
  if (!RUN_ID.test(runId)) throw notThisRecords;
  const run = await scope.client.runs.get(runId);
  const sessions = await scope.runtime.agentPanelSessions.sessionsOf(
    scope.person.workspaceId,
    scope.resource.name,
    scope.recordId,
  );
  if (!sessions.includes(run.sessionId)) throw notThisRecords;
  return run;
}

function invalidBody(error: z.ZodError): PanelRefusal {
  return new PanelRefusal(
    'invalid_body',
    400,
    'The request body is not valid.',
    error.issues.map((issue) => issue.path.map(String).join('.') || '$'),
  );
}

function startedAnswer(scope: PanelScope, run: RunResource): Response {
  const events = agentPanelPath(scope.resource.name, scope.recordId, 'runs', run.id, 'events');
  return Response.json(
    { run: panelRunOf(run), events },
    { status: 202, headers: { 'cache-control': NO_STORE, location: events } },
  );
}

async function startRun(
  scope: PanelScope,
  agents: Readonly<Record<string, string | undefined>>,
  request: Request,
): Promise<Response> {
  const parsed = AgentPanelStartRequestSchema.safeParse(await jsonBodyOf(request));
  if (!parsed.success) throw invalidBody(parsed.error);
  const { agent, prompt } = parsed.data;
  if (!Object.hasOwn(agents, agent)) {
    throw new PanelRefusal('agent_not_offered', 403, MESSAGES.agent_not_offered);
  }
  const agentId = agents[agent];
  if (agentId === undefined || agentId.trim() === '') {
    throw new PanelRefusal('agent_panel_misconfigured', 500, MESSAGES.misconfigured);
  }
  const key = keyOf(scope, agent);
  const stored = await scope.runtime.agentPanelSessions.find(key);
  const input = { prompt: `${scope.resource.name} ${scope.recordId}: ${prompt}` };
  let started;
  try {
    started = await scope.client.runs.start(agentId, { ...input, sessionId: stored });
  } catch (error) {
    // A session the platform will no longer continue is replaced, once; `session_busy` is not.
    if (!(
      stored !== null &&
      error instanceof ApiProblemError &&
      STALE_SESSION_CODES.has(error.code)
    )) {
      throw error;
    }
    started = await scope.client.runs.start(agentId, input);
  }
  await scope.runtime.agentPanelSessions.save(key, started.run.sessionId);
  return startedAnswer(scope, started.run);
}

async function decide(scope: PanelScope, runId: string, request: Request): Promise<Response> {
  await recordRunOf(scope, runId);
  // Parsed after the run is known to be this record's, so a caller learns nothing from it first.
  const parsed = RunApprovalRequestSchema.safeParse(await jsonBodyOf(request));
  if (!parsed.success) throw invalidBody(parsed.error);
  const { decision, comment } = parsed.data;
  const input = comment === undefined ? {} : { comment };
  const decided =
    decision === 'approve'
      ? await scope.client.runs.approve(runId, input)
      : await scope.client.runs.reject(runId, input);
  return startedAnswer(scope, decided.run);
}

async function follow(scope: PanelScope, runId: string, request: Request): Promise<Response> {
  const lastEventId = request.headers.get('last-event-id');
  if (lastEventId !== null && !WIRE_EVENT_ID.test(lastEventId)) {
    throw new PanelRefusal('invalid_last_event_id', 400, MESSAGES.invalid_last_event_id);
  }
  await recordRunOf(scope, runId);
  const abort = new AbortController();
  request.signal.addEventListener('abort', () => abort.abort(), { once: true });
  const frames = scope.client.runs.follow(runId, { after: lastEventId, signal: abort.signal });
  return panelSseResponse(frames, abort);
}

function failureOf(error: unknown): Response {
  if (error instanceof AgentWorkspaceError) return upstreamProblem(error);
  return refusalOf(error);
}

/**
 * The handlers of the agent panel's catch-all route, for `resources` and the `agents` offered on
 * each of their records.
 *
 * | Status | Code                                                                                   |
 * | ------ | -------------------------------------------------------------------------------------- |
 * | 202    | a run started, or a decision's continuation, with `{ run, events }`                    |
 * | 400    | `invalid_body`, `malformed_body`, `invalid_last_event_id`                              |
 * | 401    | `unauthenticated`                                                                      |
 * | 403    | `agent_not_offered`; Agent Workspace's own refusal (an agent the person may not run)   |
 * | 404    | `resource_not_found` (no record, or one the person cannot read), `run_not_found`       |
 * | 409    | `session_busy` (the agent is still working), Agent Workspace's approval conflicts       |
 * | 413    | `request_body_too_large`                                                               |
 * | 415    | `unsupported_media_type`                                                               |
 * | 500    | `app_misconfigured`, `agent_panel_misconfigured`, `internal_error`                     |
 * | 502    | `upstream_failure`                                                                     |
 *
 * @throws {TypeError} when an agent's name is not lower-case, starting with a letter, at most 63
 *   characters, or two resources share a name.
 */
export function agentPanelRoutes(options: AgentPanelOptions): AgentPanelRoutes {
  const agents = AgentsSchema.safeParse(options.agents);
  if (!agents.success) {
    throw new TypeError('agentPanelRoutes: every agent name must match /^[a-z][a-z0-9_-]{0,62}$/.');
  }
  const offered = Object.freeze({ ...agents.data });
  const resources = new Map<string, DefinedResource>();
  for (const resource of options.resources) {
    if (resources.has(resource.name)) {
      throw new TypeError(`agentPanelRoutes: two resources are named ${resource.name}.`);
    }
    resources.set(resource.name, resource);
  }

  const serve =
    (operation: (scope: PanelScope, request: Request) => Promise<Response>): AgentPanelHandler =>
    async (request, context) => {
      try {
        const { path } = await context.params;
        const target = panelRequestOf(resources, path ?? []);
        return await operation(await scopeOf(request, target), request);
      } catch (error) {
        return failureOf(error);
      }
    };

  return {
    GET: serve(async (scope, request) => {
      const [runId, events, ...extra] = scope.rest;
      if (runId === undefined || extra.length > 0) throw notFound();
      if (events === 'events') return follow(scope, runId, request);
      if (events !== undefined) throw notFound();
      return json(200, { run: panelRunOf(await recordRunOf(scope, runId)) });
    }),
    POST: serve(async (scope, request) => {
      const [runId, approval, ...extra] = scope.rest;
      if (runId === undefined) return startRun(scope, offered, request);
      if (approval !== 'approval' || extra.length > 0) throw notFound();
      return decide(scope, runId, request);
    }),
  };
}
