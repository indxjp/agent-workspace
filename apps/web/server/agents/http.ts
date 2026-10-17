/**
 * The HTTP edge of the agent routes: turning a `Request` into something {@link ApiResult}-shaped
 * handlers can use, and turning their answers back into a `Response`.
 *
 * The route files under `apps/web/app/api/agents/**` contain nothing but calls into this module
 * and `handlers.ts`. That is on purpose — a Next.js route file is the one place in the application
 * that cannot be imported by a test without dragging the framework's routing conventions in, so
 * the less that lives there the more of this task is actually covered.
 */
import { AGENT_INSTRUCTIONS_MAX_LENGTH } from '../../contracts/agents';
import { problem, type ApiResult } from './handlers';
import type { WorkspaceAgentStore } from './store';
import { currentAgentsRuntime, type AgentsRuntime } from './runtime';
import { apiResultResponse, readBoundedJson, readRouteParam } from '../http/json-transport';
import { authorise, type OwnershipResolver } from '../rbac/http';
import type { Ownership } from '../rbac/decide';
import type { Principal } from '../rbac/principal';

/**
 * The most bytes a single JSON code unit can occupy: `\uXXXX`, the escape `JSON.stringify`
 * produces for a control character or a lone surrogate. UTF-8 alone would cap a BMP code unit at
 * three bytes; the escape is worse, so the escape is the bound used.
 */
const JSON_WORST_CASE_BYTES_PER_CODE_UNIT = 6;

/**
 * Room for everything in the body that is not `instructions`: the object braces, the field names,
 * `name` and `model` at their own bounds, the permissions object, and whitespace a pretty-printing
 * client might send.
 */
const NON_INSTRUCTIONS_ALLOWANCE_BYTES = 64 * 1024;

/**
 * The largest request body these routes will read, in bytes.
 *
 * **Derived, not chosen.** It is the size of the largest body the contract in `contract.ts` can
 * legally accept — `instructions` at {@link AGENT_INSTRUCTIONS_MAX_LENGTH} code units, every one
 * of them escaped to its worst case — plus an allowance for the rest of the object. So the bound
 * is loose enough that no body a client is entitled to send is rejected by it (asserted in
 * `http.test.ts`), and tight enough that a body which cannot possibly parse into a valid agent is
 * refused before it is held in memory. If the `instructions` bound moves, this moves with it.
 */
export const MAX_REQUEST_BODY_BYTES =
  AGENT_INSTRUCTIONS_MAX_LENGTH * JSON_WORST_CASE_BYTES_PER_CODE_UNIT +
  NON_INSTRUCTIONS_ALLOWANCE_BYTES;

/**
 * The shared reader refuses to hold more than {@link MAX_REQUEST_BODY_BYTES} of the body.
 *
 * The bound is applied **while the body streams**, not after. `request.text()` materialises the
 * whole body first, so a 40 MB request would be fully in memory before any field-length rule could
 * look at it — the field bounds in `contract.ts` protect the row, not the process. This is the
 * other half.
 *
 * `Content-Length` is checked first where it exists, but it is only a shortcut: the Fetch `Request`
 * constructor does not set it for a stream body, a chunked request has none, and the header is
 * caller-controlled in any case. A check that trusted it would be deciding on the absence of a
 * negative (ADR-0015). The running byte count below is the check that actually holds, and it holds
 * whether or not the header is present or honest.
 */
/**
 * Read and parse a JSON request body.
 *
 * Five rejections, each named separately because each has a different fix: the wrong media type
 * (415), a body larger than {@link MAX_REQUEST_BODY_BYTES} (413), no body at all (400), bytes that
 * are not UTF-8 (400), and bytes that are not JSON (400). None of them is reported as an empty
 * object, which is the fail-open shape this would otherwise take — a body that failed to parse
 * would then reach a parser as `{}` and come back as "name is required", pointing the client at
 * the wrong problem.
 */
export async function readJsonBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; result: ApiResult }> {
  return readBoundedJson(request, { maxBytes: MAX_REQUEST_BODY_BYTES, problem });
}

/** Turn a handler's answer into a `Response`. A `204` carries no body and no content type. */
export function toResponse(result: ApiResult): Response {
  return apiResultResponse(result);
}

/**
 * Resolve the caller's workspace, hand the matching store to `run`, and return its answer.
 *
 * Every one of the five routes goes through here, which is what makes row-level workspace scoping
 * a property of the route layer rather than a habit. The store `run` receives is bound to a
 * workspace and has no method that takes a workspace id, so the scoping cannot be skipped further
 * down either. That rule is this repository's extension of spec §25's intent to the control plane
 * and is not a sentence of §25 — see the header of `store.ts` for what §25 does and does not say.
 *
 * The unconfigured case returns `503`, not `401` and not an empty list. See `runtime.ts` for why:
 * asserting "not authenticated" when nothing authenticated anything is a gate deciding on the
 * absence of a negative, and ADR-0015 exists because that failed open three times in Wave 0.
 */
export async function withWorkspaceStore(
  request: Request,
  run: (
    store: WorkspaceAgentStore,
    runtime: AgentsRuntime,
    workspaceId: string,
  ) => Promise<ApiResult>,
  authenticatedWorkspaceId?: string,
): Promise<ApiResult> {
  const runtime = currentAgentsRuntime();
  if (runtime === null) {
    return problem(
      503,
      'agents_runtime_not_configured',
      'The agent API has no store or workspace resolver wired into it. This deployment cannot ' +
        'serve agent requests; it is not that the request was rejected.',
    );
  }

  if (authenticatedWorkspaceId !== undefined) {
    return run(
      runtime.agents.forWorkspace(authenticatedWorkspaceId),
      runtime,
      authenticatedWorkspaceId,
    );
  }

  const resolution = await runtime.resolveWorkspace(request);
  switch (resolution.kind) {
    case 'workspace':
      return run(
        runtime.agents.forWorkspace(resolution.workspaceId),
        runtime,
        resolution.workspaceId,
      );
    case 'unauthenticated':
      return problem(401, 'unauthenticated', resolution.reason);
    case 'forbidden':
      return problem(403, 'forbidden', resolution.reason);
    default: {
      // Total: a fourth resolution kind is a compile error here, not a silent fall-through to a
      // success path (ADR-0015 — every classifier ends in an explicit else that rejects).
      const unreachable: never = resolution;
      return problem(
        500,
        'unhandled_workspace_resolution',
        `The workspace resolver returned a case this route does not handle: ${JSON.stringify(unreachable)}.`,
      );
    }
  }
}

/**
 * Apply workspace authentication first, then the shared role decision, using one tenant scope.
 *
 * `ownership` is either a plain value, for a route that does not need to read its row to answer
 * (a collection route, or one that always denies narrower-than-`any` grants), or a function from
 * the now-resolved `store` to an {@link OwnershipResolver} — issue #117's "load the row within the
 * caller's workspace first, then call decide()" for an item route whose ownership depends on a row
 * only this store can read. The two are told apart by `typeof`: an `Ownership` is always a string
 * literal and this factory is always a function, so there is no ambiguity to resolve by arity.
 * `run` receives the verified `principal` (issue #117: `POST /api/agents` needs it to resolve who
 * `created_by` names).
 */
export async function withAuthorisedWorkspaceStore(
  request: Request,
  ownership: Ownership | ((store: WorkspaceAgentStore) => OwnershipResolver),
  run: (
    store: WorkspaceAgentStore,
    runtime: AgentsRuntime,
    workspaceId: string,
    principal: Principal,
  ) => Promise<ApiResult>,
): Promise<ApiResult> {
  return withWorkspaceStore(request, (store, runtime, workspaceId) =>
    authorise(
      request,
      typeof ownership === 'function' ? ownership(store) : ownership,
      ({ principal }) =>
        principal.workspaceId === workspaceId
          ? run(store, runtime, workspaceId, principal)
          : Promise.resolve(
              problem(403, 'forbidden', 'The authorisation identity resolved another workspace.'),
            ),
    ),
  );
}

/**
 * Read `params` from a Next.js dynamic segment, without assuming it resolved to what it should.
 *
 * Next 15+ makes `params` a promise. Awaiting it can yield anything at runtime — a route renamed,
 * a mistyped segment — and `handlers.requireAgentId` rejects a non-UUID, so this only has to hand
 * over whatever was there under `id` and never invent a value for it.
 */
export async function readAgentIdParam(context: {
  params: Promise<{ id: string }>;
}): Promise<unknown> {
  return readRouteParam(context, 'id');
}
