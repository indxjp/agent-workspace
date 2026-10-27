import { describe, expect, it, vi } from 'vitest';

import type { DirectoryRoot } from '../../rbac/directory';
import type { Role } from '../../rbac/roles';
import { createAllowedOwnerWarning, OWNER_OK_TTL_MS } from './allowed-owner-warning';

const WORKSPACE = 'ws-1';

function setup(roles: Readonly<Record<string, Role>>, failing = false) {
  const warn = vi.fn();
  const clock = { at: 0 };
  const current = { roles: { ...roles } as Record<string, Role> };
  const listMemberships = vi.fn(() =>
    failing
      ? Promise.reject(new Error('directory down'))
      : Promise.resolve(
          Object.entries(current.roles).map(([principalId, role]) => ({ principalId, role })),
        ),
  );
  const directory = {
    forWorkspace: () => ({ listMemberships }),
  } as unknown as Pick<DirectoryRoot, 'forWorkspace'>;
  return {
    warn,
    listMemberships,
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
    const { warn, listMemberships, clock, current, warning } = setup({ 'principal-1': 'admin' });
    const run = () => warning(WORKSPACE, { id: 'agent-1', ownerPrincipalId: 'principal-1' });
    await run();
    await run();
    expect(listMemberships).toHaveBeenCalledTimes(1);
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
    const { warn, listMemberships, warning } = setup({}, true);
    await expect(
      warning(WORKSPACE, { id: 'agent-1', ownerPrincipalId: 'principal-1' }),
    ).resolves.toBeUndefined();
    await warning(WORKSPACE, { id: 'agent-1', ownerPrincipalId: 'principal-1' });
    expect(listMemberships).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });
});
