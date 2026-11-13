import { describe, expect, it } from 'vitest';
import { cells, key } from './authorisation-matrix.test-support';
import { ROLES, type Role } from './core/roles';
import { decide, type Decision, type Ownership } from './decide';

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

describe('run-token revocation capability', () => {
  it(
    'matches the handler for Owner, Admin, Builder and Viewer on both route shapes',
    matchesHandlerOwnerAdminBuilderViewerBothRoute,
  );
});

describe('the matrix says what spec §21 says', () => {
  it(
    'gives Owner every declared route — §21: "Everything." — with one named exception',
    givesOwnerEveryDeclaredRoute21EverythingOne,
  );

  it(
    'is not a matrix of yes — some role is refused some declared route',
    isNotMatrixYesSomeRoleIsRefused,
  );

  it(
    'gives Admin the user routes and refuses them to Builder and Viewer — §21’s Admin clause',
    givesAdminUserRoutesRefusesThemBuilderViewer,
  );

  it(
    'lets Admin read another member’s run and its events, and refuses both to Builder and Viewer — §21’s Admin clause read by issue #165',
    letsAdminReadAnotherMemberSRunEvents,
  );

  it(
    'gives Admin the API-key routes — §21 names "API keys" in Admin’s list',
    givesAdminAPIKeyRoutes21NamesAPI,
  );

  it(
    'gives Admin the invitations routes and refuses them to Builder and Viewer — issue #121',
    givesAdminInvitationsRoutesRefusesThemBuilderViewer,
  );

  it(
    'lets a Builder create an agent and edit only its own — §21’s "where permitted"',
    letsBuilderCreateAgentEditOnlyOwn21,
  );

  it(
    'decides the agent-team routes as the agents resource — ADR-0104 acceptance decision 10',
    decidesAgentTeamRoutesAgentsResourceADR0104,
  );

  it(
    'never lets a lower role reach what a higher one is refused (ADR-0152)',
    neverLetsLowerRoleReachWhatHigherOne,
  );

  it(
    'refuses a Viewer an agent it neither owns nor was granted — §21’s "permitted agents"',
    refusesViewerAgentItNeitherOwnsNorWas,
  );

  it(
    'lets Admin manage skills and files like Builder, and refuses Builder and Viewer the routes §21 gives to Admin',
    letsAdminManageSkillsFilesLikeBuilderRefuses,
  );
});

function matchesHandlerOwnerAdminBuilderViewerBothRoute() {
  for (const path of ['/api/runs/run-1', '/api/runs/run-1/revoke-tokens']) {
    for (const role of ROLES) {
      assertRevocationDecision(path, role);
    }
  }
}

function assertRevocationDecision(path: string, role: Role) {
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

function givesOwnerEveryDeclaredRoute21EverythingOne() {
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
}

function isNotMatrixYesSomeRoleIsRefused() {
  // Without this, a table that allowed everything would satisfy every other assertion here.
  expect(cells.some((cell) => cell.decision.effect === 'deny')).toBe(true);
}

function letsAdminManageSkillsFilesLikeBuilderRefuses() {
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
}

function givesAdminUserRoutesRefusesThemBuilderViewer() {
  expect(decisionFor('POST /api/users', 'admin', 'not-applicable').effect).toBe('allow');
  expect(decisionFor('GET /api/users', 'admin', 'not-applicable').effect).toBe('allow');
  expect(decisionFor('POST /api/users', 'builder', 'not-applicable').effect).toBe('deny');
  expect(decisionFor('POST /api/users', 'viewer', 'not-applicable').effect).toBe('deny');
  expect(decisionFor('GET /api/users', 'viewer', 'not-applicable').effect).toBe('deny');
}

function letsAdminReadAnotherMemberSRunEvents() {
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
}

function givesAdminAPIKeyRoutes21NamesAPI() {
  expect(decisionFor('POST /api/api-keys', 'admin', 'not-applicable').effect).toBe('allow');
  expect(decisionFor('DELETE /api/api-keys/:id', 'admin', 'unknown').effect).toBe('allow');
  expect(decisionFor('POST /api/api-keys', 'builder', 'not-applicable').effect).toBe('deny');
  expect(decisionFor('POST /api/api-keys', 'viewer', 'not-applicable').effect).toBe('deny');
}

function givesAdminInvitationsRoutesRefusesThemBuilderViewer() {
  expect(decisionFor('POST /api/invitations', 'admin', 'not-applicable').effect).toBe('allow');
  expect(decisionFor('GET /api/invitations', 'admin', 'not-applicable').effect).toBe('allow');
  expect(decisionFor('POST /api/invitations/:id/resend', 'admin', 'unknown').effect).toBe('allow');
  expect(decisionFor('DELETE /api/invitations/:id', 'admin', 'unknown').effect).toBe('allow');
  expect(decisionFor('POST /api/invitations', 'builder', 'not-applicable').effect).toBe('deny');
  expect(decisionFor('POST /api/invitations', 'viewer', 'not-applicable').effect).toBe('deny');
  expect(decisionFor('GET /api/invitations', 'builder', 'not-applicable').effect).toBe('deny');
  expect(decisionFor('GET /api/invitations', 'viewer', 'not-applicable').effect).toBe('deny');
  // Owner's `EVERYTHING` fallback covers a resource nobody overrode for it, `invitations` included.
  expect(decisionFor('POST /api/invitations', 'owner', 'not-applicable').effect).toBe('allow');
}

function letsBuilderCreateAgentEditOnlyOwn21() {
  expect(decisionFor('POST /api/agents', 'builder', 'not-applicable').effect).toBe('allow');
  expect(decisionFor('PATCH /api/agents/:id', 'builder', 'own').effect).toBe('allow');
  expect(decisionFor('PATCH /api/agents/:id', 'builder', 'other').effect).toBe('deny');
  // The honest answer from a handler that has not read the row denies. ADR-0031.
  expect(decisionFor('PATCH /api/agents/:id', 'builder', 'unknown').effect).toBe('deny');
}

function decidesAgentTeamRoutesAgentsResourceADR0104() {
  const teamRoutes = [
    ['GET /api/agent-teams', 'read'],
    ['POST /api/agent-teams', 'write'],
    ['GET /api/agent-teams/:id', 'read'],
    ['DELETE /api/agent-teams/:id', 'write'],
    ['POST /api/agent-teams/:id/versions', 'write'],
    ['GET /api/agent-teams/:id/versions', 'read'],
    // Issue #1517: running a team is the `run` verb on its lead agent (decision 10).
    ['POST /api/agent-teams/:id/runs', 'run'],
  ] as const;
  for (const [routeKey, operation] of teamRoutes) {
    const ownership: Ownership = routeKey.includes(':id') ? 'own' : 'not-applicable';
    for (const role of ROLES) {
      const decision = decisionFor(routeKey, role, ownership);
      expect(decision.effect, `${routeKey} × ${role}`).not.toBe('refuse');
      expect('facts' in decision ? decision.facts : null, `${routeKey} × ${role}`).toMatchObject({
        resource: 'agents',
        operation,
      });
      // The same answer as the agent route of the same shape and verb.
      const agentKey = routeKey.replace('/api/agent-teams', '/api/agents');
      const agentRoute = agentKey === 'DELETE /api/agents/:id' ? 'PATCH /api/agents/:id' : agentKey;
      expect(decision.effect, `${routeKey} × ${role}`).toBe(
        decisionFor(agentRoute, role, ownership).effect,
      );
    }
  }
  // Every role reads; a Builder writes only its own teams; a Viewer writes none.
  expect(decisionFor('GET /api/agent-teams', 'viewer', 'not-applicable').effect).toBe('allow');
  expect(decisionFor('POST /api/agent-teams', 'viewer', 'not-applicable').effect).toBe('deny');
  expect(decisionFor('DELETE /api/agent-teams/:id', 'builder', 'own').effect).toBe('allow');
  expect(decisionFor('DELETE /api/agent-teams/:id', 'builder', 'other').effect).toBe('deny');
  expect(decisionFor('DELETE /api/agent-teams/:id', 'admin', 'other').effect).toBe('allow');
  expect(decisionFor('POST /api/agent-teams/:id/versions', 'builder', 'other').effect).toBe('deny');
}

function neverLetsLowerRoleReachWhatHigherOne() {
  // A Builder named by an `agent_grants` row runs that agent, as a Viewer with the same row does;
  // a Builder runs its own; neither runs an agent it neither owns nor was granted.
  for (const role of ['builder', 'viewer'] as const) {
    expect(decisionFor('POST /api/agents/:id/runs', role, 'permitted').effect, role).toBe('allow');
    expect(decisionFor('POST /api/agents/:id/runs', role, 'own').effect, role).toBe('allow');
    expect(decisionFor('POST /api/agents/:id/runs', role, 'other').effect, role).toBe('deny');
    expect(decisionFor('POST /api/agents/:id/runs', role, 'unknown').effect, role).toBe('deny');
  }
  // An Admin reads and edits every project, as a Builder does its own.
  expect(decisionFor('GET /api/projects/:id', 'builder', 'own').effect).toBe('allow');
  expect(decisionFor('GET /api/projects/:id', 'admin', 'other').effect).toBe('allow');
  expect(decisionFor('PATCH /api/projects/:id', 'admin', 'other').effect).toBe('allow');
  expect(decisionFor('POST /api/projects', 'admin', 'not-applicable').effect).toBe('allow');
}

function refusesViewerAgentItNeitherOwnsNorWas() {
  const run = decisionFor('POST /api/agents/:id/runs', 'viewer', 'other');
  expect(run.effect).toBe('deny');
  expect(run.because).toContain('permitted');
  // …and a Viewer can still see the agent list, which is what makes §21's Viewer clause a
  // sentence about something at all.
  expect(decisionFor('GET /api/agents', 'viewer', 'not-applicable').effect).toBe('allow');
}
