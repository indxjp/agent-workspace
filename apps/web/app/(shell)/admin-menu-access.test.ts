import { describe, expect, it } from 'vitest';

import { NAVIGATION } from '../../components/shell/navigation';
import { ROLES } from '../../server/rbac/core/roles';
import { decide } from '../../server/rbac/decide';

import { roleManagesStorage } from './admin/storage/manages-storage';

/**
 * UX-12 (#2086): a Builder saw the whole Administration menu, and Models, Storage, Users, API Keys
 * and Runtimes answered `403`. An entry is `managersOnly` exactly when the API its screen loads refuses
 * Builder and Viewer, so this table names that API and asks `decide()`, role by role.
 */
const SCREEN_API: Readonly<Record<string, { method: 'GET' | 'POST'; path: string }>> = {
  models: { method: 'GET', path: '/api/model-connections' },
  // The Storage screen manages connections; a Builder may only read them (issue #1690).
  storage: { method: 'POST', path: '/api/storage-connections' },
  users: { method: 'GET', path: '/api/memberships' },
  apikeys: { method: 'GET', path: '/api/api-keys' },
  runtimes: { method: 'GET', path: '/api/runtimes' },
  // Every member reads the Settings screen's Features card (AP-U2-4C); its subsystem status card is
  // drawn for managers only.
  settings: {
    method: 'GET',
    path: '/api/workspaces/00000000-0000-4000-8000-000000000001/features',
  },
  shares: { method: 'GET', path: '/api/shares' },
};

const admin = NAVIGATION.find((group) => group.label === 'Administration')?.items ?? [];

function allowed(role: (typeof ROLES)[number], id: string): boolean {
  const api = SCREEN_API[id];
  if (api === undefined) throw new Error(`no API named for the ${id} entry`);
  return decide({ ...api, role, ownership: 'not-applicable', scope: null }).effect === 'allow';
}

describe('the Administration menu matches what each role may do', () => {
  it('names the API of every Administration entry', () => {
    expect(admin.map((item) => item.id).sort()).toEqual(Object.keys(SCREEN_API).sort());
  });

  it.each(admin.map((item) => [item.id, item.managersOnly === true] as const))(
    '%s: managersOnly is %s exactly when only managers may use its screen',
    (id, managersOnly) => {
      for (const role of ROLES) {
        const shown = !managersOnly || roleManagesStorage(role);
        expect({ role, shown }).toEqual({ role, shown: allowed(role, id) });
      }
    },
  );
});
