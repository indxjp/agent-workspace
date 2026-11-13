import { describe, expect, it } from 'vitest';
import { declarationPaths, readDeclarationFiles } from '../../../../tests/inventory-support';
import {
  allRoutes,
  cells,
  IDENTITY_ONLY_ROUTES,
  identityOnlyRoutes,
  key,
  PUBLIC_ROUTES,
  publicRoutes,
  ROUTE_DECLARATIONS,
  routes,
  undecidedCells,
} from './authorisation-matrix.test-support';
import { ROLES } from './core/roles';
import { OWNERSHIPS } from './decide';

describe('the authorisation matrix is derived from the route declarations', () => {
  it(
    'reads every tracked declaration file, derived twice from the tracked tree',
    readsEveryTrackedDeclarationFileDerivedTwiceTracked,
  );

  it(
    'keeps the pre-authentication surface to exactly these twenty method/path pairs',
    keepsPreAuthenticationSurfaceExactlyTheseTwentyMethod,
  );

  it(
    'keeps the identity-only, not-role-gated surface to exactly these twelve routes',
    keepsIdentityOnlyNotRoleGatedSurfaceExactly,
  );

  it(
    'covers four roles × every declared route × every ownership answer',
    coversFourRolesEveryDeclaredRouteEveryOwnership,
  );

  it(
    'decides every cell — a route §21’s split cannot classify fails, it is not skipped',
    decidesEveryCellRoute21SSplitCannot,
  );

  it(
    'gives every cell an explanation naming the sentence of §21 behind it',
    givesEveryCellExplanationNamingSentence21Behind,
  );
});

function readsEveryTrackedDeclarationFileDerivedTwiceTracked() {
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
}

function keepsPreAuthenticationSurfaceExactlyTheseTwentyMethod() {
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
    'POST /api/auth/token-exchange',
    'GET /api/cron/retention',
    'GET /api/cron/triggers',
    'GET /api/cron/storage-cleanup',
    'POST /api/triggers/:id/fire/:secret',
    'GET /api/readyz',
  ];
  expect(publicRoutes.map(key).sort()).toEqual([...expected].sort());
  expect([...PUBLIC_ROUTES].sort()).toEqual([...expected].sort());
}

function keepsIdentityOnlyNotRoleGatedSurfaceExactly() {
  const expected = [
    'DELETE /api/auth/cli-token',
    'GET /api/a2a/agents/:agentName/.well-known/agent-card.json',
    'GET /oauth/authorize',
    'POST /api/a2a/agents/:agentName',
    'POST /api/auth/cli-verify',
    'POST /api/auth/cli-workspace',
    'POST /api/builder/mcp',
    'POST /api/invitations/:id/accept',
    'POST /api/runs/:id/members/mcp',
    'POST /mcp/builder',
    'POST /mcp/projects/:name',
    'POST /oauth/authorize',
  ];
  expect(identityOnlyRoutes.map(key).sort()).toEqual(expected);
  expect([...IDENTITY_ONLY_ROUTES].sort()).toEqual(expected);
}

function coversFourRolesEveryDeclaredRouteEveryOwnership() {
  // Derived, not transcribed (ADR-0016). The three factors are the two constant lists this
  // program exports and the union read from the tracked tree; none of them is a number typed
  // into this file.
  expect(cells.length).toBe(routes.length * ROLES.length * OWNERSHIPS.length);
  expect(new Set(cells.map((cell) => key(cell.route))).size).toBe(routes.length);
  expect(new Set(cells.map((cell) => cell.role)).size).toBe(ROLES.length);
  expect(new Set(cells.map((cell) => cell.ownership)).size).toBe(OWNERSHIPS.length);
}

function decidesEveryCellRoute21SSplitCannot() {
  expect(
    undecidedCells(cells),
    'Every one of these routes is declared in tests/route-declarations/ and served by the ' +
      'tracked tree, and spec §21’s permission split has no answer for it. Classify its ' +
      'resource in apps/web/server/rbac/core/permissions.ts, citing the sentence of §21 that ' +
      'decides the grants. An undecidable authorisation question is refused, never allowed ' +
      '(ADR-0015, ADR-0031).',
  ).toEqual([]);
}

function givesEveryCellExplanationNamingSentence21Behind() {
  const silent = cells
    .filter((cell) => cell.decision.because.trim() === '')
    .map((cell) => `${key(cell.route)} × ${cell.role} × ${cell.ownership}`);
  expect(silent).toEqual([]);
}
