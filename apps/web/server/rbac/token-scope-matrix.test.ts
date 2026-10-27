/**
 * The browser-token scope matrix (issue #236, SDK-04, S-1): **every** declared route × both scope
 * kinds × a matching id / a non-matching id, derived from `tests/route-declarations/**` the same
 * way `authorisation-matrix.test.ts` derives its own matrix — so a route another unit adds is in
 * this matrix the moment it is committed, with no edit here, and it fails closed by construction.
 *
 * This is the acceptance criterion "a run-scoped token can follow that run's stream and read that
 * run, and nothing else; a session-scoped token can start runs in that session and read them, and
 * nothing else — every other route answers `403` with a stable code", proved by quantification
 * over the declared union rather than by a hand-written list of "every other route".
 *
 * ## Why every route is compared against its own scope-less baseline
 *
 * `decide()`'s scope gate runs only inside the `api` surface, after a path has parsed to a
 * `(resource, operation)` pair (`decide.ts`'s own body). Two kinds of declared route never reach
 * that point at all: spec §34's `public` surface (`/p/**`, the four `/api/auth/*` routes, `GET
 * /api/setup/runtime-detect`) answers `allow` to every role before any table is consulted, and a
 * handful of routes (`POST /api/invitations/:id/accept`) carry a sub-resource `decide()`'s table
 * does not classify and therefore `refuse` regardless of who or what is asking. Neither is scope's
 * business to change, and a hand-copied exemption list for them would be the exact drift risk this
 * file exists to avoid. So the baseline is computed with `scope: null` first, and only a route
 * whose baseline is a real `§21` decision (`allow`/`deny` with `facts !== null`) is asked to change
 * under a scope; every other route is asserted to answer **identically**, scope or not.
 *
 * ## What this file does NOT re-prove
 *
 * That an expired, revoked, or cross-tenant token never reaches `decide()` with a scope at all —
 * that is the verifier's own property, proved against real PostgreSQL by
 * `apps/web/server/composition/browser-token-principal.integration.test.ts`. This file is purely
 * about `decide()`'s scope *grammar*, given a scope it already has.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createRunTokenCodec } from '@agent-workspace/gateway/tokens';
import { API_ROUTES } from '@indx-workspace/contracts/routes';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  readDeclarationFiles,
  REPO_ROOT,
  requireString,
  trackedFiles,
} from '../../../../tests/inventory-support';
import { proxy } from '../../proxy';
import { serveExternalBuilderMcp, type ExternalPrincipal } from '../builder/transport/external';
import { MIN_SESSION_SECRET_LENGTH } from '../auth/session';

import {
  decide,
  ENDPOINT_SCOPE_KINDS,
  TOKEN_SCOPE_KINDS,
  type Decision,
  type TokenScopeKind,
} from './decide';
import { isEndpointScope } from './token-scope';

/** The directory ADR-0025 partitions the inventory into — the same one `authorisation-matrix.test.ts` reads. */
const ROUTE_DECLARATIONS = 'tests/route-declarations';

interface DeclaredRoute {
  readonly method: string;
  readonly path: string;
  readonly owner: string;
  readonly where: string;
}

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

/**
 * Every `:param` placeholder of a path, replaced by a concrete value — the same specification
 * notation `decide()` is fed in production once Next's `[id]` has resolved. The declared paths only
 * ever use `:id`; the catalogue also uses `:agentName`, `:name`, `:digest`, `:engineSessionId` and
 * `:token`, so the replace covers every segment of that shape.
 */
function withId(path: string, id: string): string {
  return path.replaceAll(/:[A-Za-z]+/gu, id);
}

const MATCHING_ID = 'row-a';
const OTHER_ID = 'row-b';

/** Exactly §3.1's grammar, restated as data so a drift between the two tables is a red test. */
const IN_GRAMMAR: Readonly<Record<TokenScopeKind, ReadonlySet<string>>> = {
  run: new Set(['GET /api/runs/:id', 'GET /api/runs/:id/events']),
  session: new Set([
    'GET /api/runs/:id',
    'GET /api/runs/:id/events',
    'POST /api/agents/:id/runs',
    'POST /api/runs/:id/feedback',
    // Issue #251 (N-4): a session token reads its own attachments straight from the object store;
    // it mints no upload URL (issue #1574).
    'POST /api/files/:id/download-urls',
    // Issue #1308 (P7-2): a session token uploads one file into its own session.
    'POST /api/sessions/:engineSessionId/attachments',
  ]),
  // ADR-0134: an endpoint-scoped API key reaches one agent's run route, or nothing at all.
  'a2a-agent': new Set(['POST /api/agents/:id/runs']),
  'mcp-project': new Set(),
  // Slice 5a: a builder token reaches `/mcp/builder` only, outside `/api/`.
  builder: new Set(),
};

/** Every kind a `Principal` can carry: the browser-token kinds and the endpoint-key kinds. */
const SCOPE_KINDS: readonly TokenScopeKind[] = [...TOKEN_SCOPE_KINDS, ...ENDPOINT_SCOPE_KINDS];

/** Whether `decide()` ever reached its own §21 table for this query — see this file's header. */
function isRealDecision(decision: Decision): boolean {
  return (decision.effect === 'allow' || decision.effect === 'deny') && decision.facts !== null;
}

interface MatrixRoute {
  readonly method: string;
  readonly path: string;
}

const routes = declaredRoutes();
const declaredKeys = new Set(routes.map((route) => `${route.method} ${route.path}`));
const catalogueKeys = new Set(API_ROUTES.map((route) => `${route.method} ${route.path}`));

describe('the token scope matrix is derived from the live route union', () => {
  it('has routes to cross, and its grammar cites routes the union actually declares', () => {
    expect(routes.length).toBeGreaterThan(0);
    for (const kind of SCOPE_KINDS) {
      for (const cell of IN_GRAMMAR[kind]) {
        expect(declaredKeys.has(cell), `${cell} is not in the declared route union`).toBe(true);
        expect(catalogueKeys.has(cell), `${cell} is not in API_ROUTES`).toBe(true);
      }
    }
  });

  it('treats uppercase UUID paths as the same run named by a scoped token', () => {
    const runId = '123e4567-e89b-42d3-a456-426614174000';
    for (const suffix of ['', '/events']) {
      const decision = decide({
        role: 'owner',
        method: 'GET',
        path: `/api/runs/${runId.toUpperCase()}${suffix}`,
        ownership: 'own',
        scope: { kind: 'run', id: runId },
      });
      expect(decision.effect, decision.because).toBe('allow');
    }
  });
});

/** The two cells of one route for one scope kind: a matching id and a non-matching id. */
function routeCells(kind: TokenScopeKind, route: MatrixRoute): void {
  const routeKey = `${route.method} ${route.path}`;
  const inGrammar = IN_GRAMMAR[kind].has(routeKey);
  const hasIdSegment = route.path.includes(':');
  const ownership = hasIdSegment ? ('own' as const) : ('not-applicable' as const);

  function baseline(id: string): Decision {
    return decide({
      role: 'owner',
      method: route.method,
      path: withId(route.path, id),
      ownership,
      scope: null,
    });
  }

  it('a matching id: allowed by the grammar, a stable token_out_of_scope, or an unaffected baseline', () => {
    const before = baseline(MATCHING_ID);
    const decision = decide({
      role: 'owner',
      method: route.method,
      path: withId(route.path, MATCHING_ID),
      ownership,
      scope: { kind, id: MATCHING_ID },
    });
    if (!isRealDecision(before)) {
      // Outside §21's table entirely (public surface, or an unclassified path) — a scope cannot
      // change what was never consulted.
      expect(decision).toEqual(before);
      return;
    }
    expect(decision.effect, decision.because).not.toBe('refuse');
    if (!inGrammar) {
      expect(decision.effect, decision.because).toBe('deny');
      expect(decision.effect === 'deny' && decision.code).toBe('token_out_of_scope');
    } else if (decision.effect === 'deny') {
      // In grammar: the scope does not itself refuse. It may still be `deny` on the ordinary
      // §21 table (a role with no grant), but never with the scope's own code.
      expect(decision.code).not.toBe('token_out_of_scope');
    }
  });

  it('a non-matching id on a run scope’s own resource: token_out_of_scope; elsewhere unaffected', () => {
    const before = baseline(MATCHING_ID);
    const decision = decide({
      role: 'owner',
      method: route.method,
      path: withId(route.path, MATCHING_ID),
      ownership,
      scope: { kind, id: OTHER_ID },
    });
    if (!isRealDecision(before)) {
      expect(decision).toEqual(before);
      return;
    }
    expect(decision.effect, decision.because).not.toBe('refuse');
    // A run scope names the exact row its `:id` must be, for the one resource (`runs`) where
    // the path's `:id` names that row directly. Every other in-grammar cell (a session scope
    // reading a run or starting one; any route not in the grammar at all) does not compare the
    // path's `:id` to the scope's `id` here — that identity is a session's row fact, checked at
    // the row read (`apps/web/server/runs/api.ts`), not a fact `decide()` can derive from a path.
    // An a2a-agent scope names the agent the same way, on its one in-grammar route.
    const isRunIdentityCell =
      (kind === 'run' && routeKey.startsWith('GET /api/runs/')) ||
      (kind === 'a2a-agent' && routeKey === 'POST /api/agents/:id/runs') ||
      (kind === 'session' && routeKey === 'POST /api/sessions/:engineSessionId/attachments');
    if (!inGrammar || isRunIdentityCell) {
      expect(decision.effect, decision.because).toBe('deny');
      expect(decision.effect === 'deny' && decision.code).toBe('token_out_of_scope');
    } else if (decision.effect === 'deny') {
      expect(decision.code).not.toBe('token_out_of_scope');
    }
  });
}

describe.each(SCOPE_KINDS)('a %s-scoped credential, across every declared route', (kind) => {
  describe.each(routes)('$method $path ($owner)', (route) => {
    routeCells(kind, route);
  });
});

describe.each(SCOPE_KINDS)('a %s-scoped credential, across every catalogue route', (kind) => {
  describe.each(API_ROUTES)('$method $path', (route) => {
    routeCells(kind, route);
  });
});

/**
 * Issue #1846 (slices 5a, 5b): a `builder` endpoint-client token is accepted only by `/mcp/builder`,
 * so every other declared and catalogued route refuses it. `decide()` is the control-plane half of
 * that refusal; the door audiences are proved in the two door tests and the `/mcp/builder` side in
 * the next block.
 */
describe('a builder endpoint-client token is refused by every other route', () => {
  const everyRoute = [
    ...new Map(
      [...routes, ...API_ROUTES].map((route) => [`${route.method} ${route.path}`, route]),
    ).values(),
  ];

  it('is an endpoint scope, so a browser token can never carry it', () => {
    expect(isEndpointScope('builder')).toBe(true);
  });

  it('is denied token_out_of_scope wherever §21 is consulted, and unaffected elsewhere', () => {
    expect(everyRoute.length).toBeGreaterThan(50);
    for (const route of everyRoute) {
      const ownership = route.path.includes(':') ? ('own' as const) : ('not-applicable' as const);
      const query = {
        role: 'owner',
        method: route.method,
        path: withId(route.path, MATCHING_ID),
        ownership,
      } as const;
      const before = decide({ ...query, scope: null });
      const decision = decide({ ...query, scope: { kind: 'builder', id: MATCHING_ID } });
      const where = `${route.method} ${route.path}`;
      if (isRealDecision(before)) {
        expect(decision.effect, where).toBe('deny');
        expect(decision.effect === 'deny' && decision.code, where).toBe('token_out_of_scope');
      } else {
        expect(decision, where).toEqual(before);
      }
    }
  });
});

/**
 * Issue #1846 (slice 5b): the one door that accepts a `builder` token. Every credential kind the
 * resolver can hand it is crossed with every scope kind: only an OAuth token of the `builder` kind
 * and the `/mcp/builder` audience is served; the other endpoint kinds, a session cookie, an API key,
 * a run token (a browser-token principal) and a user token are refused before any tool runs.
 */
describe('/mcp/builder accepts a builder-kind OAuth token and nothing else', () => {
  const ORIGIN = 'https://aw.example';
  const previousUrl = process.env['AW_PUBLIC_URL'];
  beforeAll(() => {
    process.env['AW_PUBLIC_URL'] = ORIGIN;
  });
  afterAll(() => {
    if (previousUrl === undefined) delete process.env['AW_PUBLIC_URL'];
    else process.env['AW_PUBLIC_URL'] = previousUrl;
  });

  const principalOf = (
    via: ExternalPrincipal['via'],
    kind: TokenScopeKind | null,
    audience = `${ORIGIN}/mcp/builder`,
  ): ExternalPrincipal => ({
    via,
    oauth: via === 'oauth-token' ? { clientId: 'client-1', audience } : null,
    scope: kind === null ? null : { kind, id: 'client-1' },
    workspaceId: 'ws-1',
    principalId: 'principal-1',
    ownerPrincipalId: 'principal-1',
    userId: 'user-1',
    role: 'builder',
    apiKeyId: via === 'api-key' ? 'key-1' : null,
  });

  const statusFor = async (principal: ExternalPrincipal | null): Promise<number> =>
    (
      await serveExternalBuilderMcp(
        new Request(`${ORIGIN}/mcp/builder`, {
          method: 'POST',
          headers: { authorization: 'Bearer awo_live_x', 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        }),
        { identify: () => Promise.resolve(principal), ports: null },
      )
    ).status;

  it('serves the builder kind and refuses every other scope kind of an OAuth token', async () => {
    for (const kind of SCOPE_KINDS) {
      const status = await statusFor(principalOf('oauth-token', kind));
      expect(status, kind).toBe(kind === 'builder' ? 200 : 403);
    }
  });

  it('refuses a token of another endpoint kind for its own audience, and a builder token for another audience', async () => {
    const projects = principalOf('oauth-token', 'mcp-project', `${ORIGIN}/mcp/projects/x`);
    const agents = principalOf('oauth-token', 'a2a-agent', `${ORIGIN}/api/a2a/agents/x`);
    const elsewhere = principalOf('oauth-token', 'builder', `${ORIGIN}/mcp/projects/x`);
    for (const principal of [projects, agents, elsewhere]) {
      expect(await statusFor(principal)).toBe(401);
    }
  });

  it('refuses a session cookie, an API key, a run token and a user token, whatever their scope', async () => {
    for (const via of ['session', 'api-key', 'browser-token', 'user-token'] as const) {
      for (const kind of [null, ...SCOPE_KINDS]) {
        expect(await statusFor(principalOf(via, kind)), `${via} ${String(kind)}`).toBe(403);
      }
    }
  });

  it('refuses a revoked or expired token, which the resolver reports as no principal', async () => {
    expect(await statusFor(null)).toBe(401);
  });
});

/**
 * Issue #1846 (BLD-3): a run token is a `run-caller` on `POST /api/builder/mcp` and on no other
 * route. Run tokens are gated at the edge (`apps/web/proxy.ts`), not by `decide()`, so this is
 * proved where they are checked: a signed run token, with no cookie, is sent through `proxy()` to
 * every declared and catalogued route. The edge must answer it exactly as it answers a request with
 * no credential at all, except on the runner's `/api/sessions/**` family (principal `runner`, never
 * `run-caller`).
 */
describe('a run token is a run-caller on /api/builder/mcp and nowhere else', () => {
  const PASSED_THROUGH = 'x-middleware-next';
  const previousSecret = process.env['SESSION_SECRET'];
  let runToken = '';

  beforeAll(async () => {
    process.env['SESSION_SECRET'] = 'k'.repeat(MIN_SESSION_SECRET_LENGTH);
    runToken = await createRunTokenCodec({
      secret: 'token-scope-matrix-signing-secret-at-least-32-bytes',
    }).issue({
      runId: 'run-1',
      sessionId: 'session-1',
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      modelConnectionId: 'model-1',
      caller: { sub: 'principal-1', principalKind: 'membership' },
    });
  });
  afterAll(() => {
    if (previousSecret === undefined) delete process.env['SESSION_SECRET'];
    else process.env['SESSION_SECRET'] = previousSecret;
  });

  const everyRoute = [
    ...new Map(
      [...routes, ...API_ROUTES].map((route) => [`${route.method} ${route.path}`, route]),
    ).values(),
  ];

  async function passes(method: string, route: string, headers: Record<string, string>) {
    const response = await proxy(
      new NextRequest(new URL(route, 'http://127.0.0.1:3000'), { method, headers }),
    );
    return response.headers.get(PASSED_THROUGH) === '1';
  }

  it('crosses a non-trivial route union that includes the builder door', () => {
    expect(everyRoute.length).toBeGreaterThan(50);
    expect(everyRoute.some((r) => `${r.method} ${r.path}` === 'POST /api/builder/mcp')).toBe(true);
  });

  it('changes the edge answer on the runner family only, and passes the builder door', async () => {
    const changed: string[] = [];
    for (const route of everyRoute) {
      const target = withId(route.path, MATCHING_ID);
      const withToken = await passes(route.method, target, { authorization: `Bearer ${runToken}` });
      if (withToken !== (await passes(route.method, target, {}))) {
        changed.push(`${route.method} ${route.path}`);
      }
    }
    expect(
      changed.filter((route) => !route.includes(' /api/sessions')),
      'a run token reached a route other than the runner family',
    ).toEqual([]);
    expect(await passes('POST', '/api/builder/mcp', { authorization: `Bearer ${runToken}` })).toBe(
      true,
    );
  });

  it('keeps the builder exemption exact by method and path', async () => {
    const headers = { authorization: `Bearer ${runToken}` };
    for (const [method, target] of [
      ['GET', '/api/builder/mcp'],
      ['PUT', '/api/builder/mcp'],
      ['POST', '/api/builder/mcp/'],
      ['POST', '/api/builder/mcp/extra'],
      ['POST', '/api/builder'],
    ] as const) {
      expect(await passes(method, target, headers), `${method} ${target}`).toBe(false);
    }
  });

  it('builds a run-caller only under server/builder/transport', () => {
    const importers = trackedFiles('apps/web')
      .filter((file) => /\.tsx?$/u.test(file))
      .filter((file) => !file.startsWith('apps/web/server/builder/transport/'))
      .filter((file) => file !== 'apps/web/server/rbac/token-scope-matrix.test.ts')
      .filter((file) =>
        readFileSync(path.join(REPO_ROOT, file), 'utf8').includes('verifyRunCaller'),
      );
    expect(importers).toEqual([]);
  });
});
