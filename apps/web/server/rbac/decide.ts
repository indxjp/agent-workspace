/**
 * `decide` — the one place in the program that answers "may this role do this to this route?".
 *
 * Pure, total, and it returns a third answer. `allow` and `deny` are decisions; `refuse` is the
 * absence of one, and it is what this function returns for a route it cannot classify — a
 * resource segment nobody has put in `permissions.ts`, a method nobody has classified, a path
 * that is not the shape spec §34 fixes. `refuse` maps to `500`, never to `200` and never to
 * `403`: a `403` would assert that the caller was measured against a rule and found wanting, and
 * nothing was measured. That is ADR-0015 — a gate decides on a positive assertion, and a check
 * that cannot run fails — and ADR-0031 — undecidable means refused, in the `else`.
 *
 * `refuse` is also what makes the authorisation matrix grow by itself. The matrix test
 * (`authorisation-matrix.test.ts`) enumerates the routes from `tests/route-declarations/**`, the
 * same union `tests/route-inventory.test.ts` reads, crosses them with §21's four roles and every
 * ownership answer, and fails on any `refuse`. A route another task adds is in that union the
 * moment it is committed, so it is in this matrix the moment it is committed, and it fails until
 * somebody classifies its resource. Nothing here counts routes and nothing here lists them.
 *
 * ## Why the path is classified rather than looked up
 *
 * A table of route patterns would be the list somebody forgets to update — the failure
 * `apps/web/server/auth/paths.ts` says in its own header that it exists to avoid. Instead the
 * path is *parsed* into `(resource, sub-resource)` against §34's shape, the method into an
 * operation, and the result looked up in §21's split. Adding a route to an already-classified
 * `(resource, sub-resource)` pair therefore needs no edit here; adding one to an unclassified
 * resource, or an unclassified sub-resource under a classified resource, cannot be done silently.
 *
 * Round 1's header claimed the second half of that and it was false. `parsePath` looked up only
 * segment 2, and the sub segment was used for nothing but telling `run` from `write`, so a new
 * capability shipped as `/api/<classified>/:id/<anything>` was granted the parent's width with no
 * edit to `permissions.ts` and no failure from any gate: the verifier registered
 * `GET /api/agents/:id/secrets` and all four roles were allowed it, Viewer included. Both
 * segments are classified now, and `permissions.ts`'s `SUB_RESOURCES` is where the second one is
 * decided.
 *
 * The surface question — is this `/api/`, `/p/` or a page? — is not re-implemented. It is
 * `classifyPath` from `../auth/paths`, which already decides it over every plausible reading of a
 * pathname and denies on ambiguity. Reusing it means there is one answer to that question in the
 * program rather than two.
 */
import { isUuid } from '@indx-workspace/contracts';

import { classifyPath } from '../auth/paths';

import {
  grantsFor,
  parseResource,
  parseSub,
  policyBecause,
  SUB_RESOURCES,
  type Grant,
  type Operation,
  type Resource,
} from './permissions';
import { parseRole, type Role } from './roles';
import type { TokenScope, TokenScopeKind } from './token-scope';

export {
  ENDPOINT_SCOPE_KINDS,
  TOKEN_SCOPE_KINDS,
  type TokenScope,
  type TokenScopeKind,
} from './token-scope';

/**
 * Whose row is being acted on, as far as the caller could tell.
 *
 * `not-applicable` is a collection route — `GET /api/agents`, `POST /api/api-keys` — where there
 * is no single row to own. A grant of `own` allows it, and the handler then carries a contract:
 * the result set is filtered to the caller's own rows. That contract is not checked here and is
 * declared, not asserted, in this task's PR.
 *
 * `unknown` is the honest answer from a handler that has not read the row yet. It denies.
 *
 * `permitted` is issue #117's addition: the handler read the row AND consulted the one explicit
 * grant mechanism spec §21 names — `agent_grants`, for a Viewer's "run permitted agents" — and
 * found a grant naming this caller and this row. It is a fact about the request, not a policy
 * width; the policy width of the same name lives in `permissions.ts`'s {@link Grant} and is what
 * `applyGrant` compares this against.
 */
export type Ownership = 'own' | 'other' | 'unknown' | 'not-applicable' | 'permitted';

/** Every ownership answer, so a test can quantify over them without rebuilding the list. */
export const OWNERSHIPS = ['own', 'other', 'unknown', 'not-applicable', 'permitted'] as const;

/** The methods a Next.js route handler may export. `HEAD` is `GET` without a body. */
export const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

/** One of {@link METHODS}. */
export type Method = (typeof METHODS)[number];

/**
 * What was asked. `path` is in the specification's notation — `:id`, not `[id]`.
 *
 * `scope` is **required**, not optional (issue #236, SDK-04, S-1): every one of this function's
 * seven call sites became a compile error the day this field was added, so a family that forgot
 * the scope gate cannot silently hand a browser token its minter's full width. Pass `null` for
 * every credential this function has always seen — a session, an API key, or a caller with no
 * scoped credential (a page-render capability probe) — and a real {@link TokenScope} only for a
 * `Principal` whose `via` is `'browser-token'`.
 */
export interface AuthorisationQuery {
  readonly role: Role;
  readonly method: string;
  readonly path: string;
  readonly ownership: Ownership;
  readonly scope: TokenScope | null;
}

/** What this route turned out to be, echoed on every decision so a failure names it. */
export interface RouteFacts {
  readonly resource: Resource;
  readonly operation: Operation | 'revoke';
  readonly grant: Grant;
}

/**
 * `allow` and `deny` are decisions and carry the sentence of §21 behind them. `refuse` is the
 * absence of a decision and carries the reason nothing could be decided.
 *
 * `deny`'s `code` is optional and additive (issue #236): every renderer defaults an absent one to
 * `'forbidden'`, which is every existing response's code, so this changes nothing for a `scope:
 * null` query. The one value it carries today is `'token_out_of_scope'`, returned before §21's
 * table is even consulted when a browser token's scope does not reach this route shape. Run-token
 * revocation has its own denial code because it is a separate capability from run writes.
 */
export type Decision =
  | { readonly effect: 'allow'; readonly because: string; readonly facts: RouteFacts | null }
  | {
      readonly effect: 'deny';
      readonly because: string;
      readonly facts: RouteFacts | null;
      readonly code?: string;
    }
  | { readonly effect: 'refuse'; readonly because: string };

/** A path parsed against §34's shape, or the reason it could not be. */
type ParsedPath =
  | {
      readonly ok: true;
      readonly resource: Resource;
      readonly sub: string | null;
      /** The `:id` segment's real value, when the path shape has one; `null` for a collection route. */
      readonly id: string | null;
    }
  | { readonly ok: false; readonly because: string };

/**
 * `/api/<resource>`, `/api/<resource>/:id`, `/api/<resource>/:id/<sub>` — ADR-0026 decision 3's
 * shape, and nothing deeper. The shape itself is enforced by `tests/route-inventory.test.ts`;
 * what this does is *use* it, and refuse anything it does not recognise rather than guess a
 * resource out of it.
 */
function parsePath(path: string): ParsedPath {
  const segments = path.split('/');
  const [empty, api, resourceSegment, ...rest] = segments;
  if (empty !== '' || api !== 'api' || resourceSegment === undefined) {
    return {
      ok: false,
      because:
        `"${path}" does not begin /api/<resource>, so this table cannot say which resource it ` +
        `acts on.`,
    };
  }
  const resource = parseResource(resourceSegment);
  if (resource === null) {
    return {
      ok: false,
      because:
        `"${resourceSegment}" is not a resource spec §21's permission split classifies. Add it to ` +
        `RESOURCES in apps/web/server/rbac/permissions.ts together with the grants each of the ` +
        `four roles has over it, citing the sentence of §21 that decides them. An unclassified ` +
        `resource is refused, not allowed (ADR-0015).`,
    };
  }
  // `/api/<resource>` and `/api/<resource>/:id` name no sub-resource, which is a different fact
  // from naming one nobody classified — the first is the collection and the row.
  if (rest.length === 0) return { ok: true, resource, sub: null, id: null };
  if (rest.length === 1) return { ok: true, resource, sub: null, id: rest[0] ?? null };
  if (rest.length === 2) {
    const segment = rest[1];
    const sub = parseSub(resource, segment);
    // The rejecting `else`. An unclassified sub-resource does NOT inherit its parent's grant:
    // `/api/agents/:id/secrets` is not "agents" merely because it starts with it.
    if (sub === null) {
      const classified = SUB_RESOURCES[resource];
      return {
        ok: false,
        because:
          `"${String(segment)}" is not a sub-resource spec §21's permission split classifies ` +
          `under "${resource}" (` +
          (classified.length === 0
            ? 'no sub-resource of it is classified'
            : `classified: ${classified.join(', ')}`) +
          `). Add it to SUB_RESOURCES in apps/web/server/rbac/permissions.ts with the reading of ` +
          `§21 that decides its grants, or classify it as a resource of its own. An unclassified ` +
          `sub-resource is refused, never given its parent's grant (ADR-0015).`,
      };
    }
    return { ok: true, resource, sub, id: rest[0] ?? null };
  }
  return {
    ok: false,
    because: `"${path}" is deeper than /api/<resource>/:id/<sub>, which is the deepest shape §34 admits.`,
  };
}

/** A method and a sub-resource, as an operation — or the reason they are not one. */
type ParsedOperation =
  | { readonly ok: true; readonly operation: Operation }
  | { readonly ok: false; readonly because: string };

function parseOperation(method: string, resource: string, sub: string | null): ParsedOperation {
  // `POST /api/agents/:id/runs` and `POST /api/sessions/:id/messages` are the two shapes in which
  // this control plane spends money and executes an agent, and §21 treats running as its own verb
  // — "Create/edit/**run** agents", "**Run** permitted agents". They are therefore not writes.
  //
  // `POST /api/runs/:id/interrupt` (issue #235, S-14) joins them: stopping a run you started is
  // part of running it, not a separate write — see
  // `apps/web/server/rbac/declarations/SDK-03-RUN-CONTROL-235.ts`. `POST /api/runs/:id/feedback`
  // (issue #539, S2-05c) is the same verb: rating the answer you received is part of running it —
  // see `apps/web/server/rbac/declarations/DJ-S2-05C-RUN-FEEDBACK-539.ts`.
  // `POST /api/runs/:id/approval` (issue #1301, ADR-0145 D2) is the same verb: deciding the call a
  // paused run waits on is how that run continues — see
  // `apps/web/server/rbac/declarations/P5-4-RUN-APPROVAL-1301.ts`.
  if (
    method === 'POST' &&
    (sub === 'runs' ||
      sub === 'messages' ||
      sub === 'interrupt' ||
      sub === 'feedback' ||
      sub === 'approval')
  ) {
    return { ok: true, operation: 'run' };
  }
  // `POST /api/files/:id/download-urls` mints a URL to read a file; it changes nothing, so it is the
  // `read` a Viewer holds and not the `write` every other POST is (issue #251, N-4).
  if (method === 'POST' && sub === 'download-urls') return { ok: true, operation: 'read' };
  // `POST /api/storage-connections/:id/test` (issue #1690) lists one page of an allowed folder and
  // changes nothing, so a Member may run it as it may browse. Model connections' `test` is not this
  // one: it spends a provider call and stays a write.
  if (method === 'POST' && resource === 'storage-connections' && sub === 'test') {
    return { ok: true, operation: 'read' };
  }
  switch (method) {
    case 'GET':
    case 'HEAD':
      return { ok: true, operation: 'read' };
    case 'POST':
    case 'PUT':
    case 'PATCH':
    case 'DELETE':
      return { ok: true, operation: 'write' };
    case 'OPTIONS':
      // No route in this repository exports OPTIONS, so there is no evidence about what one would
      // be for and no reading of §21 that covers it. Refused rather than guessed: the day a route
      // needs it, this branch is where the decision gets recorded.
      return {
        ok: false,
        because:
          'OPTIONS is not an operation spec §21 classifies, and this repository declares no ' +
          'OPTIONS route. Decide what it means before shipping one.',
      };
    default:
      return {
        ok: false,
        because:
          `"${method}" is not an HTTP method a Next.js route handler exports ` +
          `(${METHODS.join(', ')}), so no operation can be derived from it.`,
      };
  }
}

/** How wide a grant is, against the ownership the caller could establish. */
function applyGrant(grant: Grant, ownership: Ownership): { allowed: boolean; because: string } {
  switch (grant) {
    case 'any':
      return { allowed: true, because: 'the grant covers every row in the workspace' };
    case 'own':
      if (ownership === 'own') return { allowed: true, because: 'the row is the caller’s own' };
      if (ownership === 'not-applicable') {
        return {
          allowed: true,
          because:
            'the grant covers the caller’s own rows and this route names no single row; the ' +
            'handler owes the result set the same filter',
        };
      }
      return {
        allowed: false,
        because:
          ownership === 'other'
            ? 'the grant covers the caller’s own rows and this row is another member’s'
            : 'the grant covers the caller’s own rows and the handler could not establish whose ' +
              'this is; an undetermined owner denies rather than passes (ADR-0031)',
      };
    case 'permitted':
      // The whole of Viewer's "Run permitted agents". `agent_grants` (issue #117) is the
      // mechanism W2-CP-06's header said did not exist yet; see
      // docs/adr/W9-AUTH-117-viewer-permitted-agent-grants.md for the record that closed it.
      // ADR-0152: `permitted` is "own or granted", so it covers `own` and roles stay monotonic
      // (Builder's `permitted` covers Viewer's, and a granted Builder runs what a granted Viewer
      // runs).
      if (ownership === 'permitted') {
        return {
          allowed: true,
          because: 'this caller has been granted this agent',
        };
      }
      if (ownership === 'own') {
        return { allowed: true, because: 'the agent is the caller’s own' };
      }
      return {
        allowed: false,
        because:
          ownership === 'other'
            ? 'this role may do this only on agents it owns or has been permitted, and this agent ' +
              'is neither'
            : 'this role may do this only on agents it owns or has been permitted, and neither ' +
              'could be confirmed, so the request is denied',
      };
    case 'none':
      return { allowed: false, because: 'the role has no grant over this resource' };
    default: {
      const unreachable: never = grant;
      throw new Error(`unclassified grant ${JSON.stringify(unreachable)} — refusing to allow`);
    }
  }
}

/**
 * One (resource, operation) pair a scope kind's grammar admits, optionally narrowed to one
 * sub-resource. A cell without `sub` matches the pair under any sub-resource (or none); a cell
 * with `sub` matches only that sub-resource.
 */
interface ScopeGrammarCell {
  readonly resource: Resource;
  readonly operation: Operation;
  readonly sub?: string;
}

/**
 * Spec §3.1's scope grammar, as data — the route *shapes* a browser token's scope may reach.
 *
 * A run scope reaches exactly the acceptance criterion's "follow that run's stream and read that
 * run": `GET /api/runs/:id` and `GET /api/runs/:id/events` are both `{ resource: 'runs', operation:
 * 'read' }` (`parseOperation` reads the `events` sub-resource's `GET` the same way it reads the
 * parent's), so one cell covers both routes. A session scope reaches that same cell (reading a run
 * or its events) plus `{ resource: 'agents', operation: 'run' }` — `POST /api/agents/:id/runs`,
 * spec §3.1's "start runs in that session", and `{ resource: 'runs', operation: 'run', sub:
 * 'feedback' }` — `POST /api/runs/:id/feedback` (issue #539, S2-05c), rating a run of that
 * session. That cell is keyed by the sub-resource because `Operation` is closed: a bare
 * `(runs, run)` cell would also admit `POST /api/runs/:id/interrupt`, which a session token must
 * not reach. Deliberately excluded, per the plan's Open questions:
 * `GET /api/me` (fails closed until a later unit asks for it) and
 * `POST /api/sessions/:id/messages` (the other run-starting shape; a one-line addition here the
 * day it is wanted). `tokens` itself is in neither list, which is what makes "a browser token
 * cannot mint another token" fall out of this table rather than being a special case anywhere.
 */
const TOKEN_SCOPE_GRAMMAR: Readonly<Record<TokenScopeKind, readonly ScopeGrammarCell[]>> = {
  run: [{ resource: 'runs', operation: 'read' }],
  session: [
    { resource: 'runs', operation: 'read' },
    { resource: 'agents', operation: 'run' },
    { resource: 'runs', operation: 'run', sub: 'feedback' },
    // Reading the session's own files straight from the object store (issue #251, N-4). Keyed by
    // sub-resource, with no bare `files` cell, so the relay routes stay out of reach; the path being
    // under `.attachments/<sessionId>/` is a row fact the files handler checks. There is no
    // `upload-urls` cell: a visitor uploads through `sessions/:id/attachments`, whose flag, name,
    // rate and quota rules a presigned PUT would skip (issue #1574).
    { resource: 'files', operation: 'read', sub: 'download-urls' },
    // A visitor handing one file to its own session (issue #1308, ADR-0146 D6). The `:id` must be the
    // token's own session, which is the `sessions` clause of `checkTokenScope` below.
    { resource: 'sessions', operation: 'write', sub: 'attachments' },
  ],
  // ADR-0134: an endpoint-scoped key runs the one agent its A2A client names, nothing else. The
  // agent identity is checked below; the A2A endpoint itself (`/api/a2a/agents/...`) is a later
  // unit's and admits this scope there.
  'a2a-agent': [{ resource: 'agents', operation: 'run' }],
  // An MCP project key reaches only the MCP endpoint (`/mcp/projects/...`), which is outside
  // `/api/`, so no control-plane route is in its grammar.
  'mcp-project': [],
  // The Builder's MCP door is outside `/api/` too, and is a later slice's (#1846 5b).
  builder: [],
};

/**
 * The scope half of `decide()`: does this route *shape* fall inside `scope`'s grammar, and — for a
 * run scope reaching the `runs` resource, the one case where the path's own `:id` segment names
 * the scoped row directly — does that `:id` name the scoped run?
 *
 * Returns `null` to mean "the scope does not object; consult §21 as usual", never a decision of its
 * own for that case — the scope narrows what a browser token's minter could otherwise do, it does
 * not widen it, so an in-grammar request still has to clear the ordinary role/ownership check
 * below. A session scope's row identity (its run must belong to that session) is NOT checked here:
 * the path's `:id` on that grammar cell is a run id or an agent id, never the session id, so that
 * assertion is a row fact and belongs where the row is read (`apps/web/server/runs/api.ts`, and
 * `apps/web/server/runs/feedback.ts` for the feedback cell).
 */
function checkTokenScope(
  scope: TokenScope,
  resource: Resource,
  operation: Operation,
  sub: string | null,
  pathId: string | null,
): Decision | null {
  const grammar = TOKEN_SCOPE_GRAMMAR[scope.kind];
  const shape = grammar.find(
    (cell) =>
      cell.resource === resource &&
      cell.operation === operation &&
      (cell.sub === undefined || cell.sub === sub),
  );
  if (shape === undefined) {
    const named = (target: string, at: string | null | undefined) =>
      at === undefined || at === null ? `"${target}"` : `"${target}/${at}"`;
    return {
      effect: 'deny',
      code: 'token_out_of_scope',
      facts: null,
      because:
        `a ${scope.kind}-scoped credential may only reach ` +
        (grammar.length === 0
          ? 'no control-plane route'
          : grammar
              .map((cell) => `${cell.operation} on ${named(cell.resource, cell.sub)}`)
              .join(', ')) +
        `, and ${operation} on ${named(resource, sub)} is not one of them.`,
    };
  }
  // Every grammar cell on `runs` is a single-row read (§3.1: "read that run"), never the
  // collection: `GET /api/runs` names no `:id` at all, and a session scope's grant of `read` on
  // `runs` would otherwise admit the unfiltered workspace-wide list a "nothing else" scope must
  // not reach — the row-identity check below only ever fires for a route that already has an id.
  if (resource === 'runs' && operation === 'read' && pathId === null) {
    return {
      effect: 'deny',
      code: 'token_out_of_scope',
      facts: null,
      because:
        `a ${scope.kind}-scoped credential may read one run by id, never the workspace's run ` +
        `list, and "${resource}" here names no ":id".`,
    };
  }
  const sameRow =
    pathId === scope.id ||
    (isUuid(pathId) && isUuid(scope.id) && pathId.toLowerCase() === scope.id.toLowerCase());
  if (scope.kind === 'run' && resource === 'runs' && !sameRow) {
    return {
      effect: 'deny',
      code: 'token_out_of_scope',
      facts: null,
      because:
        `this run-scoped browser token is scoped to run ${scope.id}, and the ":id" segment of ` +
        `this request names a different row.`,
    };
  }
  if (scope.kind === 'session' && resource === 'sessions' && !sameRow) {
    return {
      effect: 'deny',
      code: 'token_out_of_scope',
      facts: null,
      because:
        `this session-scoped browser token is scoped to session ${scope.id}, and the ":id" segment ` +
        `of this request names a different row.`,
    };
  }
  if (scope.kind === 'a2a-agent' && resource === 'agents' && !sameRow) {
    return {
      effect: 'deny',
      code: 'token_out_of_scope',
      facts: null,
      because:
        `this a2a-agent-scoped credential is scoped to agent ${scope.id}, and the ":id" segment ` +
        `of this request names a different row.`,
    };
  }
  return null;
}

/**
 * Decide one cell of the authorisation matrix.
 *
 * Never throws for a caller's benefit: a query it cannot classify comes back as `refuse` with the
 * reason, because the matrix test wants to report every unclassified route at once rather than
 * stop at the first.
 */
export function decide(query: AuthorisationQuery): Decision {
  // The role is re-parsed at runtime even though the type says it is a Role: this function is the
  // one that must not be wrong, and a `role` that arrived from a database row through an `as` is
  // exactly the value a type annotation is no evidence about.
  const role = parseRole(query.role);
  if (role === null) {
    return {
      effect: 'refuse',
      because:
        `${JSON.stringify(query.role)} is not one of spec §21's four roles, so no row of the ` +
        `permission table applies to it.`,
    };
  }

  const verdict = classifyPath(query.path);
  switch (verdict.surface) {
    case 'public':
      // §34 puts the public pages under /p/ "so that 'is this request authenticated?' is
      // answerable by looking at the path prefix alone". A surface that answers *no* to that
      // question has no role to check, and every role — including a caller with none — reaches it.
      return {
        effect: 'allow',
        because: `spec §34 public surface: ${verdict.reason}`,
        // No resource and no operation: nothing was looked up in §21's table, and inventing a
        // pair here would put a fact in the record that no line of code established.
        facts: null,
      };
    case 'page':
      return {
        effect: 'refuse',
        because:
          `"${query.path}" is a browser page, not a control-plane route (${verdict.reason}). ` +
          `Page-level authorisation is the server component's, and this table does not decide it.`,
      };
    case 'api':
      break;
    default: {
      const unreachable: never = verdict.surface;
      throw new Error(`unclassified surface ${JSON.stringify(unreachable)} — refusing to allow`);
    }
  }

  const parsed = parsePath(query.path);
  if (!parsed.ok) return { effect: 'refuse', because: parsed.because };

  // Both the named route and its deprecated POST alias (removed in the next major, ADR-0078 D7) revoke run tokens. The handler permits
  // Owner/Admin regardless of run ownership, while no browser token may revoke anything. Treat
  // this as its own capability rather than widening Admin's ordinary runs.write grant.
  if (
    query.method === 'POST' &&
    parsed.resource === 'runs' &&
    parsed.id !== null &&
    (parsed.sub === null || parsed.sub === 'revoke-tokens')
  ) {
    if (query.scope !== null) {
      return {
        effect: 'deny',
        code: 'token_out_of_scope',
        facts: null,
        because: 'a browser token’s scope does not reach revoking run tokens.',
      };
    }
    const grant: Grant = role === 'owner' || role === 'admin' ? 'any' : 'none';
    const facts: RouteFacts = { resource: 'runs', operation: 'revoke', grant };
    if (grant === 'any') {
      return { effect: 'allow', facts, because: 'Owner and Admin may revoke run tokens.' };
    }
    return {
      effect: 'deny',
      code: 'run_token_revoke_forbidden',
      facts,
      because: 'only a workspace owner or admin may revoke active run tokens.',
    };
  }

  const operation = parseOperation(query.method, parsed.resource, parsed.sub);
  if (!operation.ok) return { effect: 'refuse', because: operation.because };

  if (query.scope !== null) {
    const scoped = checkTokenScope(
      query.scope,
      parsed.resource,
      operation.operation,
      parsed.sub,
      parsed.id,
    );
    if (scoped !== null) return scoped;
  }

  const grants = grantsFor(role, parsed.resource);
  const grant = grants[operation.operation];
  const applied = applyGrant(grant, query.ownership);
  const facts: RouteFacts = { resource: parsed.resource, operation: operation.operation, grant };
  const because =
    `${policyBecause(role)} → ${operation.operation} on "${parsed.resource}" is granted ` +
    `"${grant}", and ${applied.because}.`;
  return applied.allowed ? { effect: 'allow', because, facts } : { effect: 'deny', because, facts };
}
