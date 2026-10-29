import { describe, expect, it } from 'vitest';

import { decide, type Ownership } from '../rbac/decide';
import { ROLES, type Role } from '../rbac/roles';
import {
  NO_RESTORE_CAPABILITY,
  agentRestoreGrantsForRole,
  resolveAgentRestoreCapability,
} from './restore-capability';

/** What the restore route's own policy answers for this role and ownership. */
function routeAllows(role: Role, ownership: Ownership): boolean {
  return (
    decide({ role, method: 'POST', path: '/api/agents/:id/restore', ownership, scope: null })
      .effect === 'allow'
  );
}

describe('agentRestoreGrantsForRole', () => {
  it.each([...ROLES])('answers for %s exactly what the restore route answers', (role) => {
    expect(agentRestoreGrantsForRole(role)).toEqual({
      canRestoreOwn: routeAllows(role, 'own'),
      canRestoreOther: routeAllows(role, 'other'),
    });
  });

  it('gives Owner and Admin every agent, a Builder their own, a Viewer none', () => {
    expect(agentRestoreGrantsForRole('owner')).toEqual({
      canRestoreOwn: true,
      canRestoreOther: true,
    });
    expect(agentRestoreGrantsForRole('admin')).toEqual({
      canRestoreOwn: true,
      canRestoreOther: true,
    });
    expect(agentRestoreGrantsForRole('builder')).toEqual({
      canRestoreOwn: true,
      canRestoreOther: false,
    });
    expect(agentRestoreGrantsForRole('viewer')).toEqual({
      canRestoreOwn: false,
      canRestoreOther: false,
    });
  });

  it('refuses a role the table does not recognise', () => {
    expect(agentRestoreGrantsForRole('superuser')).toEqual({
      canRestoreOwn: false,
      canRestoreOther: false,
    });
  });
});

describe('resolveAgentRestoreCapability', () => {
  it('denies when the RBAC runtime is not wired', async () => {
    await expect(resolveAgentRestoreCapability()).resolves.toEqual(NO_RESTORE_CAPABILITY);
  });
});
