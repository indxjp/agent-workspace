/**
 * W1-COMP-01 · sign-in, from `ui/login.html` (spec §21).
 *
 * It lives outside the shell group and outside `/api/`, which is
 * `docs/adr/W1-COMP-01-sign-in-is-a-screen-not-a-route.md`: *"Sign-in is a screen with a server
 * action, not a route handler"*. That is why it appears in this inventory and not in the route
 * inventory, and why the two gates disagreeing about it would be a real finding rather than a
 * bookkeeping mismatch.
 */
import type { ScreenDeclaration } from '../inventory-support.js';

export const screens: readonly ScreenDeclaration[] = [
  {
    mockup: 'ui/login.html',
    owner: 'W1-COMP-01',
    status: 'shipped',
    route: '/signin',
    page: 'apps/web/app/signin/page.tsx',
  },
];
