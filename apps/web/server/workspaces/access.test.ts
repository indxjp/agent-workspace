/**
 * A direct unit test of {@link memberOwnershipResolver} and {@link ownerOwnershipResolver} against
 * a real (in-memory) `WorkspaceDirectory`, proving the positive assertion verification round 2's
 * finding 4 asked for: a SESSION caller whose own membership has vanished by the time the resolver
 * reads `listMemberships()` is REFUSED, never mapped onto the workspace's oldest Owner.
 *
 * ## Why the membership is deleted directly, rather than raced over HTTP
 *
 * The real race is a request-scoped ordering accident — the membership is removed by a second,
 * concurrent request between `identify()` verifying the session cookie and this module's own
 * `listMemberships()` read. Reproducing that ordering accident itself would need two real
 * concurrent HTTP requests and no guarantee which one wins; what actually matters for this test is
 * the STATE the race can produce — a `Principal` naming an actor `listMemberships()` no longer
 * lists — and a resolver is a pure function of exactly that state. This constructs the state
 * directly: a real `Principal` for a real session claim, and a real `WorkspaceDirectory` whose
 * membership was deleted immediately before the resolver runs. `docs/adr/W9-WS-119-api-key-callers-
 * are-refused.md`'s alternative 3 originally called the direct `resolveMemberUserId`-null-means-
 * refuse form "identical outcome, more code" against the fallback that already refused API keys;
 * this test is what showed the outcome was NOT identical for this one window, which is why
 * `access.ts` now uses {@link import('../rbac/ownership').resolveSessionActorUserId} and the ADR's
 * alternative 3 is amended to record that form as adopted alongside `apiKeyRefusal`. The same
 * state driven through all four real route handlers is `vanished-membership.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { mintSessionToken, newSessionClaims, verifySessionToken } from '../auth/session';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { memberOwnershipResolver, ownerOwnershipResolver } from './access';
import { createMemoryWorkspaceRepository } from './testing';

const TEST_SESSION_SECRET = 'a-test-session-secret-that-is-long-enough-32';
const WORKSPACE_A = '7a2e98e6-dd85-4fef-a38e-ee176fbdb0ff';
const WORKSPACE_SLUG = 'alpha';

const REMOVED_IDENTITIES: Readonly<
  Record<string, { principalId: string; userId: string; label: string }>
> = {
  'viewer@alpha.test': {
    principalId: '39ef8507-af13-453a-9791-1f4ef68e62ea',
    userId: '111bbf72-3cd7-4cbd-8858-945b9aacc22d',
    label: 'Removed viewer',
  },
  'second-owner@alpha.test': {
    principalId: '6424b59c-a39a-477f-8938-14ea6f08ca88',
    userId: 'b5879d5e-6d7c-499c-9eb2-8b9ea939fe5f',
    label: 'Removed owner',
  },
};

async function sessionPrincipalFor(email: string, role: 'owner' | 'viewer'): Promise<Principal> {
  const token = await mintSessionToken(
    newSessionClaims(email, WORKSPACE_SLUG),
    TEST_SESSION_SECRET,
  );
  const verified = await verifySessionToken(token, TEST_SESSION_SECRET);
  if (!verified.ok) throw new Error(`test setup failed to mint a session: ${verified.reason}`);
  const identity = REMOVED_IDENTITIES[email];
  if (identity === undefined) throw new Error(`no exact identity fixture for ${email}`);
  const built = Principal.fromSession(
    verified.claims,
    { id: WORKSPACE_A, slug: WORKSPACE_SLUG },
    role,
    identity,
  );
  if (!built.ok) throw new Error(`test setup failed to build a principal: ${built.because}`);
  return built.principal;
}

describe('a session caller whose own membership vanished before the resolver ran is refused, not remapped to the oldest Owner (verification round 2, finding 4)', () => {
  it('memberOwnershipResolver refuses rather than falling back to another member', async () => {
    const directory = createMemoryDirectory({
      users: [
        { email: 'owner@alpha.test', name: 'Owner', workspaceId: WORKSPACE_A, role: 'owner' },
        { email: 'viewer@alpha.test', name: 'Viewer', workspaceId: WORKSPACE_A, role: 'viewer' },
      ],
    });
    const ownerId = (await directory.findUserByEmail('owner@alpha.test'))?.id;
    if (ownerId === undefined) throw new Error('seed failed');

    const scoped = directory.forWorkspace(WORKSPACE_A);
    const viewerMembership = (await scoped.listMemberships()).find(
      (member) => member.email === 'viewer@alpha.test',
    );
    if (viewerMembership === undefined) throw new Error('seed failed');

    // The race: by the time the resolver's `listMemberships()` runs, the viewer's OWN membership
    // is already gone — but the `Principal` below still names them (built from an already-verified
    // session, exactly as `identify()` would have built it a moment earlier).
    const deleted = await scoped.deleteMembership(viewerMembership.id);
    expect(deleted.kind).toBe('deleted');

    const principal = await sessionPrincipalFor('viewer@alpha.test', 'viewer');
    const repository = createMemoryWorkspaceRepository({
      workspaces: [
        {
          id: WORKSPACE_A,
          slug: WORKSPACE_SLUG,
          name: 'Alpha',
          members: [{ userId: ownerId, role: 'owner' }],
        },
      ],
    });

    const outcome = await memberOwnershipResolver(repository, WORKSPACE_A)(principal, scoped);

    // Refused outright — never `{ kind: 'ownership', ownership: 'own' }` for the workspace's
    // oldest Owner (`ownerId`), which is what the pre-fix `resolveActorUserId` fallback would have
    // silently authorised this request as.
    expect(outcome.kind).toBe('refuse');
    if (outcome.kind !== 'refuse') return;
    expect(outcome.result.status).toBe(404);
    const body = outcome.result.body as { error: { code: string } };
    expect(body.error.code).toBe('workspace_not_found');
  });

  it('ownerOwnershipResolver refuses the same way for a caller who used to be the Owner', async () => {
    const directory = createMemoryDirectory({
      users: [
        {
          email: 'first-owner@alpha.test',
          name: 'First Owner',
          workspaceId: WORKSPACE_A,
          role: 'owner',
        },
        {
          email: 'second-owner@alpha.test',
          name: 'Second Owner',
          workspaceId: WORKSPACE_A,
          role: 'owner',
        },
      ],
    });
    const firstOwnerId = (await directory.findUserByEmail('first-owner@alpha.test'))?.id;
    if (firstOwnerId === undefined) throw new Error('seed failed');

    const scoped = directory.forWorkspace(WORKSPACE_A);
    const secondOwnerMembership = (await scoped.listMemberships()).find(
      (member) => member.email === 'second-owner@alpha.test',
    );
    if (secondOwnerMembership === undefined) throw new Error('seed failed');

    // Two Owners seeded so this delete never trips the last-owner refusal itself — the point here
    // is the RACE window, not the last-owner invariant `ownerOwnershipResolver` already reads
    // through the repository, not the directory.
    const deleted = await scoped.deleteMembership(secondOwnerMembership.id);
    expect(deleted.kind).toBe('deleted');

    const principal = await sessionPrincipalFor('second-owner@alpha.test', 'owner');
    const repository = createMemoryWorkspaceRepository({
      workspaces: [
        {
          id: WORKSPACE_A,
          slug: WORKSPACE_SLUG,
          name: 'Alpha',
          members: [{ userId: firstOwnerId, role: 'owner' }],
        },
      ],
    });

    const outcome = await ownerOwnershipResolver(repository, WORKSPACE_A)(principal, scoped);

    expect(outcome.kind).toBe('refuse');
    if (outcome.kind !== 'refuse') return;
    expect(outcome.result.status).toBe(404);
    const body = outcome.result.body as { error: { code: string } };
    expect(body.error.code).toBe('workspace_not_found');
  });
});
