import { describe, expect, it } from 'vitest';

import { decide } from '../../../../server/rbac/decide';
import { ROLES } from '../../../../server/rbac/roles';

import { roleManagesStorage } from './manages-storage';

describe('who sees and opens the storage pages', () => {
  it('admits exactly the roles decide() lets create a storage connection', () => {
    const admitted = ROLES.filter(
      (role) =>
        decide({
          role,
          method: 'POST',
          path: '/api/storage-connections',
          ownership: 'not-applicable',
          scope: null,
        }).effect === 'allow',
    );
    expect(admitted).toEqual(['owner', 'admin']);
    expect(ROLES.filter(roleManagesStorage)).toEqual(admitted);
  });

  it('admits no role it cannot parse', () => {
    expect([undefined, null, '', 'member', 'OWNER'].map(roleManagesStorage)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});
