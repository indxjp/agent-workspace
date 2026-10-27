/**
 * `resolveIdentity` — issue #118's "the shell shows database workspace/user names and the actual
 * role, not the session claim". `ShellLayout` itself is a Server Component this suite does not
 * render; `resolveIdentity` is the one function in the file that decides what it shows, and it is
 * exported for exactly this test.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { mintSessionToken, newSessionClaims, verifySessionToken } from '../../server/auth';
import { conferredBy } from '../../server/rbac/conferral';
import { createMemoryDirectory } from '../../server/rbac/memory-directory';

import { resolveIdentity } from './layout';
import { clearApplicationContext } from '../../server/application-context';
import { installTestDomains } from '../../server/application-context-fixtures';

const SECRET = 'a'.repeat(32);

async function verifiedSessionFor(email: string, workspaceSlug: string) {
  const token = await mintSessionToken(newSessionClaims(email, workspaceSlug), SECRET);
  const result = await verifySessionToken(token, SECRET);
  if (!result.ok) throw new Error('unreachable: mint then verify with the same secret');
  return result.claims;
}

describe('resolveIdentity', () => {
  afterEach(() => {
    clearApplicationContext();
  });

  it('resolves the real display name, workspace name and role — never the session-claim literal', async () => {
    const directory = createMemoryDirectory({
      workspaces: [{ id: 'ws-a', slug: 'acme', name: 'Acme Corp' }],
      users: [{ email: 'aya@example.test', name: 'Aya Ito', workspaceId: 'ws-a', role: 'builder' }],
    });
    installTestDomains({ rbac: { directory, identify: () => Promise.resolve(null) } });

    const session = await verifiedSessionFor('aya@example.test', 'acme');
    expect(session.role).toBe('owner'); // the vestigial claim every session mints (issue #118)

    const resolved = await resolveIdentity(session);
    expect(resolved).toEqual({ userName: 'Aya Ito', workspaceName: 'Acme Corp', role: 'builder' });

    // BREAK-IT CHECK (done by hand while writing this test, reverted before commit): changing
    // `resolveIdentity` to return `{ ..., role: session.role }` instead of `current.role` makes
    // this assertion fail — it would report `'owner'`, the session claim, for a Builder. Reading
    // `current.role` from the re-fetched membership makes it pass again.
  });

  it('changes on the next call the moment the role changes — no caching of a stale answer', async () => {
    const directory = createMemoryDirectory({
      workspaces: [{ id: 'ws-a', slug: 'acme', name: 'Acme Corp' }],
      users: [{ email: 'aya@example.test', name: 'Aya Ito', workspaceId: 'ws-a', role: 'viewer' }],
    });
    installTestDomains({ rbac: { directory, identify: () => Promise.resolve(null) } });
    const session = await verifiedSessionFor('aya@example.test', 'acme');

    expect((await resolveIdentity(session))?.role).toBe('viewer');

    const [membership] = await directory.forWorkspace('ws-a').listMemberships();
    if (membership === undefined) throw new Error('seed did not create a membership');
    await directory
      .forWorkspace('ws-a')
      .changeMembershipRole(membership.id, conferredBy('owner', 'admin', 'test'));

    expect((await resolveIdentity(session))?.role).toBe('admin');
  });

  it('resolves nothing once the membership the session named is gone, rather than repeating a stale claim', async () => {
    const directory = createMemoryDirectory({
      workspaces: [
        { id: 'ws-a', slug: 'acme', name: 'Acme Corp' },
        { id: 'ws-b', slug: 'beta', name: 'Beta Inc' },
      ],
      users: [{ email: 'aya@example.test', name: 'Aya Ito', workspaceId: 'ws-a', role: 'admin' }],
    });
    installTestDomains({ rbac: { directory, identify: () => Promise.resolve(null) } });
    const session = await verifiedSessionFor('aya@example.test', 'acme');

    const [membership] = await directory.forWorkspace('ws-a').listMemberships();
    if (membership === undefined) throw new Error('seed did not create a membership');
    await directory.forWorkspace('ws-a').deleteMembership(membership.id);

    expect(await resolveIdentity(session)).toBeNull();
  });

  it('resolves nothing when the RBAC runtime is not wired — a declared gap, not a crash', async () => {
    const session = await verifiedSessionFor('aya@example.test', 'acme');
    expect(await resolveIdentity(session)).toBeNull();
  });
});
