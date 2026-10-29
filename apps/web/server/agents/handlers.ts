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
import type { AgentListArchived } from '@indx-workspace/contracts/agents';

import { isUuid, toAgentResource, type AgentRecord } from './contract';
import {
  agentRequestIssueMessages,
  BUILTIN_AGENT_PROBLEM_CODES,
  CreateAgentInputSchema,
  UpdateAgentPatchSchema,
  type AgentResource,
  type AgentResourceAssignmentsInput,
  type BuiltinAgentOperation,
  type CreateAgentInput,
  type UpdateAgentPatch,
} from '../../contracts/agents';
import type {
  CreateAgentOutcome,
  CreateAgentWithAssignmentsOutcome,
  WorkspaceAgentStore,
} from './store';
import { problem, type ApiResult } from '../http/result';
import type { Principal } from '../rbac/principal';

/**
 * A check a write runs after its body parses and before the store writes (issue #535: the
 * deployment's policy ceiling). A non-`null` result is answered instead of the write.
 */
export type WriteJudge<T> = (value: T) => Promise<ApiResult | null>;

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
  assignments?: AgentResourceAssignmentsInput,
): Promise<ApiResult> {
  const parsed = CreateAgentInputSchema.safeParse(rawBody);
  if (!parsed.success) {
    return problem(
      400,
      'invalid_body',
      'The agent could not be created from this body.',
      agentRequestIssueMessages(parsed.error.issues),
    );
  }
  const refused = judge === undefined ? null : await judge(parsed.data);
  if (refused !== null) return refused;
  // W2-3: with assignments, the row and its assignments are one store write, so a refused
  // assignment leaves no agent behind and there is nothing to compensate.
  const outcome: CreateAgentOutcome | CreateAgentWithAssignmentsOutcome =
    assignments === undefined
      ? await store.create(parsed.data, owner)
      : await store.createWithAssignments(parsed.data, owner, assignments);
  switch (outcome.kind) {
    case 'created':
      return {
        status: 201,
        body:
          'assignments' in outcome
            ? { agent: toAgentResource(outcome.agent), assignments: outcome.assignments }
            : toAgentResource(outcome.agent),
      };
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
    // A missing referenced resource is the caller's to correct, as a missing model connection is.
    case 'unknown-file':
      return problem(400, 'unknown_file', 'An assigned file is not in this workspace.', [
        outcome.id,
      ]);
    case 'unknown-skill':
      return problem(400, 'unknown_skill', 'An assigned skill is not in this workspace.', [
        outcome.id,
      ]);
    // The skill exists but is being deleted: a conflict with its state, not a missing reference.
    case 'skill-deleting':
      return problem(409, 'skill_deleting', 'An assigned skill is being deleted.', [outcome.id]);
    case 'unknown-skill-revision':
      return problem(
        400,
        'unknown_skill_revision',
        'A pinned skill revision is not published in this workspace.',
        [`${outcome.id}@${String(outcome.revision)}`],
      );
    case 'unknown-connector':
      return problem(400, 'unknown_connector', 'An assigned connector is not in this workspace.', [
        outcome.id,
      ]);
    default: {
      // Total: adding an outcome without handling it is a compile error.
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
 * `GET /api/agents` — 200 with this workspace's agents, built-ins last (the sort is stable, so the
 * rest keep the store's order). Never another workspace's (§25). Archived agents are left out
 * unless `archived` is `include`; the filter only removes rows, so `include` shows nobody the
 * caller could not already list. It sits here and not in the store because the provisioning and
 * endpoint code read every row from `store.list()`.
 */
export async function listAgents(
  store: WorkspaceAgentStore,
  archived?: AgentListArchived,
): Promise<ApiResult> {
  const agents = await store.list();
  const items: AgentResource[] = agents
    .filter((agent) => archived === 'include' || agent.archivedAt === undefined)
    .map(toAgentResource)
    .sort((a, b) => Number(a.builtin !== undefined) - Number(b.builtin !== undefined));
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
  const parsed = UpdateAgentPatchSchema.safeParse(rawBody);
  if (!parsed.success) {
    return problem(
      400,
      'invalid_body',
      'The agent could not be updated from this body.',
      agentRequestIssueMessages(parsed.error.issues),
    );
  }
  const refused = judge === undefined ? null : await judge(parsed.data);
  if (refused !== null) return refused;
  if (write !== undefined) {
    const unwritten = await write(parsed.data);
    if (unwritten !== null) return unwritten;
    const written = await store.get(id.id);
    return written === null ? agentNotFound() : { status: 200, body: toAgentResource(written) };
  }
  const outcome = await store.update(id.id, parsed.data);
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
 * `POST /api/agents/:id/restore` — 200 with the agent, or 404.
 *
 * An agent that is not archived answers 200 as it is and writes no audit row, so a retry after a
 * lost response is safe.
 */
export async function restoreAgent(
  store: WorkspaceAgentStore,
  rawId: unknown,
  principal: Principal,
): Promise<ApiResult> {
  const id = requireAgentId(rawId);
  if (!id.ok) return id.result;
  const outcome = await store.restore(id.id, {
    principalId: principal.principalId,
    userId: principal.userId,
    label: principal.actor,
  });
  switch (outcome.kind) {
    case 'restored':
    case 'not-archived':
      return { status: 200, body: toAgentResource(outcome.agent) };
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

/**
 * Whether a built-in agent refuses each operation: every change to it is refused, while reading,
 * evaluating and exporting it stay open so people may inspect and evaluate the Builder. Advancing an
 * evaluation run only runs and scores its cases; promote, which reads the score, stays refused.
 */
const BUILTIN_AGENT_REFUSES: Readonly<Record<BuiltinAgentOperation, boolean>> = {
  read: false,
  update: true,
  delete: true,
  'update-policy': true,
  'replace-resources': true,
  'replace-grants': true,
  'create-version': true,
  'set-pointer': true,
  promote: true,
  rollback: true,
  'advance-evaluation': false,
  evaluate: false,
  'start-evaluation-run': false,
  export: false,
  'export-archive': false,
};

/**
 * The refusal of `operation` on a built-in agent (#1848), or `null` for any other agent or an
 * operation a built-in allows. Called by the resolvers before `decide()`, so every role, Owner
 * included, is answered the same. Running the agent is another route and never reaches here.
 */
export function refuseBuiltinWrite(
  agent: Pick<AgentRecord, 'builtin'> | null,
  operation: BuiltinAgentOperation,
): ApiResult | null {
  if (agent?.builtin === undefined || !BUILTIN_AGENT_REFUSES[operation]) return null;
  return problem(
    BUILTIN_AGENT_PROBLEM_CODES.builtin_agent_read_only,
    'builtin_agent_read_only',
    'This is a built-in agent; the platform manages it and it cannot be changed.',
  );
}
