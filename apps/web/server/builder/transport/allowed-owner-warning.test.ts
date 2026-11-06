import { describe, expect, it, vi } from 'vitest';

import type { DirectoryRoot } from '../../rbac/directory';
import type { Role } from '../../rbac/core/roles';
import {
  createAllowedOwnerWarning,
  OWNER_OK_MAX_ENTRIES,
  OWNER_OK_TTL_MS,
} from './allowed-owner-warning';

const WORKSPACE = 'ws-1';

function setup(roles: Readonly<Record<string, Role>>, failing = false) {
  const warn = vi.fn();
  const clock = { at: 0 };
  const current = { roles: { ...roles } as Record<string, Role> };
  // The warning asks for the one owner it needs; the member list is never read.
  const findMembershipByPrincipal = vi.fn((principalId: string) => {
    if (failing) return Promise.reject(new Error('directory down'));
    const role = current.roles[principalId];
    return Promise.resolve(role === undefined ? null : { principalId, role });
  });
  const directory = {
    forWorkspace: () => ({
      findMembershipByPrincipal,
      listMemberships: () => Promise.reject(new Error('the member list must not be scanned')),
    }),
  } as unknown as Pick<DirectoryRoot, 'forWorkspace'>;
  return {
    warn,
    findMembershipByPrincipal,
    clock,
    current,
    warning: createAllowedOwnerWarning({ directory, warn, now: () => clock.at }),
  };
}

describe('the warning for an allow-listed agent whose owner is not an Owner or Admin (#1851)', () => {
  it.each<[string, Readonly<Record<string, Role>>, string]>([
    ['a Builder', { 'principal-1': 'builder' }, 'builder'],
    ['a Viewer', { 'principal-1': 'viewer' }, 'viewer'],
    ['someone no longer in the workspace', {}, 'none'],
  ])(
    'warns once for an agent owned by %s, however often its runs come',
    async (_l, roles, role) => {
      const { warn, warning } = setup(roles);
      await warning(WORKSPACE, { id: 'agent-1', ownerPrincipalId: 'principal-1' });
      await warning(WORKSPACE, { id: 'agent-1', ownerPrincipalId: 'principal-1' });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('not an Owner or Admin'), {
        workspaceId: WORKSPACE,
        agentId: 'agent-1',
        ownerPrincipalId: 'principal-1',
        ownerRole: role,
      });
    },
  );

  it.each(['owner', 'admin'] as const)('says nothing for an agent an %s owns', async (role) => {
    const { warn, warning } = setup({ 'principal-1': role });
    await warning(WORKSPACE, { id: 'agent-1', ownerPrincipalId: 'principal-1' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('looks at an owner found fine only once per window, and warns when the role is lowered after it', async () => {
    const { warn, findMembershipByPrincipal, clock, current, warning } = setup({
      'principal-1': 'admin',
    });
    const run = () => warning(WORKSPACE, { id: 'agent-1', ownerPrincipalId: 'principal-1' });
    await run();
    await run();
    expect(findMembershipByPrincipal).toHaveBeenCalledTimes(1);
    current.roles['principal-1'] = 'builder';
    clock.at = OWNER_OK_TTL_MS - 1;
    await run();
    expect(warn).not.toHaveBeenCalled();
    clock.at = OWNER_OK_TTL_MS;
    await run();
    await run();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ ownerRole: 'builder' }),
    );
  });

  it('remembers at most OWNER_OK_MAX_ENTRIES owners found fine, dropping the oldest first', async () => {
    const { findMembershipByPrincipal, warning } = setup({ 'principal-1': 'admin' });
    const ask = (n: number) =>
      warning(WORKSPACE, { id: `agent-${String(n)}`, ownerPrincipalId: 'principal-1' });

    for (let n = 0; n <= OWNER_OK_MAX_ENTRIES; n += 1) await ask(n);
    expect(findMembershipByPrincipal).toHaveBeenCalledTimes(OWNER_OK_MAX_ENTRIES + 1);

    // The newest is still trusted; the oldest was dropped to make room, so it is looked at again.
    await ask(OWNER_OK_MAX_ENTRIES);
    expect(findMembershipByPrincipal).toHaveBeenCalledTimes(OWNER_OK_MAX_ENTRIES + 1);
    await ask(0);
    expect(findMembershipByPrincipal).toHaveBeenCalledTimes(OWNER_OK_MAX_ENTRIES + 2);
  });

  it('warns once for each such agent', async () => {
    const { warn, warning } = setup({ 'principal-1': 'builder' });
    await warning(WORKSPACE, { id: 'agent-1', ownerPrincipalId: 'principal-1' });
    await warning(WORKSPACE, { id: 'agent-2', ownerPrincipalId: 'principal-1' });
    expect(warn.mock.calls.map(([, fields]) => (fields as { agentId: string }).agentId)).toEqual([
      'agent-1',
      'agent-2',
    ]);
  });

  it('never throws, and looks at the agent again after a directory failure', async () => {
    const { warn, findMembershipByPrincipal, warning } = setup({}, true);
    await expect(
      warning(WORKSPACE, { id: 'agent-1', ownerPrincipalId: 'principal-1' }),
    ).resolves.toBeUndefined();
    await warning(WORKSPACE, { id: 'agent-1', ownerPrincipalId: 'principal-1' });
    expect(findMembershipByPrincipal).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });
});
