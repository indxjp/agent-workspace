/**
 * #2283: `memberships.id` is a `uuid` column, so PostgreSQL matches it in any case, while the Owner
 * guard once compared ids as strings. An upper-case path id then skipped the guard and the write
 * landed. The guard must find the Owner whatever the case of the id the caller sent.
 */
import { describe, expect, it } from 'vitest';

import { changeMembershipRole, deleteMembership } from './membership-handlers';
import { createMemoryDirectory } from './memory-directory';

const WS = 'workspace-a';
const OWNER_ID = '3f1c0b4e-9a2d-4c77-8b61-0e5d2a7c4f90';

async function directoryWithTwoOwners() {
  const base = createMemoryDirectory({
    users: [
      { email: 'a@example.test', name: 'A', workspaceId: WS, role: 'owner' },
      { email: 'b@example.test', name: 'B', workspaceId: WS, role: 'owner' },
    ],
  }).forWorkspace(WS);
  const rows = await base.listMemberships();
  const first = rows.find((row) => row.role === 'owner');
  if (first === undefined) throw new Error('the seed created no Owner');
  return { ...base, listMemberships: () => Promise.resolve([{ ...first, id: OWNER_ID }]) };
}

describe('the Owner guard on /api/memberships/:id', () => {
  it('refuses an Admin changing an Owner addressed by an upper-case id', async () => {
    const directory = await directoryWithTwoOwners();
    const result = await changeMembershipRole(directory, 'admin', OWNER_ID.toUpperCase(), {
      role: 'viewer',
    });
    expect(result.status).toBe(403);
  });

  it('refuses an Admin removing an Owner addressed by an upper-case id', async () => {
    const directory = await directoryWithTwoOwners();
    const result = await deleteMembership(directory, 'admin', OWNER_ID.toUpperCase());
    expect(result.status).toBe(403);
  });
});
