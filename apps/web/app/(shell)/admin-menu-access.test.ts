import { describe, expect, it } from 'vitest';

import { NAVIGATION, type NavId } from '../../components/shell/navigation';
import { ROLES, isConferrable } from '../../server/rbac/core/roles';
import { decide } from '../../server/rbac/decide';

import { SCREEN_API } from './nav-access';
import { roleManagesStorage } from './admin/storage/manages-storage';

/**
 * UX-12 (#2086): a Builder saw the whole Administration menu, and Models, Storage, Users, API Keys
 * and Runtimes answered `403`. An entry is `managersOnly` exactly when the API its screen loads refuses
 * Builder and Viewer, so `SCREEN_API` names that API and asks `decide()`, role by role.
 */
const admin = NAVIGATION.find((group) => group.label === 'Administration')?.items ?? [];

function allowed(role: (typeof ROLES)[number], id: NavId): boolean {
  const api = SCREEN_API[id];
  return decide({ ...api, role, ownership: 'not-applicable', scope: null }).effect === 'allow';
}

describe('the Administration menu matches what each role may do', () => {
  // `managersOnly` splits the four roles a workspace member can be given (Owner and Admin from
  // Builder and Viewer). A guest is not one of them: it holds only the demo workspace the
  // email-link sign-in made, reaches it through the store's public API (spec §21, "The guest
  // role"), and is refused every resource its row does not name, so it is checked on its own below.
  it.each(admin.map((item) => [item.id, item.managersOnly === true] as const))(
    '%s: managersOnly is %s exactly when only managers may use its screen',
    (id, managersOnly) => {
      for (const role of ROLES.filter(isConferrable)) {
        const shown = !managersOnly || roleManagesStorage(role);
        expect({ role, shown }).toEqual({ role, shown: allowed(role, id) });
      }
    },
  );

  it('hides every managers-only entry from a guest, whose role is refused each of their APIs', () => {
    expect(roleManagesStorage('guest')).toBe(false);
    for (const item of admin.filter((entry) => entry.managersOnly === true)) {
      expect({ id: item.id, allowed: allowed('guest', item.id) }).toEqual({
        id: item.id,
        allowed: false,
      });
    }
  });
});
