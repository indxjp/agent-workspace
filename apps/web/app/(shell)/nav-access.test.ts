import { describe, expect, it } from 'vitest';

import { NAVIGATION } from '../../components/shell/navigation';
import { ROLES, isConferrable } from '../../server/rbac/core/roles';

import { HIDDEN_FROM_GUESTS, navIdsHiddenFrom, roleMayOpen, SCREEN_API } from './nav-access';

const entries = NAVIGATION.flatMap((group) => group.items);

describe('the navigation a guest is shown', () => {
  it('names the API of every navigation entry, and no other', () => {
    expect(Object.keys(SCREEN_API).sort()).toEqual(entries.map((item) => item.id).sort());
  });

  it('leaves a guest New chat, Agents and Runs: the entries its role may load, less Settings', () => {
    const loadable = entries.filter((item) => roleMayOpen('guest', item.id)).map((item) => item.id);
    expect(loadable.sort()).toEqual(['agents', 'home', 'runs', 'settings']);
    expect(
      entries
        .map((item) => item.id)
        .filter((id) => !navIdsHiddenFrom('guest').includes(id))
        .sort(),
    ).toEqual(['agents', 'home', 'runs']);
  });

  it('hides Settings from a guest, whose role may still read its workspace features', () => {
    expect(roleMayOpen('guest', 'settings')).toBe(true);
    expect(HIDDEN_FROM_GUESTS).toEqual(['settings']);
    expect(navIdsHiddenFrom('guest')).toContain('settings');
  });

  it('hides Shared links from a guest, whose request to its API is refused', () => {
    expect(roleMayOpen('guest', 'shares')).toBe(false);
    expect(navIdsHiddenFrom('guest')).toContain('shares');
  });

  it('hides every manager-only entry from a guest', () => {
    for (const item of entries.filter((entry) => entry.managersOnly === true)) {
      expect(navIdsHiddenFrom('guest'), item.id).toContain(item.id);
    }
  });

  it('changes nothing for the four roles a workspace member can hold', () => {
    for (const role of ROLES.filter(isConferrable)) {
      expect(navIdsHiddenFrom(role), role).toEqual([]);
    }
  });

  it('adds nothing for a value that is not a role', () => {
    expect(navIdsHiddenFrom('stranger')).toEqual([]);
  });
});
