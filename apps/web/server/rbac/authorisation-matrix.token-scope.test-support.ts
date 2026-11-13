import { describe, expect, it } from 'vitest';
import { matrix, routes } from './authorisation-matrix.test-support';
import { decide } from './decide';

const OWNER_ARGS = { role: 'owner' as const, ownership: 'own' as const };

describe('a browser token’s scope narrows decide(), before §21’s table is even consulted', () => {
  it(
    'a run scope reads its own run and its events, and nothing else',
    runScopeReadsOwnRunEventsNothingElse,
  );

  it(
    'a session scope starts runs and reads runs, with no id check at decide()’s layer',
    sessionScopeStartsRunsReadsRunsNoId,
  );

  it(
    'a session scope rates a run (issue #539) but still reaches no other run verb',
    sessionScopeRatesRunIssue539ButStill,
  );

  it(
    'deciding a paused run (issue #1301) is the run verb on own runs, and no token scope reaches it',
    decidingPausedRunIssue1301IsRunVerb,
  );

  it(
    'a scope only narrows: the ordinary role/ownership check still applies inside the grammar',
    scopeOnlyNarrowsOrdinaryRoleOwnershipCheckStill,
  );

  it(
    'scope: null is every existing call site, and changes no decision the matrix above covers',
    scopeNullIsEveryExistingCallSiteChanges,
  );
});

function scopeOnlyNarrowsOrdinaryRoleOwnershipCheckStill() {
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
}

function scopeNullIsEveryExistingCallSiteChanges() {
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
}

function runScopeReadsOwnRunEventsNothingElse() {
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
}

function sessionScopeStartsRunsReadsRunsNoId() {
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
}

function sessionScopeRatesRunIssue539ButStill() {
  const scope = { kind: 'session' as const, id: 'session-1' };
  expect(routes.some((r) => r.method === 'POST' && r.path === '/api/runs/:id/feedback')).toBe(true);
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
}

function decidingPausedRunIssue1301IsRunVerb() {
  expect(routes.some((r) => r.method === 'POST' && r.path === '/api/runs/:id/approval')).toBe(true);
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
}
