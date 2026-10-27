/**
 * Property tests for {@link decide} (F-21 property 4): a higher role never loses access a lower one
 * has, and a token scope only ever narrows what its role may do. `authorisation-matrix.test.ts`
 * enumerates the declared routes; these quantify over every path shape the table classifies,
 * including undeclared sub-resources and ids. On a failure fast-check prints the seed and path.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { dominates } from './conferral';
import { decide, METHODS, OWNERSHIPS, TOKEN_SCOPE_KINDS, ENDPOINT_SCOPE_KINDS } from './decide';
import { grantsFor, RESOURCES, SUB_RESOURCES } from './permissions';
import { ROLES } from './roles';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

const id = fc.oneof(fc.constant(ID), fc.uuid(), fc.string({ minLength: 1, maxLength: 8 }));

/** `/api/<resource>[/:id[/<sub>]]`, with classified and unclassified sub-resources. */
const path = fc
  .oneof(
    { weight: 9, arbitrary: fc.constantFrom(...RESOURCES) }, // weight keeps API paths dominant
    { weight: 1, arbitrary: fc.constantFrom('p/share', 'settings', 'unknown') },
  )
  .chain((head) => {
    const subs = (RESOURCES as readonly string[]).includes(head)
      ? (SUB_RESOURCES[head as (typeof RESOURCES)[number]] ?? [])
      : [];
    const sub = fc.oneof(fc.constantFrom('runs', 'nope', ...subs), fc.string({ maxLength: 6 }));
    const prefix = (RESOURCES as readonly string[]).includes(head) ? `/api/${head}` : `/${head}`;
    return fc.oneof(
      fc.constant(prefix),
      id.map((value) => `${prefix}/${value}`),
      fc.tuple(id, sub).map(([value, part]) => `${prefix}/${value}/${part}`),
    );
  });

const scope = fc.record({
  kind: fc.constantFrom(...TOKEN_SCOPE_KINDS, ...ENDPOINT_SCOPE_KINDS),
  id: fc.oneof(fc.constant(ID), fc.uuid()),
});

const query = fc.record({
  method: fc.constantFrom(...METHODS),
  path,
  ownership: fc.constantFrom(...OWNERSHIPS),
  scope: fc.option(scope, { nil: null }),
});

/** `ROLES` is ordered most- to least-privileged; a pair is (higher, lower). */
const rolePair = fc
  .tuple(fc.nat(ROLES.length - 1), fc.nat(ROLES.length - 1))
  .filter(([a, b]) => a < b)
  .map(([a, b]) => [ROLES[a] ?? 'owner', ROLES[b] ?? 'viewer'] as const);

const RUNS = { numRuns: 2_000 };

function inversion(resource: string, operation: string, higher: string, lower: string): string {
  const grant = (role: (typeof ROLES)[number]): string =>
    grantsFor(role, resource as (typeof RESOURCES)[number])[operation as 'read' | 'write' | 'run'];
  return `${resource}.${operation}: ${higher}=${grant(higher as (typeof ROLES)[number])} < ${lower}=${grant(lower as (typeof ROLES)[number])}`;
}

describe('decide (property)', () => {
  it('never turns allow into deny when the role is raised', () => {
    fc.assert(
      fc.property(rolePair, query, ([higher, lower], q) => {
        const allowed = decide({ ...q, role: lower });
        if (allowed.effect !== 'allow') return;
        expect(decide({ ...q, role: higher })).toMatchObject({ effect: 'allow' });
      }),
      RUNS,
    );
  });

  it('lets a token scope only restrict: allowed with a scope implies allowed without one', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ROLES), query, scope, (role, q, s) => {
        if (decide({ ...q, role, scope: s }).effect !== 'allow') return;
        expect(decide({ ...q, role, scope: null })).toMatchObject({ effect: 'allow' });
      }),
      RUNS,
    );
  });
});

describe('role inversions in the grant table', () => {
  // ADR-0152: roles are monotonic under the formal `Grant.le` (`dominates`). Checked cell by
  // cell over the whole table, so an inversion in a cell the property's random paths rarely reach
  // still fails here, by name.
  it('do not exist: a higher role holds every grant a lower role holds', () => {
    const found: string[] = [];
    for (const resource of RESOURCES) {
      ROLES.forEach((higher, index) => {
        for (const lower of ROLES.slice(index + 1)) {
          for (const operation of ['read', 'write', 'run'] as const) {
            if (
              dominates(
                grantsFor(higher, resource)[operation],
                grantsFor(lower, resource)[operation],
              ) !== 'dominates'
            ) {
              found.push(inversion(resource, operation, higher, lower));
            }
          }
        }
      });
    }
    expect(found).toEqual([]);
  });
});
