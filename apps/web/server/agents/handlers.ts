/**
 * The five agent operations of spec §34, as functions of a store and a parsed body.
 *
 * Nothing here touches `Request` or `Response`. A handler takes a {@link WorkspaceAgentStore} that
 * is already bound to one workspace, plus whatever the client sent, and returns a status and a
 * body. `http.ts` does the HTTP; `app/api/agents/**` does the Next.js. Keeping the three apart is
 * what lets the interesting half — status codes, conflict mapping, tenant scoping — be tested
 * without constructing a web request or booting a server.
 *
 * ## The five, and only the five (spec §34)
 *
 *   POST   /api/agents        {@link createAgent}
 *   GET    /api/agents        {@link listAgents}
 *   GET    /api/agents/:id    {@link getAgent}
 *   PATCH  /api/agents/:id    {@link updateAgent}
 *   DELETE /api/agents/:id    {@link deleteAgent}
 *
 * There is no search, no bulk and no count operation, and `tests/route-inventory.test.ts` fails the
 * build if one appears as a route.
 */
import { isUuid, parseCreateAgentInput, parseUpdateAgentPatch, toAgentResource } from './contract';
import type { AgentResource, CreateAgentInput, UpdateAgentPatch } from '../../contracts/agents';
import type { WorkspaceAgentStore } from './store';

/**
 * A check a write runs after its body parses and before the store writes (issue #535: the
 * deployment's policy ceiling). A non-`null` result is answered instead of the write.
 */
export type WriteJudge<T> = (value: T) => Promise<ApiResult | null>;

/** A status and a body, before either becomes an HTTP response. `body: null` means "no content". */
export interface ApiResult {
  readonly status: number;
  readonly body: unknown;
}

/** The error envelope every failing route returns. One shape, so a client parses errors once. */
export interface ApiProblem {
  readonly error: {
    readonly code: string;
    readonly message: string;
    /** Present only when there is more to say than the message — e.g. per-field parse errors. */
    readonly details?: readonly string[];
  };
}

/** Build a problem result. `details` is omitted rather than set to `undefined` (`exactOptionalPropertyTypes`). */
export function problem(
  status: number,
  code: string,
  message: string,
  details?: readonly string[],
): ApiResult {
  const error =
    details === undefined || details.length === 0
      ? { code, message }
      : { code, message, details: [...details] };
  return { status, body: { error } satisfies ApiProblem };
}

/**
 * Validate a path id before it reaches the store.
 *
 * `agents.id` is a `uuid` column, so a non-UUID cannot match a row: without this check the route
 * would answer `404` for `/api/agents/banana`, which is true but unhelpful, and on some drivers it
 * would surface as a 500 from a failed cast instead. Parsing before comparing is also the ADR-0015
 * rule — the value's shape is established first, and only then is it used.
 */
export function requireAgentId(
  raw: unknown,
): { ok: true; id: string } | { ok: false; result: ApiResult } {
  if (isUuid(raw)) return { ok: true, id: raw };
  return {
    ok: false,
    result: problem(400, 'invalid_agent_id', 'The agent id in the path is not a UUID.'),
  };
}

/**
 * `POST /api/agents` — 201 with the created agent, or 400 / 409 naming what went wrong.
 *
 * `createdBy` is `memberships.user_id` of the authenticated caller, resolved by the route layer
 * (issue #117) — it never comes from `rawBody`, so a client cannot claim another member's identity
 * as the creator of a row it is creating.
 */
export async function createAgent(
  store: WorkspaceAgentStore,
  rawBody: unknown,
  owner: { readonly principalId: string; readonly userId: string | null },
  judge?: WriteJudge<CreateAgentInput>,
): Promise<ApiResult> {
  const parsed = parseCreateAgentInput(rawBody);
  if (!parsed.ok) {
    return problem(
      400,
      'invalid_body',
      'The agent could not be created from this body.',
      parsed.errors,
    );
  }
  const refused = judge === undefined ? null : await judge(parsed.value);
  if (refused !== null) return refused;
  const outcome = await store.create(parsed.value, owner);
  switch (outcome.kind) {
    case 'created':
      return { status: 201, body: toAgentResource(outcome.agent) };
    case 'name-conflict':
      return problem(
        409,
        'agent_name_conflict',
        `This workspace already has an agent named ${JSON.stringify(outcome.name)}.`,
      );
    case 'unknown-model-connection':
      return problem(
        400,
        'unknown_model_connection',
        'modelConnectionId does not name a model connection in this workspace.',
      );
    case 'unknown-runtime-profile':
      return problem(
        400,
        'unknown_runtime_profile',
        'runtimeProfileId does not name a runtime profile in this workspace.',
      );
    default: {
      // Total: adding an outcome to CreateAgentOutcome without handling it is a compile error.
      const unreachable: never = outcome;
      return problem(
        500,
        'unhandled_store_outcome',
        `The store returned an outcome this route does not handle: ${JSON.stringify(unreachable)}.`,
      );
    }
  }
}

/** `GET /api/agents` — 200 with this workspace's agents. Never another workspace's (§25). */
export async function listAgents(store: WorkspaceAgentStore): Promise<ApiResult> {
  const agents = await store.list();
  const items: AgentResource[] = agents.map(toAgentResource);
  return { status: 200, body: { agents: items } };
}

/** `GET /api/agents/:id` — 200, or 404 for an id this workspace does not have. */
export async function getAgent(store: WorkspaceAgentStore, rawId: unknown): Promise<ApiResult> {
  const id = requireAgentId(rawId);
  if (!id.ok) return id.result;
  const agent = await store.get(id.id);
  if (agent === null) return agentNotFound();
  return { status: 200, body: toAgentResource(agent) };
}

/**
 * `PATCH /api/agents/:id` — 200 with the updated agent, or 400 / 404 / 409.
 *
 * `write`, when given, replaces `store.update` (issue #616: the route saves a console edit as a
 * version, which this module cannot import without a cycle). It answers a refusal, or `null` once
 * the patch is written, and the agent is then read back for the response.
 */
export async function updateAgent(
  store: WorkspaceAgentStore,
  rawId: unknown,
  rawBody: unknown,
  judge?: WriteJudge<UpdateAgentPatch>,
  write?: WriteJudge<UpdateAgentPatch>,
): Promise<ApiResult> {
  const id = requireAgentId(rawId);
  if (!id.ok) return id.result;
  const parsed = parseUpdateAgentPatch(rawBody);
  if (!parsed.ok) {
    return problem(
      400,
      'invalid_body',
      'The agent could not be updated from this body.',
      parsed.errors,
    );
  }
  const refused = judge === undefined ? null : await judge(parsed.value);
  if (refused !== null) return refused;
  if (write !== undefined) {
    const unwritten = await write(parsed.value);
    if (unwritten !== null) return unwritten;
    const written = await store.get(id.id);
    return written === null ? agentNotFound() : { status: 200, body: toAgentResource(written) };
  }
  const outcome = await store.update(id.id, parsed.value);
  switch (outcome.kind) {
    case 'updated':
      return { status: 200, body: toAgentResource(outcome.agent) };
    case 'not-found':
      return agentNotFound();
    case 'name-conflict':
      return problem(
        409,
        'agent_name_conflict',
        `This workspace already has an agent named ${JSON.stringify(outcome.name)}.`,
      );
    case 'unknown-model-connection':
      return problem(
        400,
        'unknown_model_connection',
        'modelConnectionId does not name a model connection in this workspace.',
      );
    case 'unknown-runtime-profile':
      return problem(
        400,
        'unknown_runtime_profile',
        'runtimeProfileId does not name a runtime profile in this workspace.',
      );
    default: {
      const unreachable: never = outcome;
      return problem(
        500,
        'unhandled_store_outcome',
        `The store returned an outcome this route does not handle: ${JSON.stringify(unreachable)}.`,
      );
    }
  }
}

/**
 * `DELETE /api/agents/:id` — 204 with no body, or 404.
 *
 * Deleting twice is a 404, not a 204. The alternative — reporting success for a row that was never
 * there — hides the case where a client is deleting an id belonging to a workspace it cannot see,
 * which is precisely the case §25 makes it worth being exact about.
 */
export async function deleteAgent(store: WorkspaceAgentStore, rawId: unknown): Promise<ApiResult> {
  const id = requireAgentId(rawId);
  if (!id.ok) return id.result;
  const outcome = await store.delete(id.id);
  switch (outcome.kind) {
    case 'deleted':
      return { status: 204, body: null };
    case 'not-found':
      return agentNotFound();
    default: {
      const unreachable: never = outcome;
      return problem(
        500,
        'unhandled_store_outcome',
        `The store returned an outcome this route does not handle: ${JSON.stringify(unreachable)}.`,
      );
    }
  }
}

/**
 * The one 404 the agent routes emit.
 *
 * Its message deliberately does not distinguish "no such agent" from "an agent you cannot see":
 * saying which would confirm the existence of a row in another workspace.
 */
/** The one 404 body every agent item route answers with. Exported so route files that must build
 *  an {@link import('../resources/item-ownership').OwnershipResolver} can reuse it verbatim. */
export function agentNotFound(): ApiResult {
  return problem(404, 'agent_not_found', 'This workspace has no agent with that id.');
}
