/**
 * The HTTP edge of `GET`/`POST /api/agents/:id/versions` (S1-05, issue #443) and
 * `PUT /api/agents/:id/pointers` (S1-06, issue #444): authorisation, the runtimes, and the bounded
 * body readers, so each route file holds two calls and nothing else.
 *
 * Authorisation follows the sibling agent sub-routes' (`[id]/policy/route.ts`): an ownership
 * resolver refuses an id that is not a UUID with `400 invalid_agent_id` (the code
 * `AGENT_VERSION_PROBLEM_CODES` publishes), loads the agent in the caller's workspace and refuses
 * a foreign or missing one with `404 agent_not_found` before `decide()` compares owners, then `requireResourceAccess` answers
 * RBAC's `403 forbidden` — a Viewer's `POST`, a Builder on another principal's agent — before any
 * handler runs. The agent row the resolver read is handed on, so the handler decides against the
 * row RBAC decided on rather than a second read.
 */
import { AGENT_VERSION_PROBLEM_CODES } from '@indx-workspace/contracts/agent-versions';

import type { AgentRecord } from '../agents/contract';
import { isUuid } from '../agents/contract';
import { agentNotFound, problem, type ApiResult } from '../agents/handlers';
import { readAgentIdParam, toResponse } from '../agents/http';
import type { AgentPolicy } from '../../contracts/agents';
import { connectorNamesOf, storedConnectorServers } from '../agents/policy';
import { currentAgentsRuntime } from '../agents/runtime';
import { readBoundedJson } from '../http/json-transport';
import type { OwnershipResolver } from '../rbac/http';
import type { Principal } from '../rbac/principal';
import type { RequestCeiling } from '../policy-ceiling/ceiling';
import { requireResourceAccess } from '../resources/authorise';
import type { ToolBundleLookup } from '../tool-bundles/handlers';
import { openToolBundleLookup } from '../tool-bundles/http';
import {
  MAX_AGENT_VERSION_BODY_BYTES,
  MAX_CREATE_AGENT_BODY_BYTES,
  MAX_POINTER_BODY_BYTES,
} from './contract';
import { currentAgentVersionsRuntime, type AgentVersionsRuntime } from './runtime';
import type { WorkspaceAgentVersionStore } from './store';
import { saveUiEdit, type UiEdit } from './ui-edit';

/** What a version route handler runs with once the caller is allowed onto the agent. */
export interface AgentVersionRouteScope {
  readonly agent: AgentRecord;
  readonly principal: Principal;
  readonly store: WorkspaceAgentVersionStore;
  /** The deployment's policy ceiling bound to this request, or `null` when there is none. */
  readonly ceiling: RequestCeiling | null;
  /** The caller's tool bundles, or `null` when the deployment keeps none (issue #790). */
  readonly toolBundles: ToolBundleLookup | null;
  /** Whether the deployment has a tool host, so a code-tool version may leave `local`. */
  readonly toolHost: boolean;
  /** Why the tool sandbox cannot enforce a code tool's `allowedDomains`, or `null` when it can. */
  readonly toolDomainsRefusal: string | null;
}

/** A resolver that also keeps the row it read, for the handler to use. */
function loadingOwnership(id: unknown): {
  readonly resolver: OwnershipResolver;
  readonly loaded: { agent: AgentRecord | null };
} {
  const loaded: { agent: AgentRecord | null } = { agent: null };
  const resolver: OwnershipResolver = async (principal) => {
    const agents = currentAgentsRuntime();
    if (agents === null) return { kind: 'refuse', result: agentNotFound() };
    if (!isUuid(id)) {
      return {
        kind: 'refuse',
        result: problem(
          AGENT_VERSION_PROBLEM_CODES.invalid_agent_id,
          'invalid_agent_id',
          'The agent id is not a UUID.',
        ),
      };
    }
    loaded.agent = await agents.agents.forWorkspace(principal.workspaceId).get(id);
    if (loaded.agent === null) return { kind: 'refuse', result: agentNotFound() };
    const ownership =
      principal.ownerPrincipalId === loaded.agent.ownerPrincipalId ? 'own' : 'other';
    return { kind: 'ownership', ownership };
  };
  return { resolver, loaded };
}

/** The route was answered before `run` (RBAC, a missing runtime), or this is what `run` gets. */
export type Authorised =
  | { readonly ok: false; readonly response: Response }
  | { readonly ok: true; readonly scope: AgentVersionRouteScope };

/**
 * Authorise the request onto the agent `:id` names and open the caller's version store.
 * Unconfigured, the routes answer `503 agent_policy_not_configured`.
 */
export async function authoriseAgentVersionRoute(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Authorised> {
  const id = await readAgentIdParam(context);
  const { resolver, loaded } = loadingOwnership(id);
  const access = await requireResourceAccess(request, resolver);
  if (!access.ok) return { ok: false, response: access.response };
  if (loaded.agent === null) {
    throw new Error(
      'RBAC allowed a version request without the ownership resolver loading the agent.',
    );
  }
  const { workspaceId } = access.principal;
  const opened = await openAgentVersionStore(workspaceId);
  if (!opened.ok) return { ok: false, response: toResponse(opened.result) };
  const ceiling = opened.runtime.ceilingFor?.(request, workspaceId) ?? null;
  return {
    ok: true,
    scope: {
      agent: loaded.agent,
      principal: access.principal,
      store: opened.store,
      ceiling,
      toolBundles: openToolBundleLookup(workspaceId),
      toolHost: opened.runtime.toolHost === true,
      toolDomainsRefusal: opened.runtime.toolDomainsRefusal ?? null,
    },
  };
}

/**
 * Save a console edit of `agent` as its next version and point `local` at it (issue #616), in the
 * principal's workspace. Answers `null` once saved, else the refusal; `503` when versions or
 * assignments are not configured.
 */
export async function saveConsoleEdit(
  agent: AgentRecord,
  edit: UiEdit,
  principal: Principal,
  ceiling: RequestCeiling | null,
): Promise<ApiResult | null> {
  const opened = await openAgentVersionStore(principal.workspaceId);
  if (!opened.ok) return opened.result;
  const resources = currentAgentsRuntime()?.agentResources;
  if (resources === undefined) {
    return problem(
      503,
      'agent_resources_not_configured',
      'Agent resource assignments are not configured.',
    );
  }
  return saveUiEdit(agent, edit, principal, {
    store: opened.store,
    ceiling,
    toolBundles: openToolBundleLookup(principal.workspaceId),
    assignments: () => resources.forWorkspace(principal.workspaceId).get(agent.id),
  });
}

/**
 * The current keys of the connectors `policy` stores rules for by id, keyed by `connector-<id>`,
 * for a view to label them (display only). Empty when no rule names one, and when versions are not
 * configured: a label is never worth failing a read for.
 */
export async function policyConnectorNames(
  workspaceId: string,
  policy: AgentPolicy,
): Promise<Record<string, string>> {
  if (storedConnectorServers(policy).length === 0) return {};
  const runtime = currentAgentVersionsRuntime();
  if (runtime === null) return {};
  const store = await runtime.versions.forWorkspace(workspaceId);
  return store === null ? {} : connectorNamesOf(store, policy);
}

/**
 * Open the version store of `workspaceId`, the authenticated principal's. Unconfigured, it answers
 * `503 agent_policy_not_configured`.
 */
async function openAgentVersionStore(workspaceId: string): Promise<
  | {
      readonly ok: true;
      readonly runtime: AgentVersionsRuntime;
      readonly store: WorkspaceAgentVersionStore;
    }
  | { readonly ok: false; readonly result: ApiResult }
> {
  const runtime = currentAgentVersionsRuntime();
  if (runtime === null) {
    return {
      ok: false,
      result: problem(
        503,
        'agent_policy_not_configured',
        'Agent versions are not configured for this deployment.',
      ),
    };
  }
  const store = await runtime.versions.forWorkspace(workspaceId);
  if (store === null) return { ok: false, result: agentNotFound() };
  return { ok: true, runtime, store };
}

/**
 * Authorise the request onto the agent `:id` names, open the caller's version store, and answer
 * `run`'s result. Unconfigured, the routes answer `503 agent_policy_not_configured`. The pointer
 * route needs nothing more: its `agent-changed` audit row is written by the version store inside
 * the pointer transaction (`pointers.ts`), so there is no separate audit writer to open.
 */
export async function serveAgentVersionRoute(
  request: Request,
  context: { params: Promise<{ id: string }> },
  run: (scope: AgentVersionRouteScope) => Promise<ApiResult>,
): Promise<Response> {
  const authorised = await authoriseAgentVersionRoute(request, context);
  if (!authorised.ok) return authorised.response;
  return toResponse(await run(authorised.scope));
}

/** Read a create-version body within {@link MAX_AGENT_VERSION_BODY_BYTES}. */
export async function readAgentVersionBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; result: ApiResult }> {
  return readBoundedJson(request, { maxBytes: MAX_AGENT_VERSION_BODY_BYTES, problem });
}

/** Read a pointer body within {@link MAX_POINTER_BODY_BYTES}. */
export async function readPointerBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; result: ApiResult }> {
  return readBoundedJson(request, { maxBytes: MAX_POINTER_BODY_BYTES, problem });
}

/** Read a `POST /api/agents` body, any of its three forms, within {@link MAX_CREATE_AGENT_BODY_BYTES}. */
export async function readCreateAgentBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; result: ApiResult }> {
  return readBoundedJson(request, { maxBytes: MAX_CREATE_AGENT_BODY_BYTES, problem });
}
