/**
 * Differential conformance for the authorisation decision function: the Lean model of `decide()`
 * (formal/AgentWorkspace/Authz/{Surface,Roles,Resources,Permissions,TokenScope,Decide}.lean),
 * replayed against the real `decide()`, `classifyPath`, `grantsFor`, `parseRole` and the lists the
 * RBAC modules export. The route vectors are also compared with the live route declarations in both
 * directions, the way `apps/web/server/rbac/authorisation-matrix.test.ts` reads them.
 */
import { isDeepStrictEqual } from 'node:util';

import { describe, expect, it } from 'vitest';

import { classifyPath } from '../server/auth/paths';
import {
  decide,
  METHODS,
  OWNERSHIPS,
  TOKEN_SCOPE_KINDS,
  type Decision,
  type Ownership,
  type TokenScope,
} from '../server/rbac/decide';
import { grantsFor, RESOURCES, SUB_RESOURCES, type Resource } from '../server/rbac/permissions';
import { parseRole, ROLES, type Role } from '../server/rbac/roles';
import { readDeclarationFiles, requireString } from '../../../tests/inventory-support';
import { asRecord, asString, loadVectors, type FormalVector } from '../../../tests/formal/vectors';

const FAMILY = 'authz-decide';

function asStringArray(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || !value.every((v): v is string => typeof v === 'string')) {
    throw new Error(`${what}: ${JSON.stringify(value)} is not a string array`);
  }
  return value;
}

function asNullableString(value: unknown, what: string): string | null {
  if (value === null) return null;
  return asString(value, what);
}

function asScope(value: unknown, what: string): TokenScope | null {
  if (value === null) return null;
  const record = asRecord(value, what);
  const kind = TOKEN_SCOPE_KINDS.find((k) => k === record['kind']);
  if (kind === undefined) throw new Error(`${what}: unknown scope kind ${String(record['kind'])}`);
  return { kind, id: asString(record['id'], `${what}.id`) };
}

function asResource(value: unknown, what: string): Resource {
  const resource = RESOURCES.find((r) => r === value);
  if (resource === undefined)
    throw new Error(`${what}: ${JSON.stringify(value)} is not a resource`);
  return resource;
}

function asRole(value: unknown, what: string): Role {
  const role = parseRole(value);
  if (role === null) throw new Error(`${what}: ${JSON.stringify(value)} is not a role`);
  return role;
}

/**
 * The role as `decide()` receives it at run time. A vector may carry a string that is not one of
 * the four roles — that is the point of those vectors — and a type annotation is no evidence
 * about a value that arrived from a database row, which is why `decide()` re-parses it.
 */
function runtimeRole(value: string): Role {
  return value as Role;
}

/** The facts a decision carries, as the vectors spell them. */
function factsOf(decision: Decision): unknown {
  if (decision.effect === 'refuse' || decision.facts === null) return null;
  const { resource, operation, grant } = decision.facts;
  return { resource, operation, grant };
}

/**
 * Compare `decide()` for every ownership answer with a vector's `outcomes`: the effect per
 * ownership, and the facts, code and reason keyword shared by all five.
 */
function outcomeMismatches(
  id: string,
  outcomes: Record<string, unknown>,
  query: { role: string; method: string; path: string; scope: TokenScope | null },
): string[] {
  const effects = asRecord(outcomes['effects'], `${id} effects`);
  const expectedFacts = outcomes['facts'];
  const expectedCode = asNullableString(outcomes['code'], `${id} code`);
  const expectedBecause = asNullableString(outcomes['because'], `${id} because`);
  const mismatches: string[] = [];
  for (const ownership of OWNERSHIPS) {
    const decision = decide({ ...query, role: runtimeRole(query.role), ownership });
    const where = `${id} × ${ownership}`;
    if (decision.effect !== effects[ownership]) {
      mismatches.push(`${where}: effect ${decision.effect}, model ${String(effects[ownership])}`);
    }
    const facts = factsOf(decision);
    if (!isDeepStrictEqual(facts, expectedFacts)) {
      mismatches.push(
        `${where}: facts ${JSON.stringify(facts)}, model ${JSON.stringify(expectedFacts)}`,
      );
    }
    const code = decision.effect === 'deny' ? (decision.code ?? null) : null;
    if (code !== expectedCode)
      mismatches.push(`${where}: code ${String(code)}, model ${String(expectedCode)}`);
    if (expectedBecause !== null && !decision.because.includes(expectedBecause)) {
      mismatches.push(`${where}: because "${decision.because}" lacks "${expectedBecause}"`);
    }
  }
  return mismatches;
}

function decideVectorMismatches(vector: FormalVector): string[] {
  const input = asRecord(vector.input, vector.id);
  const expected = asRecord(vector.expected, vector.id);
  return outcomeMismatches(vector.id, asRecord(expected['outcomes'], `${vector.id} outcomes`), {
    role: asString(input['role'], `${vector.id} role`),
    method: asString(input['method'], `${vector.id} method`),
    path: asString(input['path'], `${vector.id} path`),
    scope: asScope(input['scope'], `${vector.id} scope`),
  });
}

/** Every declared route, read the way the authorisation matrix reads them. */
function declaredRouteKeys(): string[] {
  return readDeclarationFiles('tests/route-declarations', 'routes').flatMap((file) =>
    file.entries.map((entry, index) => {
      const where = `${file.repoPath} entry ${String(index)}`;
      return `${requireString(entry, 'method', where)} ${requireString(entry, 'path', where)}`;
    }),
  );
}

describe('the model’s vocabularies are the exported lists', () => {
  const vectors = loadVectors(FAMILY, 'enumerations.json');
  const members = (id: string): unknown => {
    const vector = vectors.find((v) => v.id === id);
    if (vector === undefined) throw new Error(`no vector ${id}`);
    return asRecord(vector.expected, id)['members'];
  };

  it('RESOURCES, ROLES, OWNERSHIPS, METHODS and TOKEN_SCOPE_KINDS match in order', () => {
    expect(members('enum/resources')).toEqual([...RESOURCES]);
    expect(members('enum/roles')).toEqual([...ROLES]);
    expect(members('enum/ownerships')).toEqual([...OWNERSHIPS]);
    expect(members('enum/methods')).toEqual([...METHODS]);
    expect(members('enum/token-scope-kinds')).toEqual([...TOKEN_SCOPE_KINDS]);
  });

  it('SUB_RESOURCES is the model’s composition of §34 and the declarations', () => {
    const vector = vectors.find((v) => v.id === 'enum/sub-resources');
    if (vector === undefined) throw new Error('no sub-resources vector');
    const expected = asRecord(vector.expected, vector.id);
    for (const resource of RESOURCES) {
      expect([...SUB_RESOURCES[resource]], resource).toEqual(expected[resource]);
    }
    expect(Object.keys(expected).sort()).toEqual([...RESOURCES].sort());
  });
});

describe('POLICY, cell by cell', () => {
  const vectors = loadVectors(FAMILY, 'policy.json');

  it('covers every role × resource once', () => {
    expect(vectors.length).toBe(ROLES.length * RESOURCES.length);
  });

  it('grantsFor returns the model’s grants for every cell', () => {
    const mismatches = vectors.flatMap((vector) => {
      const input = asRecord(vector.input, vector.id);
      const actual = grantsFor(
        asRole(input['role'], vector.id),
        asResource(input['resource'], vector.id),
      );
      return isDeepStrictEqual(
        { read: actual.read, write: actual.write, run: actual.run },
        vector.expected,
      )
        ? []
        : [`${vector.id}: ${JSON.stringify(actual)} vs ${JSON.stringify(vector.expected)}`];
    });
    expect(mismatches).toEqual([]);
  });
});

describe.each([
  'decide-shapes.json',
  'decide-routes.json',
  'scope.json',
  'path-grammar.json',
  'methods.json',
  'apply-grant.json',
  'divergences.json',
])('decide() agrees with the model on %s', (file) => {
  const vectors = loadVectors(FAMILY, file);

  it(`every vector (${String(vectors.length)}) × every ownership answer`, () => {
    const mismatches = vectors.flatMap((vector) => {
      if (file === 'apply-grant.json') {
        const input = asRecord(vector.input, vector.id);
        const expected = asRecord(vector.expected, vector.id);
        return outcomeMismatches(vector.id, asRecord(expected['outcomes'], vector.id), {
          role: asString(input['role'], vector.id),
          method: asString(input['method'], vector.id),
          path: asString(input['path'], vector.id),
          scope: null,
        });
      }
      return decideVectorMismatches(vector);
    });
    expect(mismatches).toEqual([]);
  });
});

describe('the exhaustive shape vectors cover the whole classified grammar', () => {
  const vectors = loadVectors(FAMILY, 'decide-shapes.json');

  it('every role × every accepted path shape × every method and TRACE', () => {
    const subPairs = RESOURCES.flatMap((r) => SUB_RESOURCES[r].map((s) => `${r}/${s}`));
    const shapes = RESOURCES.length * 2 + subPairs.length;
    expect(subPairs.length).toBe(33);
    expect(vectors.length).toBe(ROLES.length * shapes * (METHODS.length + 1));
    for (const resource of RESOURCES) {
      for (const sub of SUB_RESOURCES[resource]) {
        expect(
          vectors.some((v) => asRecord(v.input, v.id)['path'] === `/api/${resource}/row-a/${sub}`),
          `${resource}/${sub}`,
        ).toBe(true);
      }
    }
  });
});

describe('the declared routes, both ways', () => {
  const routeVectors = loadVectors(FAMILY, 'decide-routes.json');
  const [routeSet] = loadVectors(FAMILY, 'route-set.json');
  if (routeSet === undefined) throw new Error('route-set.json has no vector');
  const expected = asRecord(routeSet.expected, routeSet.id);
  const live = declaredRouteKeys();

  it('the model’s route union is exactly the tracked declarations', () => {
    const modelled = asStringArray(expected['routes'], 'routes');
    expect([...modelled].sort()).toEqual([...live].sort());
    expect(new Set(live).size).toBe(live.length);
    expect(expected['count']).toBe(live.length);
  });

  it('the route vectors are every declared route × every role', () => {
    const keys = routeVectors.map((v) => {
      const input = asRecord(v.input, v.id);
      return `${asString(input['role'], v.id)} ${asString(input['method'], v.id)} ${asString(input['path'], v.id)}`;
    });
    const wanted = live.flatMap((route) => ROLES.map((role) => `${role} ${route}`));
    expect([...keys].sort()).toEqual([...wanted].sort());
  });

  it('the refused routes and the exempt routes agree with the matrix test', () => {
    const refused = live.filter((route) => {
      const [method = '', path = ''] = route.split(' ');
      return (
        decide({ role: 'owner', method, path, ownership: 'own', scope: null }).effect === 'refuse'
      );
    });
    expect(refused).toEqual(asStringArray(expected['refused'], 'refused'));
    const exempt = [
      ...asStringArray(expected['matrixPublic'], 'matrixPublic'),
      ...asStringArray(expected['matrixIdentityOnly'], 'matrixIdentityOnly'),
    ];
    for (const route of exempt) expect(live, route).toContain(route);
    expect(live.length - exempt.length).toBe(expected['matrixCount']);
    // Every refused route is exempt by name, so the matrix's "no refuse" gate holds on the rest.
    for (const route of refused) expect(exempt, route).toContain(route);
  });

  it('the classified sub-resources with no declared route are the model’s', () => {
    const usedSubs = new Set(
      live.flatMap((route) => {
        const segments = (route.split(' ')[1] ?? '').split('/');
        return segments.length === 5 ? [`${segments[2] ?? ''}/${segments[4] ?? ''}`] : [];
      }),
    );
    const unrouted = RESOURCES.flatMap((resource) =>
      SUB_RESOURCES[resource].map((sub) => `${resource}/${sub}`),
    ).filter((pair) => !usedSubs.has(pair));
    expect(unrouted).toEqual(asStringArray(expected['classifiedSubsWithoutRoute'], 'unrouted'));
  });
});

describe('roles', () => {
  const vectors = loadVectors(FAMILY, 'roles.json');

  it('parseRole and decide() refuse exactly the spellings the model refuses', () => {
    const mismatches = vectors.flatMap((vector) => {
      const role = asString(asRecord(vector.input, vector.id)['role'], vector.id);
      const expected = asRecord(vector.expected, vector.id);
      const parsed = parseRole(role);
      const out = outcomeMismatches(vector.id, asRecord(expected['outcomes'], vector.id), {
        role,
        method: 'GET',
        path: '/api/users',
        scope: null,
      });
      return parsed === expected['parsed']
        ? out
        : [...out, `${vector.id}: parseRole ${String(parsed)}`];
    });
    expect(mismatches).toEqual([]);
  });
});

describe('classifyPath', () => {
  const vectors = loadVectors(FAMILY, 'classify-path.json');

  it('returns the model’s surface for every pathname', () => {
    const mismatches = vectors.flatMap((vector) => {
      const path = asString(asRecord(vector.input, vector.id)['path'], vector.id);
      const expected = asRecord(vector.expected, vector.id)['surface'];
      const actual = classifyPath(path).surface;
      return actual === expected ? [] : [`${vector.id}: ${actual} vs ${String(expected)}`];
    });
    expect(mismatches).toEqual([]);
  });
});

describe('applyGrant', () => {
  const vectors = loadVectors(FAMILY, 'apply-grant.json');

  it('the probe for each grant allows exactly the ownership answers the model’s table admits', () => {
    const mismatches = vectors.flatMap((vector) => {
      const expected = asRecord(vector.expected, vector.id);
      const allowed = asRecord(expected['allowed'], vector.id);
      const effects = asRecord(asRecord(expected['outcomes'], vector.id)['effects'], vector.id);
      return OWNERSHIPS.flatMap((ownership: Ownership) =>
        (effects[ownership] === 'allow') === allowed[ownership]
          ? []
          : [`${vector.id} × ${ownership}: allowed ${String(allowed[ownership])}`],
      );
    });
    expect(mismatches).toEqual([]);
  });
});
