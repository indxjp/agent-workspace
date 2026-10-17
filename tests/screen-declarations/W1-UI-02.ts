/**
 * W1-UI-02 · the home chat screen, from `ui/home.html` (plan §6.3, spec §19.5, §45).
 *
 * Declared here by W2-INT-00 with the rest of Wave 1's shipped surface: the screen inventory plan
 * §9.1 requires did not exist until Wave 2, so its first content is a conversion of what has
 * already landed, for the reason
 * [ADR-0025](../../docs/adr/0025-the-route-inventory-is-partitioned-by-owner.md) §4 gives about the
 * route half — a partition scheme first exercised by the tasks it was built for has been tested by
 * nobody.
 */
import type { ScreenDeclaration } from '../inventory-support.js';

export const screens: readonly ScreenDeclaration[] = [
  {
    mockup: 'ui/home.html',
    owner: 'W1-UI-02',
    status: 'shipped',
    route: '/',
    page: 'apps/web/app/(shell)/page.tsx',
  },
];
