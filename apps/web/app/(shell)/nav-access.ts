import type { NavId } from '../../components/shell/navigation';
import { parseRole } from '../../server/rbac/core/roles';
import { decide } from '../../server/rbac/decide';

/**
 * The API each navigation entry's screen loads. An entry is hidden from a role when `decide()`
 * refuses it that API, so a guest is never offered a screen whose first request answers `403`:
 * the guest of a demo workspace holds only agents, runs, sessions and its own workspace (spec §21,
 * "Guest"). Of those it is shown New chat, Agents and Runs: Settings, which its role may read, is
 * hidden from it too ({@link HIDDEN_FROM_GUESTS}), and no other entry is shown.
 * `admin-menu-access.test.ts` imports this table and holds each Administration entry to it, role by role.
 */
export const SCREEN_API: Readonly<Record<NavId, { method: 'GET' | 'POST'; path: string }>> = {
  home: { method: 'GET', path: '/api/agents' },
  projects: { method: 'GET', path: '/api/projects' },
  agents: { method: 'GET', path: '/api/agents' },
  files: { method: 'GET', path: '/api/files' },
  skills: { method: 'GET', path: '/api/skills' },
  connectors: { method: 'GET', path: '/api/connectors' },
  runs: { method: 'GET', path: '/api/runs' },
  models: { method: 'GET', path: '/api/model-connections' },
  // The Storage screen manages connections; a Builder may only read them (issue #1690).
  storage: { method: 'POST', path: '/api/storage-connections' },
  users: { method: 'GET', path: '/api/memberships' },
  apikeys: { method: 'GET', path: '/api/api-keys' },
  runtimes: { method: 'GET', path: '/api/runtimes' },
  shares: { method: 'GET', path: '/api/shares' },
  // Every member reads the Settings screen's Features card (AP-U2-4C).
  settings: {
    method: 'GET',
    path: '/api/workspaces/00000000-0000-4000-8000-000000000001/features',
  },
};

/**
 * The entries a guest is not shown although `decide()` lets it load their API. Settings: a guest
 * may read its own workspace's features (the API is kept as it is), but a demo visitor has nothing
 * to set there, so the shell does not offer the screen (human decision, 2026-11-16).
 */
export const HIDDEN_FROM_GUESTS: readonly NavId[] = ['settings'];

/** Whether `decide()` lets `role` load the API behind `id`'s screen. An unknown role is refused. */
export function roleMayOpen(role: unknown, id: NavId): boolean {
  const parsed = parseRole(role);
  return (
    parsed !== null &&
    decide({ ...SCREEN_API[id], role: parsed, ownership: 'not-applicable', scope: null }).effect ===
      'allow'
  );
}

/**
 * The entries to leave out of the sidebar of `role`. Only the guest is held to the table, and to
 * {@link HIDDEN_FROM_GUESTS}: it is the one role that is not a member of a real workspace, and the
 * four that are keep their menu by `NavItem.managersOnly` (UX-12, #2086), which
 * `admin-menu-access.test.ts` holds to `decide()`.
 */
export function navIdsHiddenFrom(role: unknown): readonly NavId[] {
  if (parseRole(role) !== 'guest') return [];
  return (Object.keys(SCREEN_API) as NavId[]).filter(
    (id) => HIDDEN_FROM_GUESTS.includes(id) || !roleMayOpen(role, id),
  );
}
