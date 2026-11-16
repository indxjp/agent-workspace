import type { RouteFeature } from '@indx-workspace/contracts/features';

/** One entry of the portal's navigation. */
export interface PortalNavItem {
  /** The key of its label in `strings.nav`. */
  readonly id: 'home' | 'chat' | 'files' | 'runs' | 'recipes';
  readonly href: string;
  /** The workspace feature the page needs, or `core`: an entry can be hidden when it is off. */
  readonly feature: RouteFeature;
}

export const nav: readonly PortalNavItem[] = [
  { id: 'home', href: '/', feature: 'core' },
  { id: 'chat', href: '/chat', feature: 'chat' },
  { id: 'files', href: '/files', feature: 'files' },
  { id: 'runs', href: '/runs', feature: 'runs' },
  { id: 'recipes', href: '/recipes', feature: 'runs' },
];

/** Where a person signs in, and the route a sign-out form posts to (issue #1510). */
export const account = { signIn: '/sign-in', signOut: '/api/sign-out' } as const;
