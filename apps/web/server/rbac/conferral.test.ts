/**
 * The privilege-escalation counter-example, re-run, and the rule that closed it.
 *
 * The first two tests are the verifier's own reproduction from the round-1 frozen list, driving
 * the same shipping route modules through the same harness with the same workspace — one
 * `owner@example.test` and one `admin@example.test`. In round 1 they produced:
 *
 * ```text
 * POST /api/api-keys {role:"owner"} as ADMIN -> 201 ; the key authenticates with role -> owner
 * AFTER that key GET /api/secrets -> allow
 * PATCH own membership {role:"owner"} as ADMIN -> 200 ; role now -> owner
 * ```
 *
 * ADR-0029: the fix is proved by running that, not by asserting it is fixed. Everything below is
 * the same sequence with the conferral rule in place, and each assertion is on the *state* the
 * escalation was after — the role a minted key authenticates with, what `decide` then says about
 * `/api/secrets`, and the role the directory holds — rather than only on the status code.
 */
import { describe, expect, it } from 'vitest';

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

import { PATCH as PATCH_MEMBERSHIP } from '../../app/api/memberships/[id]/route';
import { GET as LIST_MEMBERSHIPS } from '../../app/api/memberships/route';
import { GET as LIST_API_KEYS, POST as CREATE_API_KEY } from '../../app/api/api-keys/route';

import { REPO_ROOT } from '../../../../tests/inventory-support';

import { conferralMatrix, conferRole, dominates } from './conferral';
import { decide } from './decide';
import { RESOURCES, type Grant } from './permissions';
import { ROLES, type Role } from './roles';
import { installRbacHarness, TEST_WORKSPACE_ID, type RbacHarness } from './testing';

const OWNER = { email: 'owner@example.test' };
const ADMIN = { email: 'admin@example.test' };

/**
 * The workspace the verifier's counter-example used: one Owner and one Admin.
 *
 * `newId` is supplied — as `invitations/routes.test.ts` already does — because the promotion below
 * `PATCH`es a membership id this fixture minted, and issue #203 made the handler refuse an id that
 * is not shaped like the `uuid` column it is about to be compared against. The fixture's default
 * counter (`id-4`) is not, so a seeded id that stood in for a real one has to be one.
 */
function twoMembers(): RbacHarness {
  return installRbacHarness(
    [
      { email: OWNER.email, name: 'The Owner', workspaceId: TEST_WORKSPACE_ID, role: 'owner' },
      { email: ADMIN.email, name: 'The Admin', workspaceId: TEST_WORKSPACE_ID, role: 'admin' },
    ],
    { newId: crypto.randomUUID },
  );
}

/** What §21's split says this role may do with `/api/secrets` — the capability at stake. */
function secretsEffect(role: Role): string {
  return decide({
    role,
    method: 'GET',
    path: '/api/secrets',
    ownership: 'not-applicable',
    scope: null,
  }).effect;
}

describe('an Admin cannot mint an Owner — the verifier’s counter-example (a)', () => {
  it('refuses POST /api/api-keys {role:"owner"} from an Admin, and stores no such key', async () => {
    const harness = twoMembers();
    try {
      // BEFORE, exactly as the verifier printed it.
      expect(secretsEffect('admin')).toBe('deny');

      const response = await harness.call(CREATE_API_KEY, {
        method: 'POST',
        path: '/api/api-keys',
        as: ADMIN,
        body: { name: 'escalation', role: 'owner', expiresAt: null },
      });

      expect(response.status, response.text).toBe(403);
      expect(response.text).toContain('forbidden_role_conferral');
      // The point is the state, not the status: no key exists at all, so there is nothing to
      // authenticate with and no need to ask what role it would carry.
      expect(harness.directory.everyStoredApiKey()).toEqual([]);
      const listed = await harness.call(LIST_API_KEYS, {
        method: 'GET',
        path: '/api/api-keys',
        as: ADMIN,
      });
      expect(listed.status).toBe(200);
      expect(listed.text).not.toContain('escalation');
    } finally {
      harness.teardown();
    }
  });

  it('still lets the Admin mint a key at a role it holds, so the refusal is about conferral', async () => {
    const harness = twoMembers();
    try {
      const response = await harness.call(CREATE_API_KEY, {
        method: 'POST',
        path: '/api/api-keys',
        as: ADMIN,
        body: { name: 'legitimate', role: 'viewer', expiresAt: null },
      });
      expect(response.status, response.text).toBe(201);
      const stored = harness.directory.everyStoredApiKey();
      expect(stored.map((row) => row.role)).toEqual(['viewer']);
      // And what it authenticates as is what §21 grants a Viewer, not what an Owner gets.
      const body = response.body as { key?: unknown };
      const presented = body.key;
      if (typeof presented !== 'string') throw new Error('the 201 carried no key');
      const identity = await harness.directory.authenticateApiKey(presented, new Date());
      expect(identity?.role).toBe('viewer');
      expect(secretsEffect(identity?.role ?? 'owner')).toBe('deny');
    } finally {
      harness.teardown();
    }
  });
});

describe('an Admin cannot promote itself — the verifier’s counter-example (b)', () => {
  it('refuses PATCH /api/memberships/<own id> {role:"owner"} and leaves the role alone', async () => {
    const harness = twoMembers();
    try {
      const listed = await harness.call(LIST_MEMBERSHIPS, {
        method: 'GET',
        path: '/api/memberships',
        as: ADMIN,
      });
      expect(listed.status).toBe(200);
      const memberships = (listed.body as { memberships: { id: string; email: string }[] })
        .memberships;
      const own = memberships.find((row) => row.email === ADMIN.email);
      if (own === undefined) throw new Error('the admin has no membership row to patch');

      const response = await harness.call(PATCH_MEMBERSHIP, {
        method: 'PATCH',
        path: `/api/memberships/${own.id}`,
        id: own.id,
        as: ADMIN,
        body: { role: 'owner' },
      });
      expect(response.status, response.text).toBe(403);
      expect(response.text).toContain('forbidden_role_conferral');

      // The state the escalation was after: the directory's answer to "what role does this
      // caller hold?", read the way `identify` reads it on the next request.
      expect(await harness.directory.resolveRole(ADMIN.email, TEST_WORKSPACE_ID)).toBe('admin');
      expect(secretsEffect('admin')).toBe('deny');
    } finally {
      harness.teardown();
    }
  });

  it('lets the Owner do the same promotion, so the refusal is about the caller', async () => {
    const harness = twoMembers();
    try {
      const listed = await harness.call(LIST_MEMBERSHIPS, {
        method: 'GET',
        path: '/api/memberships',
        as: OWNER,
      });
      const memberships = (listed.body as { memberships: { id: string; email: string }[] })
        .memberships;
      const target = memberships.find((row) => row.email === ADMIN.email);
      if (target === undefined) throw new Error('no admin membership');
      const response = await harness.call(PATCH_MEMBERSHIP, {
        method: 'PATCH',
        path: `/api/memberships/${target.id}`,
        id: target.id,
        as: OWNER,
        body: { role: 'owner' },
      });
      expect(response.status, response.text).toBe(200);
      expect(await harness.directory.resolveRole(ADMIN.email, TEST_WORKSPACE_ID)).toBe('owner');
    } finally {
      harness.teardown();
    }
  });
});

describe('the conferral rule is derived from the permission table, not written down', () => {
  it('is total over grant widths, and every pair has one of three answers', () => {
    const widths: Grant[] = ['none', 'own', 'permitted', 'any'];
    const answers = new Set<string>();
    for (const held of widths) {
      for (const conferred of widths) {
        answers.add(dominates(held, conferred));
      }
    }
    // Every one of the three answers is reachable — including `undecidable`, which is what makes
    // `refuse` a real branch rather than dead code.
    expect([...answers].sort()).toEqual(['does-not', 'dominates', 'undecidable']);
  });

  it('lets every role confer itself — the reflexive case, over all four', () => {
    for (const role of ROLES) {
      expect(conferRole(role, role).effect, role).toBe('allow');
    }
  });

  it('lets an Owner confer all four — §21: "Everything."', () => {
    for (const role of ROLES) {
      expect(conferRole('owner', role).effect, role).toBe('allow');
    }
  });

  it('refuses every conferral of Owner by a role that is not one, naming the resource', () => {
    for (const caller of ROLES.filter((role) => role !== 'owner')) {
      const conferral = conferRole(caller, 'owner');
      expect(conferral.effect, caller).toBe('deny');
      if (conferral.effect !== 'deny') throw new Error('unreachable');
      // The denial names a (resource, operation) pair where §21 grants Owner more than the
      // caller holds, so the reason is checkable rather than a slogan.
      expect(RESOURCES).toContain(conferral.witness.resource);
      expect(conferral.witness.conferred).toBe('any');
    }
  });

  it('answers every (caller, requested) pair, and answers `admin → builder` deny', () => {
    const matrix = conferralMatrix();
    // Derived from ROLES, not written down (ADR-0016).
    expect(matrix.length).toBe(ROLES.length * ROLES.length);
    const answer = (caller: Role, requested: Role): string => {
      const cell = matrix.find((row) => row.caller === caller && row.requested === requested);
      if (cell === undefined) throw new Error(`no cell for ${caller} → ${requested}`);
      return cell.effect;
    };
    // The fix.
    expect(answer('admin', 'owner')).toBe('deny');
    // The cost of the fix, asserted rather than discovered later: Builder holds its own
    // `projects` and runs its own `connectors`, neither of which §21's Admin clause grants
    // (ADR-0116 closed the `skills` and `files` gap), so an Admin conferring Builder would hand
    // out a capability the Admin has not got. Admin may still confer Admin and Viewer, which is
    // what makes this a consequence of §21's own words and not a blanket refusal.
    expect(answer('admin', 'builder')).toBe('deny');
    const adminToBuilder = conferRole('admin', 'builder');
    if (adminToBuilder.effect !== 'deny') throw new Error('admin → builder was not denied');
    expect(['projects', 'connectors']).toContain(adminToBuilder.witness.resource);
    expect(answer('admin', 'admin')).toBe('allow');
    expect(answer('admin', 'viewer')).toBe('allow');
  });

  it('refuses rather than denies where the comparison cannot be made', () => {
    // Builder holds `own` where Viewer is granted `permitted` on running an agent, and §21
    // defines no mechanism for `permitted`, so neither containment can be asserted. ADR-0031:
    // that is a refusal, not a quiet allow and not a denial that claims a rule was applied.
    const conferral = conferRole('builder', 'viewer');
    expect(conferral.effect).toBe('refuse');
    if (conferral.effect !== 'refuse') throw new Error('unreachable');
    expect(conferral.because).toContain('permitted');
  });

  it('refuses a caller role or a requested role that is not one of §21’s four', () => {
    for (const bad of ['root', 'OWNER', '', 42, null, undefined]) {
      expect(conferRole(bad, 'viewer').effect, `caller ${JSON.stringify(bad)}`).toBe('refuse');
      expect(conferRole('owner', bad).effect, `requested ${JSON.stringify(bad)}`).toBe('refuse');
    }
  });
});

describe('nothing outside conferral.ts can produce a ConferredRole', () => {
  it('writes the cast that would defeat the brand in exactly one tracked file', () => {
    // A string scan, not an import-graph question, so ADR-0030 does not apply to it: what is
    // asserted is that the literal cast appears nowhere else, and that is a claim about text.
    // The type system is what stops the other spellings — the brand is a `unique symbol` no
    // other module can name, so there is no second way to write the assertion.
    //
    // The needle is assembled rather than written, because a file that contained it would be a
    // file this scan reported — including this one.
    const needle = ['as', 'ConferredRole'].join(' ');
    const tracked = execFileSync('git', ['ls-files', '-z', '--', 'apps', 'packages', 'tests'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\0')
      .filter((file) => file !== '');
    expect(
      tracked.length,
      'git listed no tracked files, so this scan proved nothing',
    ).toBeGreaterThan(0);
    const casts = tracked.filter((file) => {
      try {
        return readFileSync(`${REPO_ROOT}/${file}`, 'utf8').includes(needle);
      } catch {
        // A tracked file that cannot be read is reported, not skipped (ADR-0015).
        return true;
      }
    });
    expect(casts).toEqual(['apps/web/server/rbac/conferral.ts']);
  });
});
