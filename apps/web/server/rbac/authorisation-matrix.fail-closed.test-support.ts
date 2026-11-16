import { describe, expect, it } from 'vitest';
import {
  cells,
  type DeclaredRoute,
  matrix,
  routes,
  undecidedCells,
} from './authorisation-matrix.test-support';
import { ROLES, type Role } from './core/roles';
import { decide, OWNERSHIPS } from './decide';

const synthetic = (method: string, path: string): DeclaredRoute => ({
  method,
  path,
  owner: 'W2-XX-99',
  where: 'a synthetic declaration built inside this test',
});

describe('the matrix fails closed — the counter-examples, run', () => {
  /**
   * ADR-0029: a finding about a gate is only a defect when a tree the gate ought to reject is
   * built and the gate accepts it. These are that tree — synthetic declarations handed to the same
   * `matrix` and `undecidedCells` the live gate uses, so what is proved is the gate's own
   * behaviour and not a paraphrase of it. Nothing is written into the repository to build them.
   */

  it(
    'refuses a route whose resource §21’s split does not classify',
    refusesRouteWhoseResource21SSplitDoes,
  );

  it('refuses a method it has never classified', refusesMethodItHasNeverClassified);

  it(
    'refuses a path deeper than the shape spec §34 admits',
    refusesPathDeeperThanShapeSpec34Admits,
  );

  it(
    'refuses a role that is not one of §21’s four, rather than treating it as the least one',
    refusesRoleThatIsNotOne21S,
  );

  it(
    'refuses a page path, and allows spec §34’s public surface to every role',
    refusesPagePathAllowsSpec34SPublic,
  );

  it(
    'refuses an unclassified SUB-resource, rather than giving it the parent’s grant',
    refusesUnclassifiedSUBResourceRatherThanGivingIt,
  );

  it(
    'would have caught an unclassified resource among the real declarations',
    wouldHaveCaughtUnclassifiedResourceAmongRealDeclarations,
  );
});

function refusesRoleThatIsNotOne21S() {
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
}

function refusesPagePathAllowsSpec34SPublic() {
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
}

function refusesRouteWhoseResource21SSplitDoes() {
  const faults = undecidedCells(matrix([synthetic('GET', '/api/widgets')]));
  expect(faults.length).toBe(ROLES.length * OWNERSHIPS.length);
  expect(faults[0]).toContain('"widgets" is not a resource');
  expect(faults[0]).toContain('W2-XX-99');
}

function refusesMethodItHasNeverClassified() {
  expect(undecidedCells(matrix([synthetic('OPTIONS', '/api/users')])).length).toBe(
    ROLES.length * OWNERSHIPS.length,
  );
  expect(undecidedCells(matrix([synthetic('TRACE', '/api/users')])).length).toBe(
    ROLES.length * OWNERSHIPS.length,
  );
}

function refusesPathDeeperThanShapeSpec34Admits() {
  const faults = undecidedCells(matrix([synthetic('GET', '/api/agents/:id/runs/:runId/events')]));
  expect(faults.length).toBe(ROLES.length * OWNERSHIPS.length);
  expect(faults[0]).toContain('deeper than');
}

function refusesUnclassifiedSUBResourceRatherThanGivingIt() {
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
}

function wouldHaveCaughtUnclassifiedResourceAmongRealDeclarations() {
  // The live union with one synthetic entry appended: the gate must go from clean to failing,
  // which is the property "this test can fail" rather than the property "this test passes".
  expect(undecidedCells(cells)).toEqual([]);
  const faults = undecidedCells(matrix([...routes, synthetic('POST', '/api/widgets')]));
  expect(faults.length).toBeGreaterThan(0);
  expect(faults.every((fault) => fault.includes('/api/widgets'))).toBe(true);
}
