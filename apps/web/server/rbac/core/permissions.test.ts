/**
 * The §21 permission table, checked against the two documents it claims to come from.
 *
 * Two things are asserted here that no other file asserts:
 *
 *   1. **Every resource spec §34 prints is classified.** The list is read out of `docs/spec.md`
 *      at test time rather than transcribed, so an amendment that adds a resource to §34 fails
 *      this test until somebody decides what each of §21's four roles may do with it. That is the
 *      same rule `tests/route-inventory.policy-check.ts` applies to routes, applied to the permission
 *      table.
 *   2. **Every role's grants come from a sentence of §21**, and that sentence is present in
 *      `docs/spec.md` §21. A citation that cannot be looked up is not a citation.
 */
import { describe, expect, it } from 'vitest';

import {
  PROTOCOL_PREFIXES,
  scanSpecResources,
  specResources,
  specSection,
} from '../permissions.test-support';
import { everyGrant, parseResource, RESOURCES } from './permissions';
import { ROLES } from './roles';

describe('the permission table classifies everything the specification names', () => {
  it('parses spec §34, and finds the resources it prints', () => {
    const { resources, bareMentions } = specResources();
    // Positive assertions that the parse worked, rather than a count that would rot the next time
    // §34 is amended (ADR-0016).
    expect(resources.has('agents')).toBe(true);
    expect(resources.has('users')).toBe(true);
    expect(resources.has('runs')).toBe(true);
    // §34's closing paragraph writes a bare, backticked `/api/` while contrasting it with `/p/`.
    // Asserting that this scan *saw* it is what distinguishes reading the whole section from the
    // round-1 regex, which could not match an occurrence preceded by a backtick at all.
    expect(
      bareMentions,
      'this scan found no bare `/api/` in §34, so either §34 stopped writing one or this scan ' +
        'stopped seeing prose — and in the second case the assertion below is back to being ' +
        'vacuous for anything §34 names in prose.',
    ).toBeGreaterThan(0);
  });

  it('classifies every resource spec §34 prints', () => {
    const unclassified = [...specResources().resources].filter(
      (resource) => parseResource(resource) === null && !PROTOCOL_PREFIXES.has(resource),
    );
    expect(
      unclassified.sort(),
      'spec §34 prints these resources and apps/web/server/rbac/core/permissions.ts does not classify ' +
        'them. Add each to RESOURCES with the grants each of §21’s four roles has over it. An ' +
        'unclassified resource makes every route under it refuse (ADR-0015).',
    ).toEqual([]);
  });

  it('exempts a protocol prefix only while §34 prints it and it is not a resource', () => {
    const { resources } = specResources();
    for (const prefix of PROTOCOL_PREFIXES) {
      expect(resources.has(prefix), `§34 no longer prints /api/${prefix}`).toBe(true);
      expect(parseResource(prefix), `${prefix} is now a resource; drop the exemption`).toBeNull();
    }
  });

  it('classifies the resources Wave 2 and issue #233 add, each mandated by a section that exists', () => {
    // These are not printed by §34, so the assertion above cannot cover them; the sections that
    // mandate them are looked up in docs/spec.md so the citation cannot be invented.
    for (const [resource, heading, name] of [
      ['memberships', /^# 21\. Users and RBAC$/m, '§21'],
      ['api-keys', /^# 22\. API Keys$/m, '§22'],
      ['secrets', /^# 23\. Secrets$/m, '§23'],
      // Issue #233's `GET /api/me`. §21 is what makes the workspace-local identity and its role a
      // thing at all, and it is the section `tests/route-declarations/SDK-01-ME-233.ts` cites.
      ['me', /^# 21\. Users and RBAC$/m, '§21'],
    ] as const) {
      expect(parseResource(resource), `${resource} is unclassified`).not.toBeNull();
      expect(specSection(heading, name).trim().length).toBeGreaterThan(0);
    }
  });
});

describe('the permission table is total and refuses what it does not list', () => {
  it('is total over roles × resources, and every cell names a grant', () => {
    const grants = everyGrant();
    // Derived from the two exported lists, not written down (ADR-0016).
    expect(grants.length).toBe(ROLES.length * RESOURCES.length);
    const legal = new Set(['none', 'own', 'permitted', 'any']);
    const bad = grants
      .filter(
        (cell) =>
          !legal.has(cell.grants.read) ||
          !legal.has(cell.grants.write) ||
          !legal.has(cell.grants.run),
      )
      .map((cell) => `${cell.role} × ${cell.resource}`);
    expect(bad).toEqual([]);
  });

  it('refuses a resource segment that is not in the list', () => {
    for (const value of ['widgets', 'Agents', 'agent', '', 42, null, undefined, ['agents']]) {
      expect(parseResource(value), `accepted ${JSON.stringify(value)}`).toBeNull();
    }
  });
});

/**
 * The verifier's counter-example for the round-1 scan, run against both scans.
 *
 * ADR-0029: the fix is proved by running the reproduction that found the defect, not by asserting
 * that it is fixed. The round-1 regex is written out here verbatim so that the two answers stand
 * side by side in the same test.
 */
describe('the §34 scan decides positively, not from the absence of a match', () => {
  /** The pattern `specResources()` used in round 1, copied from the verifier's finding. */
  const ROUND_1 = /(?:^|\s)\/api\/([a-z0-9]+(?:-[a-z0-9]+)*)/gmu;

  // The verifier's sample named `/api/webhooks`, which issue #250 has since made a real resource;
  // the same sentence about a resource that still does not exist keeps the counter-example.
  const BACKTICKED = 'Workspace doorbells are managed at `/api/doorbells`; see below.\n';
  const PARENTHESISED = 'Model routing uses (/api/model_connections).\n';

  it('finds a resource §34 names in backticks, which the round-1 regex could not match', () => {
    expect([...BACKTICKED.matchAll(ROUND_1)].map((match) => match[1])).toEqual([]);
    const scan = scanSpecResources(BACKTICKED);
    expect([...scan.resources]).toEqual(['doorbells']);
    // And such a resource is now visible to the gate that classifies them.
    expect(parseResource('doorbells')).toBeNull();
  });

  it('refuses an occurrence whose segment it cannot read, rather than skipping it', () => {
    expect([...PARENTHESISED.matchAll(ROUND_1)].map((match) => match[1])).toEqual([]);
    expect(() => scanSpecResources(PARENTHESISED)).toThrow(/model_connections/u);
  });

  it('counts a bare `/api/` as naming no resource, and says so rather than dropping it', () => {
    const scan = scanSpecResources(
      'The public routes live under `/p/` rather than `/api/`.\n#agents\n/api/agents\n',
    );
    expect(scan.bareMentions).toBe(1);
    expect([...scan.resources]).toEqual(['agents']);
  });

  it('fails when the section names no resource at all, rather than returning an empty set', () => {
    expect(() => scanSpecResources('No routes here.\n')).toThrow(/named no \/api\/<resource>/u);
  });
});
