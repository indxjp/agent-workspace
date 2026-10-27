/**
 * The authorisation matrix: spec §21's four roles × **every route registered at the time this test
 * runs**, derived from the route declarations rather than transcribed.
 *
 * ## Where the routes come from, and why it is not a table in this file
 *
 * `tests/route-declarations/<TASK-ID>.ts` is where every task that ships a route declares it
 * ([ADR-0025](../../../../docs/adr/0025-the-route-inventory-is-partitioned-by-owner.md)), and
 * `tests/route-inventory.test.ts` already asserts that the union of that directory **equals** the
 * route handlers the tracked tree serves — no route missing, and no route present that nothing
 * declares. This test reads the same union, through the same reader in `tests/inventory-support.ts`,
 * so:
 *
 *   * a route another task adds is in this matrix the moment it is committed, with no edit here;
 *   * a route that exists but is declared nowhere fails the *inventory* gate, so it cannot hide
 *     from this one by being undeclared;
 *   * and a route whose resource `apps/web/server/rbac/permissions.ts` does not classify produces
 *     `decide() → refuse`, which this file reports as a **failure, not a skip**.
 *
 * That last point is the criterion. A hand-written table of routes would have been the easy and
 * wrong way to write this test: it would have been correct on the day it was written, silent about
 * every route added afterwards, and it would have had to guess at the routes W2-CP-02, W2-CP-03
 * and W2-CP-07 are writing in parallel with this task and which do not exist on its base. Nothing
 * here counts routes and nothing here lists them; the counts below are computed from the union.
 *
 * ## What this test proves, and what it does not
 *
 * It proves the **table**: that §21's split has an answer for every declared route, for every
 * role, for every ownership answer a handler can give, and that the answers are the ones §21's
 * sentences require. It does not prove the **wiring** — that each handler actually calls
 * `authorise`. A handler that never calls it would pass this file with every cell green. The
 * wiring is proved for this task's own routes in `routes.test.ts`, which drives the real route
 * files with real `Request` objects; for routes owned by other tasks it is **not** proved here,
 * and that is a declared gap in this task's PR rather than a claim this file makes quietly.
 */
import { describe, expect, it } from 'vitest';

import {
  declarationPaths,
  readDeclarationFiles,
  requireString,
} from '../../../../tests/inventory-support';

import { decide, OWNERSHIPS, type Decision, type Ownership } from './decide';
import { ROLES, type Role } from './roles';

/** The directory ADR-0025 partitions the inventory into. */
const ROUTE_DECLARATIONS = 'tests/route-declarations';

/** One declared route, as this test needs it. */
interface DeclaredRoute {
  readonly method: string;
  readonly path: string;
  readonly owner: string;
  /** Where it was declared, for a failure message that names a file rather than a route. */
  readonly where: string;
}

/** `METHOD /path`, the key both this file and the route-inventory gate use. */
function key(route: { method: string; path: string }): string {
  return `${route.method} ${route.path}`;
}

/**
 * Every route the tracked declaration files declare, read the same way the inventory gate reads
 * them: `git ls-files` for the file set, `readDeclarationArray` for the entries, and
 * `requireString` for each field, so a declaration this reader cannot understand is a hard failure
 * rather than an empty contribution.
 */
function declaredRoutes(): DeclaredRoute[] {
  return readDeclarationFiles(ROUTE_DECLARATIONS, 'routes').flatMap((file) =>
    file.entries.map((entry, index) => {
      const where = `${file.repoPath} entry ${String(index)}`;
      return {
        method: requireString(entry, 'method', where),
        path: requireString(entry, 'path', where),
        owner: requireString(entry, 'owner', where),
        where,
      };
    }),
  );
}

/** One cell of the matrix. */
interface Cell {
  readonly route: DeclaredRoute;
  readonly role: Role;
  readonly ownership: Ownership;
  readonly decision: Decision;
}

/** Every cell: routes × roles × ownership answers. Built from the union, never from a literal. */
function matrix(routes: readonly DeclaredRoute[]): Cell[] {
  return routes.flatMap((route) =>
    ROLES.flatMap((role) =>
      OWNERSHIPS.map((ownership) => ({
        route,
        role,
        ownership,
        decision: decide({ role, method: route.method, path: route.path, ownership, scope: null }),
      })),
    ),
  );
}

/**
 * The cells §21's split could not decide, one line each.
 *
 * This is the whole gate, and it is the ADR-0015 shape: the failure condition is the *absence of a
 * decision*, reported positively, rather than the presence of a bad one. A route whose resource
 * nobody has classified lands here, and the message says exactly what to do about it.
 */
function undecidedCells(cells: readonly Cell[]): string[] {
  return cells
    .filter((cell) => cell.decision.effect === 'refuse')
    .map(
      (cell) =>
        `${key(cell.route)} (${cell.route.owner}, declared in ${cell.route.where}) × role ` +
        `${cell.role} × ownership ${cell.ownership}: ${cell.decision.because}`,
    );
}

/**
 * Pre-authentication bootstrap probes do not enter the workspace RBAC matrix. Keep this list
 * exact: broad prefixes would let a future setup mutation bypass the fail-closed inventory gate.
 * Middleware and auth tests separately prove that only these method/path pairs are public.
 *
 * The four `/api/auth/*` routes (issue #118, W9-AUTH-118) join `runtime-detect` here rather than
 * being classified `deny`-for-every-role the way `POST /api/setup` is: `decide()` takes a `Role`,
 * and a `Role` is something `apps/web/server/rbac/principal.ts`'s `Principal` carries — the thing
 * these four routes exist because the caller does not have yet. There is no code path in
 * production that ever constructs a `Principal` and hands it to `decide()` for one of these paths,
 * so a "deny for every role" row would document a call that cannot occur rather than a boundary
 * that is enforced. Their own security boundary is `apps/web/proxy.ts`'s narrow exemption plus
 * each handler's own origin/state/selection checks (`apps/web/app/api/auth/**`), proved in
 * `tests/auth.test.ts` and in the colocated `*.test.ts` beside each route.
 */
const PUBLIC_ROUTES = new Set([
  'GET /api/setup/runtime-detect',
  'GET /api/auth/login',
  'POST /api/auth/callback',
  'GET /api/auth/workspace',
  'POST /api/auth/workspace',
  // Issue #242 (ADR-0083): the start and poll of `aw login`, proved by the signed device code alone,
  // and the approval page, which renders "sign in first" itself when there is no session.
  'POST /api/auth/cli-device',
  'GET /api/auth/cli-verify',
  'POST /api/auth/cli-token',
  // ADR-0120 clause 7: called by Vercel Cron with `CRON_SECRET` as the bearer, never by a person.
  'GET /api/cron/retention',
  // ADR-0144 D5: the schedule pass, called by the platform cron with the same `CRON_SECRET` bearer.
  'GET /api/cron/triggers',
  // Issue #1674: the storage cleanup, called by the platform cron with the same `CRON_SECRET` bearer.
  'GET /api/cron/storage-cleanup',
  // ADR-0144: the secret in the path is the whole authentication of a trigger fire.
  'POST /api/triggers/:id/fire/:secret',
  // Issue #1562: the readiness probe a kubelet calls with no credential.
  'GET /api/readyz',
  // ADR-0134 part 3: the OAuth discovery documents (RFC 8414, RFC 9728) are public by protocol,
  // and the token and revocation endpoints authenticate the endpoint client itself, never a member.
  'GET /.well-known/oauth-authorization-server',
  'GET /.well-known/oauth-protected-resource/mcp/projects/:name',
  'GET /.well-known/oauth-protected-resource/mcp/builder',
  'GET /.well-known/oauth-protected-resource/api/a2a/agents/:agentName',
  'POST /oauth/token',
  'POST /oauth/revoke',
]);

/**
 * Routes reached through an authenticated identity proof that is deliberately not a workspace
 * {@link Principal} — distinct from {@link PUBLIC_ROUTES}, which need no identity proof at all.
 *
 * `POST /api/invitations/:id/accept` (issue #121, W9-TEAM-121) is the one entry. A workspace
 * `Principal` is not available: the dedicated invitation-identity cookie carries email, issuer,
 * and subject but no workspace or role. What this route therefore cannot have is a role-scoped
 * answer: `permissions.ts`'s (role,
 * resource) table cannot express identity-gated acceptance without granting the other invitation
 * writes to every role. The route verifies origin and that cookie directly, while the transaction
 * checks email, token hash, expiry, revocation, archive state, and the OIDC binding.
 */
const IDENTITY_ONLY_ROUTES = new Set([
  'POST /api/invitations/:id/accept',
  // Issue #242 (ADR-0083): acts on the own sign-in of the caller, not on a workspace resource a role
  // grants: approving a code needs the browser session, signing out and switching need the CLI
  // token itself, and each route verifies that proof through the same `identify()`. (No quote
  // marks in these comments: `tests/docs/openapi.test.ts` reads the entries by their quotes.)
  'POST /api/auth/cli-verify',
  'DELETE /api/auth/cli-token',
  'POST /api/auth/cli-workspace',
  // ADR-0135: a published agent's A2A endpoint and its card. The caller proves itself with an API
  // key, the handler runs decide() for POST on the agent's runs route and refuses every other
  // credential, so no route-level role gate applies here.
  'POST /api/a2a/agents/:agentName',
  'GET /api/a2a/agents/:agentName/.well-known/agent-card.json',
  // ADR-0134 part 2: an mcp-project endpoint client's tool endpoint, reached with its endpoint API
  // key; the handler runs decide() for POST on each agent's runs route, as the A2A endpoint does.
  'POST /mcp/projects/:name',
  // Issue #1846 slice 5b: the read-only Builder door for an outside MCP client. The handler
  // accepts only a `builder`-kind OAuth token and answers every write tool `read_only_client`.
  'POST /mcp/builder',
  // ADR-0134 part 3: the consent page. The handler requires a browser session through identify()
  // and refuses an API key or an OAuth token; the grant it issues is scoped to one endpoint client.
  'GET /oauth/authorize',
  'POST /oauth/authorize',
  // Issue #1846: the aw-control MCP door. A run token is the whole identity proof and the handler
  // refuses every other credential, so no route-level role gate applies; the Builder tools decide
  // what the person behind the run may do.
  'POST /api/builder/mcp',
]);

const allRoutes = declaredRoutes();
const publicRoutes = allRoutes.filter((route) => PUBLIC_ROUTES.has(key(route)));
const identityOnlyRoutes = allRoutes.filter((route) => IDENTITY_ONLY_ROUTES.has(key(route)));
const routes = allRoutes.filter(
  (route) => !PUBLIC_ROUTES.has(key(route)) && !IDENTITY_ONLY_ROUTES.has(key(route)),
);
const cells = matrix(routes);

describe('the authorisation matrix is derived from the route declarations', () => {
  it('reads every tracked declaration file, derived twice from the tracked tree', () => {
    // The same double derivation `tests/route-inventory.test.ts` performs, and for the same
    // reason: the failure this catches is the enumerating call itself going narrow, which would
    // satisfy every assertion below by having nothing left to check (ADR-0027 §1).
    const files = readDeclarationFiles(ROUTE_DECLARATIONS, 'routes');
    const derived = declarationPaths(ROUTE_DECLARATIONS, 'tests');
    expect(
      files.map((file) => file.repoPath),
      `derived from \`git ls-files -- tests\`: ${derived.join(', ')}`,
    ).toEqual(derived);
    expect(derived.length, `${ROUTE_DECLARATIONS} tracks no declaration file`).toBeGreaterThan(0);
    expect(allRoutes.length, 'the declaration union declares no route at all').toBeGreaterThan(0);
    // Every declared route is distinct, so the matrix below is a product and not a multiset with a
    // route counted twice — which the inventory gate also asserts, from the other side.
    expect(new Set(allRoutes.map(key)).size).toBe(allRoutes.length);
  });

  it('keeps the pre-authentication surface to exactly these nineteen method/path pairs', () => {
    const expected = [
      'GET /.well-known/oauth-authorization-server',
      'GET /.well-known/oauth-protected-resource/mcp/projects/:name',
      'GET /.well-known/oauth-protected-resource/mcp/builder',
      'GET /.well-known/oauth-protected-resource/api/a2a/agents/:agentName',
      'POST /oauth/token',
      'POST /oauth/revoke',
      'GET /api/setup/runtime-detect',
      'GET /api/auth/login',
      'POST /api/auth/callback',
      'GET /api/auth/workspace',
      'POST /api/auth/workspace',
      'POST /api/auth/cli-device',
      'GET /api/auth/cli-verify',
      'POST /api/auth/cli-token',
      'GET /api/cron/retention',
      'GET /api/cron/triggers',
      'GET /api/cron/storage-cleanup',
      'POST /api/triggers/:id/fire/:secret',
      'GET /api/readyz',
    ];
    expect(publicRoutes.map(key).sort()).toEqual([...expected].sort());
    expect([...PUBLIC_ROUTES].sort()).toEqual([...expected].sort());
  });

  it('keeps the identity-only, not-role-gated surface to exactly these eleven routes', () => {
    const expected = [
      'DELETE /api/auth/cli-token',
      'GET /api/a2a/agents/:agentName/.well-known/agent-card.json',
      'GET /oauth/authorize',
      'POST /api/a2a/agents/:agentName',
      'POST /api/auth/cli-verify',
      'POST /api/auth/cli-workspace',
      'POST /api/builder/mcp',
      'POST /api/invitations/:id/accept',
      'POST /mcp/builder',
      'POST /mcp/projects/:name',
      'POST /oauth/authorize',
    ];
    expect(identityOnlyRoutes.map(key).sort()).toEqual(expected);
    expect([...IDENTITY_ONLY_ROUTES].sort()).toEqual(expected);
  });

  it('covers four roles × every declared route × every ownership answer', () => {
    // Derived, not transcribed (ADR-0016). The three factors are the two constant lists this
    // program exports and the union read from the tracked tree; none of them is a number typed
    // into this file.
    expect(cells.length).toBe(routes.length * ROLES.length * OWNERSHIPS.length);
    expect(new Set(cells.map((cell) => key(cell.route))).size).toBe(routes.length);
    expect(new Set(cells.map((cell) => cell.role)).size).toBe(ROLES.length);
    expect(new Set(cells.map((cell) => cell.ownership)).size).toBe(OWNERSHIPS.length);
  });

  it('decides every cell — a route §21’s split cannot classify fails, it is not skipped', () => {
    expect(
      undecidedCells(cells),
      'Every one of these routes is declared in tests/route-declarations/ and served by the ' +
        'tracked tree, and spec §21’s permission split has no answer for it. Classify its ' +
        'resource in apps/web/server/rbac/permissions.ts, citing the sentence of §21 that ' +
        'decides the grants. An undecidable authorisation question is refused, never allowed ' +
        '(ADR-0015, ADR-0031).',
    ).toEqual([]);
  });

  it('gives every cell an explanation naming the sentence of §21 behind it', () => {
    const silent = cells
      .filter((cell) => cell.decision.because.trim() === '')
      .map((cell) => `${key(cell.route)} × ${cell.role} × ${cell.ownership}`);
    expect(silent).toEqual([]);
  });
});

describe('run-token revocation capability', () => {
  it('matches the handler for Owner, Admin, Builder and Viewer on both route shapes', () => {
    for (const path of ['/api/runs/run-1', '/api/runs/run-1/revoke-tokens']) {
      for (const role of ROLES) {
        const decision = decide({
          role,
          method: 'POST',
          path,
          ownership: 'other',
          scope: null,
        });
        if (role === 'owner' || role === 'admin') {
          expect(decision.effect, `${role} ${path}`).toBe('allow');
          if (decision.effect !== 'allow') throw new Error(`${role} was denied revocation`);
          expect(decision.facts?.operation).toBe('revoke');
        } else {
          expect(decision.effect, `${role} ${path}`).toBe('deny');
          if (decision.effect !== 'deny') throw new Error(`${role} was allowed revocation`);
          expect(decision.code).toBe('run_token_revoke_forbidden');
        }
      }
    }
  });
});

describe('the matrix says what spec §21 says', () => {
  const decisionFor = (routeKey: string, role: Role, ownership: Ownership): Decision => {
    const cell = cells.find(
      (candidate) =>
        key(candidate.route) === routeKey &&
        candidate.role === role &&
        candidate.ownership === ownership,
    );
    if (cell === undefined) {
      throw new Error(
        `no cell for ${routeKey} × ${role} × ${ownership}. This assertion names a route the ` +
          `declaration union does not contain, so it would otherwise pass by having nothing to ` +
          `check — which is the fail-open shape these tests exist to refuse.`,
      );
    }
    return cell.decision;
  };

  it('gives Owner every declared route — §21: "Everything." — with one named exception', () => {
    // `/api/workspaces` and `/api/workspaces/:id` (issue #119) are the one resource whose row IS
    // the tenant `decide()` otherwise assumes from `principal.workspaceId`. Owner's grant over it
    // is `own`, not `any` — see `permissions.ts`'s `WORKSPACE_MEMBER_SCOPED` comment and
    // `permissions.test.ts`'s matching named exception — so an Owner-in-session-A is correctly
    // *denied* here for `other`/`unknown`/`permitted` ownership of a workspace that is not their
    // own: `applyGrant('own', …)` only allows `own` and `not-applicable`. This is the "own" grant's
    // entire point, proved elsewhere (`apps/web/app/api/workspaces/**` route tests) rather than
    // weakened here to pass a check written before this resource existed.
    const refusedForOwner = cells
      .filter(
        (cell) =>
          cell.role === 'owner' &&
          cell.decision.effect !== 'allow' &&
          !cell.route.path.startsWith('/api/workspaces'),
      )
      .map((cell) => `${key(cell.route)} × ${cell.ownership}: ${cell.decision.effect}`);
    expect(refusedForOwner).toEqual([]);

    // The exception is still real coverage, not a hole: Owner reaches `allow` for `own` and
    // `not-applicable` ownership of every `/api/workspaces*` route, and is refused only for the
    // ownership answers that mean "not this caller's".
    const workspaceCells = cells.filter((cell) => cell.route.path.startsWith('/api/workspaces'));
    expect(workspaceCells.length).toBeGreaterThan(0);
    for (const ownership of ['own', 'not-applicable'] as const) {
      const denied = workspaceCells.filter(
        (cell) =>
          cell.role === 'owner' && cell.ownership === ownership && cell.decision.effect !== 'allow',
      );
      expect(denied, `owner should be allowed for ${ownership} ownership`).toEqual([]);
    }
  });

  it('is not a matrix of yes — some role is refused some declared route', () => {
    // Without this, a table that allowed everything would satisfy every other assertion here.
    expect(cells.some((cell) => cell.decision.effect === 'deny')).toBe(true);
  });

  it('gives Admin the user routes and refuses them to Builder and Viewer — §21’s Admin clause', () => {
    expect(decisionFor('POST /api/users', 'admin', 'not-applicable').effect).toBe('allow');
    expect(decisionFor('GET /api/users', 'admin', 'not-applicable').effect).toBe('allow');
    expect(decisionFor('POST /api/users', 'builder', 'not-applicable').effect).toBe('deny');
    expect(decisionFor('POST /api/users', 'viewer', 'not-applicable').effect).toBe('deny');
    expect(decisionFor('GET /api/users', 'viewer', 'not-applicable').effect).toBe('deny');
  });

  it('lets Admin read another member’s run and its events, and refuses both to Builder and Viewer — §21’s Admin clause read by issue #165', () => {
    // `GET /api/runs × admin × not-applicable` is deliberately NOT the cell asserted here, and its
    // absence is the point: `applyGrant`'s `own` arm (`decide.ts`) allows `not-applicable`
    // ownership at *any* width, so the collection route answers `allow` for every role whether
    // Admin's grant is `own` or `any` — this matrix cannot state the list's width at all. The
    // load-bearing cells for the width are the single-row ones below, plus the behavioural test in
    // `apps/web/server/runs/api.test.ts` ("an Admin sees every run in the workspace…"), which
    // drives `GET /api/runs` and reads the rows back.
    //
    // `GET /api/runs/:id/events` is in this list because `events` inherits its parent's grants by
    // design (`permissions.ts`'s sub-resource table), so the transcript widens with the run — named
    // here rather than left to be discovered. See
    // docs/adr/W9-AUTH-165-admin-reads-workspace-run-history.md.
    for (const route of ['GET /api/runs/:id', 'GET /api/runs/:id/events']) {
      expect(decisionFor(route, 'admin', 'other').effect, route).toBe('allow');
      expect(decisionFor(route, 'admin', 'own').effect, route).toBe('allow');
      expect(decisionFor(route, 'builder', 'other').effect, route).toBe('deny');
      expect(decisionFor(route, 'viewer', 'other').effect, route).toBe('deny');
      expect(decisionFor(route, 'builder', 'own').effect, route).toBe('allow');
      expect(decisionFor(route, 'viewer', 'own').effect, route).toBe('allow');
    }
  });

  it('gives Admin the API-key routes — §21 names "API keys" in Admin’s list', () => {
    expect(decisionFor('POST /api/api-keys', 'admin', 'not-applicable').effect).toBe('allow');
    expect(decisionFor('DELETE /api/api-keys/:id', 'admin', 'unknown').effect).toBe('allow');
    expect(decisionFor('POST /api/api-keys', 'builder', 'not-applicable').effect).toBe('deny');
    expect(decisionFor('POST /api/api-keys', 'viewer', 'not-applicable').effect).toBe('deny');
  });

  it('gives Admin the invitations routes and refuses them to Builder and Viewer — issue #121', () => {
    expect(decisionFor('POST /api/invitations', 'admin', 'not-applicable').effect).toBe('allow');
    expect(decisionFor('GET /api/invitations', 'admin', 'not-applicable').effect).toBe('allow');
    expect(decisionFor('POST /api/invitations/:id/resend', 'admin', 'unknown').effect).toBe(
      'allow',
    );
    expect(decisionFor('DELETE /api/invitations/:id', 'admin', 'unknown').effect).toBe('allow');
    expect(decisionFor('POST /api/invitations', 'builder', 'not-applicable').effect).toBe('deny');
    expect(decisionFor('POST /api/invitations', 'viewer', 'not-applicable').effect).toBe('deny');
    expect(decisionFor('GET /api/invitations', 'builder', 'not-applicable').effect).toBe('deny');
    expect(decisionFor('GET /api/invitations', 'viewer', 'not-applicable').effect).toBe('deny');
    // Owner's `EVERYTHING` fallback covers a resource nobody overrode for it, `invitations` included.
    expect(decisionFor('POST /api/invitations', 'owner', 'not-applicable').effect).toBe('allow');
  });

  it('lets a Builder create an agent and edit only its own — §21’s "where permitted"', () => {
    expect(decisionFor('POST /api/agents', 'builder', 'not-applicable').effect).toBe('allow');
    expect(decisionFor('PATCH /api/agents/:id', 'builder', 'own').effect).toBe('allow');
    expect(decisionFor('PATCH /api/agents/:id', 'builder', 'other').effect).toBe('deny');
    // The honest answer from a handler that has not read the row denies. ADR-0031.
    expect(decisionFor('PATCH /api/agents/:id', 'builder', 'unknown').effect).toBe('deny');
  });

  it('never lets a lower role reach what a higher one is refused (ADR-0152)', () => {
    // A Builder named by an `agent_grants` row runs that agent, as a Viewer with the same row does;
    // a Builder runs its own; neither runs an agent it neither owns nor was granted.
    for (const role of ['builder', 'viewer'] as const) {
      expect(decisionFor('POST /api/agents/:id/runs', role, 'permitted').effect, role).toBe(
        'allow',
      );
      expect(decisionFor('POST /api/agents/:id/runs', role, 'own').effect, role).toBe('allow');
      expect(decisionFor('POST /api/agents/:id/runs', role, 'other').effect, role).toBe('deny');
      expect(decisionFor('POST /api/agents/:id/runs', role, 'unknown').effect, role).toBe('deny');
    }
    // An Admin reads and edits every project, as a Builder does its own.
    expect(decisionFor('GET /api/projects/:id', 'builder', 'own').effect).toBe('allow');
    expect(decisionFor('GET /api/projects/:id', 'admin', 'other').effect).toBe('allow');
    expect(decisionFor('PATCH /api/projects/:id', 'admin', 'other').effect).toBe('allow');
    expect(decisionFor('POST /api/projects', 'admin', 'not-applicable').effect).toBe('allow');
  });

  it('refuses a Viewer an agent it neither owns nor was granted — §21’s "permitted agents"', () => {
    const run = decisionFor('POST /api/agents/:id/runs', 'viewer', 'other');
    expect(run.effect).toBe('deny');
    expect(run.because).toContain('permitted');
    // …and a Viewer can still see the agent list, which is what makes §21's Viewer clause a
    // sentence about something at all.
    expect(decisionFor('GET /api/agents', 'viewer', 'not-applicable').effect).toBe('allow');
  });

  it('lets Admin manage skills and files like Builder, and refuses Builder and Viewer the routes §21 gives to Admin', () => {
    // ADR-0116 (superseding W2-CP-06's literal reading of §21's Admin list): Admin holds `skills`
    // and `files` the way it holds `agents` — every row, not only its own.
    const at = (role: Role, method: string, path: string, ownership: Ownership) =>
      decide({ role, method, path, ownership, scope: null }).effect;
    expect(at('admin', 'POST', '/api/skills', 'not-applicable')).toBe('allow');
    expect(at('builder', 'POST', '/api/skills', 'not-applicable')).toBe('allow');
    expect(at('admin', 'POST', '/api/files', 'not-applicable')).toBe('allow');
    expect(at('builder', 'POST', '/api/files', 'not-applicable')).toBe('allow');
    expect(at('admin', 'PATCH', '/api/skills/review-checklist', 'other')).toBe('allow');
    expect(at('admin', 'DELETE', '/api/files/file-1', 'other')).toBe('allow');
    // Builder's width is still its own rows: another member's skill stays out of reach.
    expect(at('builder', 'PATCH', '/api/skills/review-checklist', 'other')).toBe('deny');
    // …and the other direction: §21 names no role but Owner for secrets (§23).
    expect(
      decide({
        role: 'admin',
        method: 'GET',
        path: '/api/secrets',
        ownership: 'not-applicable',
        scope: null,
      }).effect,
    ).toBe('deny');
    expect(
      decide({
        role: 'owner',
        method: 'GET',
        path: '/api/secrets',
        ownership: 'not-applicable',
        scope: null,
      }).effect,
    ).toBe('allow');
  });
});

describe('the matrix fails closed — the counter-examples, run', () => {
  /**
   * ADR-0029: a finding about a gate is only a defect when a tree the gate ought to reject is
   * built and the gate accepts it. These are that tree — synthetic declarations handed to the same
   * `matrix` and `undecidedCells` the live gate uses, so what is proved is the gate's own
   * behaviour and not a paraphrase of it. Nothing is written into the repository to build them.
   */
  const synthetic = (method: string, path: string): DeclaredRoute => ({
    method,
    path,
    owner: 'W2-XX-99',
    where: 'a synthetic declaration built inside this test',
  });

  it('refuses a route whose resource §21’s split does not classify', () => {
    const faults = undecidedCells(matrix([synthetic('GET', '/api/widgets')]));
    expect(faults.length).toBe(ROLES.length * OWNERSHIPS.length);
    expect(faults[0]).toContain('"widgets" is not a resource');
    expect(faults[0]).toContain('W2-XX-99');
  });

  it('refuses a method it has never classified', () => {
    expect(undecidedCells(matrix([synthetic('OPTIONS', '/api/users')])).length).toBe(
      ROLES.length * OWNERSHIPS.length,
    );
    expect(undecidedCells(matrix([synthetic('TRACE', '/api/users')])).length).toBe(
      ROLES.length * OWNERSHIPS.length,
    );
  });

  it('refuses a path deeper than the shape spec §34 admits', () => {
    const faults = undecidedCells(matrix([synthetic('GET', '/api/agents/:id/runs/:runId/events')]));
    expect(faults.length).toBe(ROLES.length * OWNERSHIPS.length);
    expect(faults[0]).toContain('deeper than');
  });

  it('refuses a role that is not one of §21’s four, rather than treating it as the least one', () => {
    const decision = decide({
      // The cast is the point of the test: this is the value that arrives from a database row or a
      // JSON body through an `as`, and a type annotation is no evidence about it.
      role: 'superuser' as Role,
      method: 'GET',
      path: '/api/users',
      ownership: 'not-applicable',
      scope: null,
    });
    expect(decision.effect).toBe('refuse');
    expect(decision.because).toContain('four roles');
  });

  it('refuses a page path, and allows spec §34’s public surface to every role', () => {
    expect(
      decide({
        role: 'owner',
        method: 'GET',
        path: '/agents',
        ownership: 'not-applicable',
        scope: null,
      }).effect,
    ).toBe('refuse');
    for (const role of ROLES) {
      expect(
        decide({ role, method: 'GET', path: '/p/:token', ownership: 'not-applicable', scope: null })
          .effect,
      ).toBe('allow');
    }
  });

  it('refuses an unclassified SUB-resource, rather than giving it the parent’s grant', () => {
    // The verifier's round-1 counter-example, as a permanent gate. `GET /api/agents/:id/secrets`
    // is `/api/<classified>/:id/<anything>`: round 1 looked up only segment 2, so all four roles
    // were ALLOWED it — Viewer included — while `/api/secrets` denies it to everyone but the
    // Owner. The two decisions are asserted side by side so the pair cannot drift apart again.
    const faults = undecidedCells(matrix([synthetic('GET', '/api/agents/:id/secrets')]));
    expect(faults.length).toBe(ROLES.length * OWNERSHIPS.length);
    expect(faults[0]).toContain('"secrets" is not a sub-resource');
    for (const role of ROLES) {
      expect(
        decide({
          role,
          method: 'GET',
          path: '/api/agents/:id/secrets',
          ownership: 'not-applicable',
          scope: null,
        }).effect,
        role,
      ).toBe('refuse');
    }
    // …and the sub-resources §34 does print are still decided, so this is a classifier and not a
    // blanket refusal of every three-segment path.
    for (const [method, path, ownership] of [
      ['POST', '/api/agents/:id/runs', 'own'],
      ['GET', '/api/runs/:id/events', 'own'],
      ['POST', '/api/sessions/:id/messages', 'own'],
    ] as const) {
      expect(decide({ role: 'owner', method, path, ownership, scope: null }).effect, path).toBe(
        'allow',
      );
    }
  });

  it('would have caught an unclassified resource among the real declarations', () => {
    // The live union with one synthetic entry appended: the gate must go from clean to failing,
    // which is the property "this test can fail" rather than the property "this test passes".
    expect(undecidedCells(cells)).toEqual([]);
    const faults = undecidedCells(matrix([...routes, synthetic('POST', '/api/widgets')]));
    expect(faults.length).toBeGreaterThan(0);
    expect(faults.every((fault) => fault.includes('/api/widgets'))).toBe(true);
  });
});

/**
 * §3.1's scope grammar (issue #236, SDK-04, S-1) — the sanity checks over `decide()`'s own scope
 * gate. `token-scope-matrix.test.ts` is the exhaustive, route-declaration-derived version of this;
 * these are the cases that gate is built to generalise, asserted directly against a hand-picked
 * route so a regression here is legible on its own.
 */
describe('a browser token’s scope narrows decide(), before §21’s table is even consulted', () => {
  const OWNER_ARGS = { role: 'owner' as const, ownership: 'own' as const };

  it('a run scope reads its own run and its events, and nothing else', () => {
    const scope = { kind: 'run' as const, id: 'run-1' };
    for (const path of ['/api/runs/run-1', '/api/runs/run-1/events']) {
      const decision = decide({ ...OWNER_ARGS, method: 'GET', path, scope });
      expect(decision.effect, path).toBe('allow');
    }
    // A different run's id: same shape, wrong row.
    const wrongRow = decide({ ...OWNER_ARGS, method: 'GET', path: '/api/runs/run-2', scope });
    expect(wrongRow.effect).toBe('deny');
    expect(wrongRow.effect === 'deny' && wrongRow.code).toBe('token_out_of_scope');
    // The collection route: no ":id" at all.
    const list = decide({
      ...OWNER_ARGS,
      ownership: 'not-applicable',
      method: 'GET',
      path: '/api/runs',
      scope,
    });
    expect(list.effect).toBe('deny');
    expect(list.effect === 'deny' && list.code).toBe('token_out_of_scope');
    // Out of the grammar entirely.
    const interrupt = decide({
      ...OWNER_ARGS,
      method: 'POST',
      path: '/api/runs/run-1/interrupt',
      scope,
    });
    expect(interrupt.effect).toBe('deny');
    expect(interrupt.effect === 'deny' && interrupt.code).toBe('token_out_of_scope');
  });

  it('a session scope starts runs and reads runs, with no id check at decide()’s layer', () => {
    const scope = { kind: 'session' as const, id: 'session-1' };
    const start = decide({
      role: 'owner',
      ownership: 'not-applicable',
      method: 'POST',
      path: '/api/agents/agent-1/runs',
      scope,
    });
    expect(start.effect).toBe('allow');
    // Reading a run by id is in-grammar even though decide() cannot know, from the path alone,
    // whether that run belongs to this session — see `runs/api.ts` for the row-level half.
    const read = decide({ ...OWNER_ARGS, method: 'GET', path: '/api/runs/run-1', scope });
    expect(read.effect).toBe('allow');
    // Still no collection list, and still nothing outside the two grammar cells.
    const list = decide({
      role: 'owner',
      ownership: 'not-applicable',
      method: 'GET',
      path: '/api/runs',
      scope,
    });
    expect(list.effect).toBe('deny');
    const other = decide({
      ...OWNER_ARGS,
      method: 'GET',
      path: '/api/agents',
      ownership: 'not-applicable',
      scope,
    });
    expect(other.effect).toBe('deny');
  });

  it('a session scope rates a run (issue #539) but still reaches no other run verb', () => {
    const scope = { kind: 'session' as const, id: 'session-1' };
    expect(routes.some((r) => r.method === 'POST' && r.path === '/api/runs/:id/feedback')).toBe(
      true,
    );
    for (const role of ['owner', 'viewer'] as const) {
      const feedback = decide({
        role,
        ownership: 'own',
        method: 'POST',
        path: '/api/runs/run-1/feedback',
        scope,
      });
      expect(feedback.effect, role).toBe('allow');
      expect(feedback.effect !== 'refuse' && feedback.facts).toEqual({
        resource: 'runs',
        operation: 'run',
        grant: role === 'owner' ? 'any' : 'own',
      });
    }
    // The cell is keyed by `feedback`: interrupt is the same (runs, run) pair and stays out.
    const interrupt = decide({
      ...OWNER_ARGS,
      method: 'POST',
      path: '/api/runs/run-1/interrupt',
      scope,
    });
    expect(interrupt.effect).toBe('deny');
    expect(interrupt.effect === 'deny' && interrupt.code).toBe('token_out_of_scope');
    // A run scope never reaches feedback.
    const runScoped = decide({
      ...OWNER_ARGS,
      method: 'POST',
      path: '/api/runs/run-1/feedback',
      scope: { kind: 'run', id: 'run-1' },
    });
    expect(runScoped.effect === 'deny' && runScoped.code).toBe('token_out_of_scope');
  });

  it('deciding a paused run (issue #1301) is the run verb on own runs, and no token scope reaches it', () => {
    expect(routes.some((r) => r.method === 'POST' && r.path === '/api/runs/:id/approval')).toBe(
      true,
    );
    for (const role of ['owner', 'builder', 'viewer'] as const) {
      const approval = decide({
        role,
        ownership: 'own',
        method: 'POST',
        path: '/api/runs/run-1/approval',
        scope: null,
      });
      expect(approval.effect, role).toBe('allow');
      expect(approval.effect !== 'refuse' && approval.facts?.operation, role).toBe('run');
    }
    // Another member's run is a deny for a role whose grant is `own`.
    const foreign = decide({
      role: 'viewer',
      ownership: 'other',
      method: 'POST',
      path: '/api/runs/run-1/approval',
      scope: null,
    });
    expect(foreign.effect).toBe('deny');
    for (const scope of [
      { kind: 'run' as const, id: 'run-1' },
      { kind: 'session' as const, id: 'session-1' },
    ]) {
      const scoped = decide({
        ...OWNER_ARGS,
        method: 'POST',
        path: '/api/runs/run-1/approval',
        scope,
      });
      expect(scoped.effect === 'deny' && scoped.code, scope.kind).toBe('token_out_of_scope');
    }
  });

  it('a scope only narrows: the ordinary role/ownership check still applies inside the grammar', () => {
    // A Viewer's grant over `runs` is `own`, never `any`; a run scope reading a run this Viewer
    // does not own is still `deny`, just with the ordinary "forbidden" code, not the scope one.
    const scope = { kind: 'run' as const, id: 'run-1' };
    const decision = decide({
      role: 'viewer',
      method: 'GET',
      path: '/api/runs/run-1',
      ownership: 'other',
      scope,
    });
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.code).toBeUndefined();
  });

  it('scope: null is every existing call site, and changes no decision the matrix above covers', () => {
    for (const cell of matrix(routes)) {
      const withScope = decide({
        role: cell.role,
        method: cell.route.method,
        path: cell.route.path,
        ownership: cell.ownership,
        scope: null,
      });
      expect(withScope).toEqual(cell.decision);
    }
  });
});
