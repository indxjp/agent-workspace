/**
 * The main navigation — spec §44, in §44's order.
 *
 * §44 prints the navigation as a literal block and says "keep the navigation close to" it. The
 * table below is that block transcribed: two groups, fourteen entries, the order unchanged, the
 * labels unchanged, the second group titled **Administration**. The mockups' shell
 * (`ui/assets/app.js`, the `NAV` constant) prints the same fourteen in the same order, which is
 * the artefact the acceptance criterion compares against. Adding an entry here is a §38/§43
 * change and needs the spec changed first.
 *
 * ## Why `href` is nullable
 *
 * Wave 1 builds two pages inside the shell — the home chat screen at `/` (W1-UI-02, spec §19.5,
 * §45) and the agent list and creation screens under `/agents` (W1-UI-04, spec §17, §46). The
 * other eleven destinations do not exist yet. A link to a route that does not exist is exactly the
 * quiet dishonesty §43 is written against: it looks like navigation, it responds to a click, and
 * it produces a 404. So an entry with no destination carries `href: null`, and the sidebar renders
 * it as a visibly disabled row — the same `opacity` and `cursor: not-allowed` the design system
 * already uses for an option that cannot be chosen (`.choice.disabled` in `ui/assets/app.css`).
 *
 * The list of inert entries is therefore derived from this table, never asserted in prose. See
 * `navigation.test.ts`, which pins both the order and which entries resolve.
 *
 * ## Why each entry names a feature
 *
 * A workspace can switch features off (ADR-0160), and the console then hides their entries
 * (spec §44 as amended). The hiding rule reads the `feature` tag on this table through
 * `visibleNavigation`, rather than a second list that would drift from it.
 */
import { FEATURE_IDS, type FeatureId, type RouteFeature } from '@indx-workspace/contracts/features';

import type { IconName } from './icons';

interface NavItem {
  /** Stable id. Matches the mockups' `window.PAGE.nav` value for the same screen. */
  readonly id: string;
  /** The visible label. Copied from §44; do not reword. */
  readonly label: string;
  readonly icon: IconName;
  /** The feature that hides this entry when switched off, or `core` (ADR-0160 D4). */
  readonly feature: RouteFeature;
  /**
   * The route this entry navigates to, or `null` when no task has built it yet. `null` is a
   * statement that the destination is absent, and the sidebar renders it as disabled — it is
   * never a fallback for "unknown".
   */
  readonly href: string | null;
  /**
   * Shown only to a caller who may manage the workspace's storage, by the same `decide()` question
   * the page gate asks (the shell layout's `managers`); everyone else does not see the entry.
   */
  readonly managersOnly?: true;
}

export interface NavGroup {
  /** The group heading, or `null` for the unlabelled first group §44 opens with. */
  readonly label: string | null;
  readonly items: readonly NavItem[];
}

export const NAVIGATION: readonly NavGroup[] = [
  {
    label: null,
    items: [
      { id: 'home', label: 'New chat', icon: 'chat', feature: 'chat', href: '/' },
      {
        id: 'projects',
        label: 'Projects',
        icon: 'projects',
        feature: 'projects',
        href: '/projects',
      },
      { id: 'agents', label: 'Agents', icon: 'agents', feature: 'core', href: '/agents' },
      { id: 'files', label: 'Files', icon: 'files', feature: 'files', href: '/files' },
      { id: 'skills', label: 'Skills', icon: 'skills', feature: 'skills', href: '/skills' },
      {
        id: 'connectors',
        label: 'Connectors',
        icon: 'connectors',
        feature: 'connectors',
        href: '/connectors',
      },
      { id: 'runs', label: 'Runs', icon: 'runs', feature: 'runs', href: '/runs' },
    ],
  },
  {
    label: 'Administration',
    items: [
      { id: 'models', label: 'Models', icon: 'models', feature: 'core', href: '/admin/models' },
      {
        id: 'storage',
        label: 'Storage',
        icon: 'files',
        feature: 'core',
        href: '/admin/storage',
        managersOnly: true,
      },
      { id: 'users', label: 'Users', icon: 'users', feature: 'core', href: '/admin/users' },
      { id: 'apikeys', label: 'API Keys', icon: 'keys', feature: 'core', href: '/admin/api-keys' },
      {
        id: 'runtimes',
        label: 'Runtimes',
        icon: 'runtimes',
        feature: 'core',
        href: '/admin/runtimes',
      },
      {
        id: 'shares',
        label: 'Shared links',
        icon: 'share',
        feature: 'sharing',
        href: '/admin/shares',
      },
      {
        id: 'settings',
        label: 'Settings',
        icon: 'settings',
        feature: 'core',
        href: '/admin/settings',
      },
    ],
  },
];

/**
 * The navigation a workspace with `features` switched on shows: every `core` entry and every entry
 * whose feature is listed, in §44's order, without a group left empty. With every feature on (the
 * default) it is `NAVIGATION` itself. `activeNavId` and `crumbsFor` keep reading the whole table:
 * a crumb for a hidden page is harmless, and that page explains it is switched off.
 */
export function visibleNavigation(
  features: readonly FeatureId[] = FEATURE_IDS,
): readonly NavGroup[] {
  const shown = (item: NavItem) => item.feature === 'core' || features.includes(item.feature);
  return NAVIGATION.map((group) => ({ ...group, items: group.items.filter(shown) })).filter(
    (group) => group.items.length > 0,
  );
}

/**
 * `usePathname()` is typed `string`, but a component can be rendered outside a router and a
 * pathname can arrive as an empty string, so this accepts the widest input and narrows it here.
 * ADR-0015: the malformed case is rejected explicitly and by name, not left to fall through a
 * comparison that happens to be false.
 */
function normalisePathname(pathname: unknown): string | null {
  if (typeof pathname !== 'string') return null;
  if (!pathname.startsWith('/')) return null;
  const withoutQuery = pathname.split(/[?#]/u)[0] ?? '';
  if (withoutQuery === '/') return '/';
  const trimmed = withoutQuery.replace(/\/+$/u, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * The id of the entry whose route is being displayed, or `null` when the path belongs to no
 * navigation entry. `null` means "highlight nothing", which is the honest answer for a route the
 * navigation does not name — it never falls back to the first entry.
 */
export function activeNavId(pathname: unknown): string | null {
  const path = normalisePathname(pathname);
  if (path === null) return null;
  for (const group of NAVIGATION) {
    for (const item of group.items) {
      if (item.href !== null && item.href === path) return item.id;
    }
  }
  return null;
}

/**
 * The breadcrumb trail for a route, derived from the same table rather than repeated per page.
 *
 * This reproduces what the mockups declare by hand in `window.PAGE.crumbs`: a top-level screen
 * shows its own label (`home.html` → `New chat`), and an administration screen is prefixed with
 * the group heading (`api-keys.html` → `Administration / API Keys`). A path the table does not
 * name gets an empty trail — a page that needs a deeper trail than its nav entry (an agent's
 * session, a single run) renders its own, which is the case from `agent.html` onwards and which
 * no Wave 1 route reaches.
 */
export function crumbsFor(pathname: unknown): readonly string[] {
  const path = normalisePathname(pathname);
  if (path === null) return [];
  for (const group of NAVIGATION) {
    for (const item of group.items) {
      if (item.href !== null && item.href === path) {
        return group.label === null ? [item.label] : [group.label, item.label];
      }
    }
  }
  return [];
}
