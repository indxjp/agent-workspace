/**
 * The §21 permission table, checked against the two documents it claims to come from.
 *
 * Two things are asserted here that no other file asserts:
 *
 *   1. **Every resource spec §34 prints is classified.** The list is read out of `docs/spec.md`
 *      at test time rather than transcribed, so an amendment that adds a resource to §34 fails
 *      this test until somebody decides what each of §21's four roles may do with it. That is the
 *      same rule `tests/route-inventory.test.ts` applies to routes, applied to the permission
 *      table.
 *   2. **Every role's grants come from a sentence of §21**, and that sentence is present in
 *      `docs/spec.md` §21. A citation that cannot be looked up is not a citation.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../../../../tests/inventory-support';

import {
  everyGrant,
  grantsFor,
  parseResource,
  policyBecause,
  RESOURCES,
  type Resource,
} from './permissions';
import { ROLES } from './roles';

const SPEC = readFileSync(path.join(REPO_ROOT, 'docs/spec.md'), 'utf8');

/** One section of `docs/spec.md`, from its heading to the next top-level heading. */
function specSection(heading: RegExp, name: string): string {
  const match = heading.exec(SPEC);
  if (match === null) {
    throw new Error(
      `docs/spec.md has no ${name} heading, so this test cannot check the permission table ` +
        `against it and refuses to pass instead.`,
    );
  }
  const rest = SPEC.slice(match.index + match[0].length);
  const next = /^# /m.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
}

/**
 * What one scan of §34 found: the resource segments it names, and the times it wrote the bare
 * prefix `/api/` while naming no resource at all.
 *
 * The second number exists so that "§34 mentioned the prefix without naming a resource" is a fact
 * this parser *states*, rather than an occurrence it silently dropped.
 */
interface SpecResourceScan {
  readonly resources: ReadonlySet<string>;
  readonly bareMentions: number;
}

/** The literal this scan looks for. There is no context condition around it, deliberately. */
const API_PREFIX = '/api/';

/**
 * The characters that end a path segment in §34 — in its route table and in its prose alike.
 *
 * Closed, and checked positively: a character that is not in this set does not end a segment, and
 * an occurrence that ends on one is not a resource this parser can name, so it refuses rather
 * than recording the prefix it managed to read.
 */
const SEGMENT_TERMINATORS = new Set([
  ' ',
  '\t',
  '\n',
  '\r',
  '`',
  '/',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '<',
  '>',
  ',',
  ';',
  ':',
  '.',
  '!',
  '?',
  '"',
  "'",
  '|',
  '*',
  '#',
]);

/**
 * `/api/<segment>` prefixes §34 prints that are a protocol's name, not a resource. A2A v0.3 fixes
 * where a client finds an agent and its card, so `/api/a2a/…` is a literal pair of routes
 * (ADR-0135) that authorise as `POST /api/agents/:id/runs`; `tests/route-inventory.test.ts` names
 * the same exception. The tests below require each prefix to be printed and to stay out of
 * `RESOURCES`, so this list can neither go stale nor hide a real resource.
 */
const PROTOCOL_PREFIXES: ReadonlySet<string> = new Set(['a2a']);

const SEGMENT_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * Every resource segment spec §34 names, decided positively.
 *
 * Round 1 asked this question with `/(?:^|\s)\/api\/([a-z0-9]+(?:-[a-z0-9]+)*)/`, which requires
 * whitespace or a line start immediately before `/api/`. §34 writes prose in backticks, and the
 * section's own last paragraph contains a backticked `` `/api/` ``, so a resource §34 named that
 * way contributed nothing and `classifies every resource spec §34 prints` passed with nothing to
 * check. The verifier's counter-example is re-run below, in the describe block "the §34 scan
 * decides positively, not from the absence of a match", against both scans; it read:
 *
 * ```text
 * $ node -e "const re = /(?:^|\s)\/api\/([a-z0-9]+(?:-[a-z0-9]+)*)/gmu; …"
 * matches: []
 * ```
 *
 * for a sample containing `` `/api/webhooks` `` and `(/api/model_connections)`. That is the
 * ADR-0015 fail-open exactly: the conclusion *"§34 names no further resource"* was drawn from the
 * ABSENCE of a match, and `found.size === 0` only caught a total parse failure, never a partial
 * one.
 *
 * It is now drawn from a positive parse. Every occurrence of the literal `/api/` is found by
 * index — a scan nothing can hide from, because there is no context condition to satisfy — and
 * each occurrence is then classified, with a refusing `else`:
 *
 *   1. segment characters follow and stop on a {@link SEGMENT_TERMINATORS} character → a resource
 *      segment, recorded;
 *   2. a terminator follows immediately → the bare prefix, naming no resource. §34's closing
 *      paragraph writes exactly this. Counted, not dropped;
 *   3. anything else — `(/api/model_connections)` is the verifier's own example — → this parser
 *      cannot say which resource the text names, and it **throws**. A check that cannot run
 *      fails (ADR-0015); it does not skip the occurrence and carry on.
 *
 * ## Why this is not `parseSpecRoutes` from `tests/route-inventory.test.ts`
 *
 * That function answers a narrower question — the whole routes printed inside §34's ```text
 * fences — and reusing it would not have fixed this fail-open, because a resource named only in
 * §34's prose is outside every fence and it would not see one either. Importing it is separately
 * impossible: it is exported from a `.test.ts`, so importing it would collect and run that file's
 * suite a second time inside this one.
 */
function scanSpecResources(section: string): SpecResourceScan {
  const resources = new Set<string>();
  let bareMentions = 0;
  for (
    let at = section.indexOf(API_PREFIX);
    at !== -1;
    at = section.indexOf(API_PREFIX, at + API_PREFIX.length)
  ) {
    const from = at + API_PREFIX.length;
    let end = from;
    while (end < section.length && !SEGMENT_TERMINATORS.has(section[end] ?? '')) end += 1;
    const segment = section.slice(from, end);
    const context = JSON.stringify(section.slice(Math.max(0, at - 30), end + 10));
    if (segment === '') {
      bareMentions += 1;
      continue;
    }
    if (!SEGMENT_SHAPE.test(segment)) {
      throw new Error(
        `spec §34 writes ${API_PREFIX}${segment} at ${context}, and ${JSON.stringify(segment)} ` +
          `is not the shape of a resource segment this parser can read ` +
          `(${String(SEGMENT_SHAPE)}). It is not skipped: a resource segment nobody can parse ` +
          `is one nobody can check against the permission table, so this check fails rather ` +
          `than passing with one fewer thing to check (ADR-0015).`,
      );
    }
    resources.add(segment);
  }
  if (resources.size === 0) {
    throw new Error(
      'spec §34 was found but named no /api/<resource>, so this parse produced nothing and ' +
        'every assertion built on it would pass by having nothing to check.',
    );
  }
  return { resources, bareMentions };
}

/** {@link scanSpecResources} over the real §34. */
function specResources(): SpecResourceScan {
  return scanSpecResources(specSection(/^# 34\. API Design$/m, '"# 34. API Design"'));
}

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
      'spec §34 prints these resources and apps/web/server/rbac/permissions.ts does not classify ' +
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

  const BACKTICKED = 'Workspace webhooks are managed at `/api/webhooks`; see below.\n';
  const PARENTHESISED = 'Model routing uses (/api/model_connections).\n';

  it('finds a resource §34 names in backticks, which the round-1 regex could not match', () => {
    expect([...BACKTICKED.matchAll(ROUND_1)].map((match) => match[1])).toEqual([]);
    const scan = scanSpecResources(BACKTICKED);
    expect([...scan.resources]).toEqual(['webhooks']);
    // And such a resource is now visible to the gate that classifies them.
    expect(parseResource('webhooks')).toBeNull();
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

describe('the grants are the ones §21’s sentences require', () => {
  it('quotes a sentence of §21 for each role, and that sentence is in docs/spec.md §21', () => {
    const section = specSection(/^# 21\. Users and RBAC$/m, '§21');
    for (const role of ROLES) {
      const because = policyBecause(role);
      expect(because.length, `${role} has no citation`).toBeGreaterThan(0);
      // The quoted fragment is looked up in the section, so a paraphrase drifting away from the
      // specification fails here rather than living on as prose.
      const quoted = /"([^"]+)"/u.exec(because)?.[1];
      // No sentinel fallback. A citation that quotes nothing leaves this check with nothing to
      // look up, and a check that cannot run fails rather than comparing against a placeholder
      // (ADR-0015). The sentinel it replaced was written as a literal U+0000 byte in this source
      // file, which also made git classify the file as binary and hid every line of it from the
      // diff a reviewer reads.
      if (quoted === undefined) {
        throw new Error(
          `${role}'s citation ${JSON.stringify(because)} quotes no fragment of §21, so there is ` +
            `nothing to look up in docs/spec.md and this assertion cannot be made.`,
        );
      }
      expect(section.includes(quoted), `§21 does not contain: ${quoted}`).toBe(true);
    }
  });

  it('gives Owner every operation on every resource — §21: "Everything." — with one named exception', () => {
    // `workspaces` (issue #119) is the one resource whose row IS the tenant `decide()` otherwise
    // assumes from `principal.workspaceId`: a `GET`/`PATCH /api/workspaces/:id` can legitimately
    // name a workspace that is not the caller's *session* workspace (a member of two, switching),
    // so `any` — which `applyGrant` allows without ever consulting `ownership` — would let an
    // Owner-in-session-A `PATCH` a workspace they do not belong to at all. See
    // `permissions.ts`'s `WORKSPACE_MEMBER_SCOPED` comment and
    // `docs/adr/W9-WS-119-workspace-resource-authorisation-and-lifecycle.md` for the full
    // reasoning. Every other resource keeps the unqualified "Everything." this test title quotes.
    const NAMED_EXCEPTIONS: readonly Resource[] = ['workspaces'];
    const withheld = RESOURCES.filter((resource: Resource) => {
      if (NAMED_EXCEPTIONS.includes(resource)) return false;
      const grants = grantsFor('owner', resource);
      return grants.read !== 'any' || grants.write !== 'any' || grants.run !== 'any';
    });
    expect(withheld).toEqual([]);
    // The exception itself is still real coverage, not a hole: Owner reaches `own` width, not
    // `none`, over `workspaces`.
    for (const resource of NAMED_EXCEPTIONS) {
      const grants = grantsFor('owner', resource);
      expect(grants.read, `${resource}: owner should still read`).not.toBe('none');
      expect(grants.write, `${resource}: owner should still write`).not.toBe('none');
    }
  });

  it('gives Admin the resources §21 names it, and skills and files like agents (ADR-0116)', () => {
    for (const resource of [
      'users',
      'agents',
      'models',
      'api-keys',
      'connectors',
      'runtime-profiles',
      'runtimes',
    ] as const) {
      expect(grantsFor('admin', resource).write, `admin cannot write ${resource}`).toBe('any');
    }
    // §21's Admin list omits both; docs/adr/0116-admin-manages-skills-and-files.md supersedes
    // W2-CP-06's literal reading so Admin is never narrower than Builder over them.
    const everything = { read: 'any', write: 'any', run: 'any' };
    expect(grantsFor('admin', 'skills')).toEqual(everything);
    expect(grantsFor('admin', 'files')).toEqual(everything);
  });

  it('lets Admin read workspace-wide run history while Builder and Viewer stay own-only — §21’s "revoke or suspend any share in the workspace" and its runnable-public-link budget sentence, issue #165', () => {
    // The two §21 sentences the widening rests on are looked up rather than paraphrased, the same
    // way this file checks every role's `because`: a reading of §21 that quotes something §21 does
    // not say is not a reading of §21. See
    // docs/adr/W9-AUTH-165-admin-reads-workspace-run-history.md, which reverses
    // W2-CP-06's least-privilege reading of §21's silence for this one cell.
    const section = specSection(/^# 21\. Users and RBAC$/m, '§21');
    for (const sentence of [
      'revoke or suspend any share in the workspace, see the shared-links page',
      'requires Admin or Owner, because it spends the\nworkspace budget',
    ]) {
      expect(section.includes(sentence), `§21 does not contain: ${sentence}`).toBe(true);
    }

    expect(grantsFor('admin', 'runs').read).toBe('any');
    // A read widening, plus issue #235's `run: 'any'` (an Admin may interrupt any run, the same
    // width it already has over token revocation): an Admin still cannot start or write a run.
    expect(grantsFor('admin', 'runs').write).toBe('none');
    expect(grantsFor('admin', 'runs').run).toBe('any');

    for (const role of ['builder', 'viewer'] as const) {
      expect(grantsFor(role, 'runs').read, `${role} must stay own-only on runs`).toBe('own');
      // Issue #235: each may interrupt only the runs it owns.
      expect(grantsFor(role, 'runs').run, `${role} must stay own-only on interrupt`).toBe('own');
    }
    // The boundary of the widening, asserted rather than assumed: issue #165 moves `runs` and
    // nothing else, so §21's silence on `sessions` is still read the least-privilege way. This
    // pins the *table* cell only — the live session routes authorise through
    // `apps/web/server/composition/session-rbac.ts`'s `canAccessSession`, not through this table.
    expect(grantsFor('admin', 'sessions').read).toBe('own');
  });

  it('gives Builder the four resources §21 names it, limited to its own rows', () => {
    for (const resource of ['agents', 'skills', 'files', 'connectors'] as const) {
      expect(grantsFor('builder', resource).write, resource).toBe('own');
      expect(grantsFor('builder', resource).read, resource).toBe('any');
    }
    expect(grantsFor('builder', 'users').write).toBe('none');
    expect(grantsFor('builder', 'api-keys').write).toBe('none');
  });

  it('lets Owner, Admin and Builder upload and read tool bundles and Viewer neither — issue #790', () => {
    for (const role of ['owner', 'admin', 'builder'] as const) {
      expect(grantsFor(role, 'tool-bundles').read, role).toBe('any');
      expect(grantsFor(role, 'tool-bundles').write, role).toBe('any');
    }
    expect(grantsFor('viewer', 'tool-bundles')).toEqual({
      read: 'none',
      write: 'none',
      run: 'none',
    });
  });

  it('gives Viewer its own sessions and a run grant that denies until a mechanism exists', () => {
    expect(grantsFor('viewer', 'sessions').read).toBe('own');
    expect(grantsFor('viewer', 'sessions').write).toBe('none');
    expect(grantsFor('viewer', 'agents').read).toBe('any');
    expect(grantsFor('viewer', 'agents').run).toBe('permitted');
    expect(grantsFor('viewer', 'agents').write).toBe('none');
  });

  it('lets every role read its own principal and no role write one — issue #233', () => {
    for (const role of ROLES) {
      expect(grantsFor(role, 'me').read, `${role} cannot read its own principal`).toBe('any');
    }
    // Owner's `EVERYTHING` fallback covers `me` for the same reason it covers every resource
    // §21 does not name it against, so the write assertion is about the other three: a principal
    // is a projection of a membership or an API-key row and is administered through those.
    for (const role of ['admin', 'builder', 'viewer'] as const) {
      expect(grantsFor(role, 'me').write, `${role} may write a principal`).toBe('none');
      expect(grantsFor(role, 'me').run, `${role} may run a principal`).toBe('none');
    }
  });

  it('gives no role but Owner anything over secrets — §21 names none', () => {
    for (const role of ROLES) {
      const expected = role === 'owner' ? 'any' : 'none';
      expect(grantsFor(role, 'secrets').read, role).toBe(expected);
      expect(grantsFor(role, 'secrets').write, role).toBe(expected);
    }
  });
});
