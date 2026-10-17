/**
 * W2-UI-10 · Connectors and the connector wizard, from `ui/connectors.html` and
 * `ui/connector-new.html` (the Wave 2 plan §2c, spec §8).
 *
 * Seeded by W2-INT-00 as `planned` into this task's own file — see
 * `tests/screen-declarations/W2-UI-08.ts` for why the deferral lives here.
 */
import type { ScreenDeclaration } from '../inventory-support.js';

export const screens: readonly ScreenDeclaration[] = [
  {
    mockup: 'ui/connectors.html',
    owner: 'W2-UI-10',
    status: 'shipped',
    route: '/connectors',
    page: 'apps/web/app/(shell)/connectors/page.tsx',
  },
  {
    mockup: 'ui/connector-new.html',
    owner: 'W2-UI-10',
    status: 'shipped',
    route: '/connectors/new',
    page: 'apps/web/app/(shell)/connectors/new/page.tsx',
  },
];
