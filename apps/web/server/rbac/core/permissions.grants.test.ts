/**
 * The §21 permission table's grants, checked against the sentences of §21 that require them.
 * The §34 resource classification lives in `permissions.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { grantsFor, policyBecause, RESOURCES, type Grant, type Resource } from './permissions';
import { specSection } from '../permissions.test-support';
import { ROLES } from './roles';

describe('every role’s grants cite §21', () => {
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
});

describe('Admin’s grants', () => {
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
});

describe('Builder and Viewer grants, webhooks and tool bundles', () => {
  it('gives Builder the four resources §21 names it, limited to its own rows', () => {
    for (const resource of ['agents', 'skills', 'files', 'connectors'] as const) {
      expect(grantsFor('builder', resource).write, resource).toBe('own');
      expect(grantsFor('builder', resource).read, resource).toBe('any');
    }
    expect(grantsFor('builder', 'users').write).toBe('none');
    expect(grantsFor('builder', 'api-keys').write).toBe('none');
  });

  it('lets Owner and Admin manage webhooks and Builder and Viewer nothing — issue #250 (N-3)', () => {
    const manage = { read: 'any', write: 'any', run: 'none' };
    expect(grantsFor('owner', 'webhooks')).toEqual({ read: 'any', write: 'any', run: 'any' });
    expect(grantsFor('admin', 'webhooks')).toEqual(manage);
    for (const role of ['builder', 'viewer'] as const) {
      expect(grantsFor(role, 'webhooks'), role).toEqual({
        read: 'none',
        write: 'none',
        run: 'none',
      });
    }
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
});

describe('the guest holds only the demo', () => {
  it('holds a guest to the demo — §21 Guest: only these resources hold anything, and workspaces cannot be written', () => {
    // The whole of what a guest holds, spelled out: a resource added to the guest row, or a
    // widened cell, fails here by name instead of being inherited from a fallback.
    const held = RESOURCES.flatMap((resource) => {
      const grants = grantsFor('guest', resource);
      return grants.read === 'none' && grants.write === 'none' && grants.run === 'none'
        ? []
        : [`${resource}: ${grants.read}/${grants.write}/${grants.run}`];
    });
    expect(held.sort()).toEqual([
      'agents: any/none/permitted',
      // Reading what its own demo workspace has left (`GET /api/demo/allowance`).
      'demo: any/none/none',
      'me: any/none/none',
      'runs: own/none/own',
      'sessions: own/none/none',
      'workspaces: own/none/none',
    ]);
    // A guest that could write `workspaces` could create one and be its Owner.
    expect(grantsFor('guest', 'workspaces').write).toBe('none');
    // Nothing is writable, and nothing is `any`-wide except reading the demo agents and itself.
    for (const resource of RESOURCES) {
      expect(grantsFor('guest', resource).write, `guest writes ${resource}`).toBe('none');
    }
  });
});

describe('principals, ADR-0152 corrections and secrets', () => {
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

  it('corrects the four cells where a lower role out-ranked a higher one (ADR-0152)', () => {
    // Builder runs its own agents and the ones an `agent_grants` row names (`permitted` is "own or
    // granted"), so it is no longer denied what a Viewer with the same row is allowed.
    expect(grantsFor('builder', 'agents')).toEqual({
      read: 'any',
      write: 'own',
      run: 'permitted',
    });
    // Admin runs every connector, as Builder runs its own.
    expect(grantsFor('admin', 'connectors')).toEqual({ read: 'any', write: 'any', run: 'any' });
    // Admin reads and writes every project, as Builder does its own.
    expect(grantsFor('admin', 'projects')).toEqual({ read: 'any', write: 'any', run: 'none' });
  });

  it('gives no role but Owner anything over secrets — §21 names none', () => {
    for (const role of ROLES) {
      const expected = role === 'owner' ? 'any' : 'none';
      expect(grantsFor(role, 'secrets').read, role).toBe(expected);
      expect(grantsFor(role, 'secrets').write, role).toBe(expected);
    }
  });
});

/** Does grant `higher` admit every ownership answer grant `lower` admits? (`decide.ts#applyGrant`) */
function covers(higher: Grant, lower: Grant): boolean {
  // `permitted` admits `own` as well as `permitted` (ADR-0152), so it covers `own`.
  return (
    higher === 'any' ||
    higher === lower ||
    lower === 'none' ||
    (higher === 'permitted' && lower === 'own')
  );
}

describe('roles are monotonic (ADR-0152)', () => {
  it('gives every role at least the access of every role below it, on every cell', () => {
    const inverted = ROLES.flatMap((higher, index) =>
      ROLES.slice(index + 1).flatMap((lower) =>
        RESOURCES.flatMap((resource) =>
          (['read', 'write', 'run'] as const)
            .filter(
              (operation) =>
                !covers(
                  grantsFor(higher, resource)[operation],
                  grantsFor(lower, resource)[operation],
                ),
            )
            .map(
              (operation) =>
                `${resource}.${operation}: ${higher}=${grantsFor(higher, resource)[operation]} < ` +
                `${lower}=${grantsFor(lower, resource)[operation]}`,
            ),
        ),
      ),
    );
    expect(inverted).toEqual([]);
  });
});
