/**
 * W2-UI-11 · Admin — Users, API keys and Settings, from `ui/users.html`, `ui/api-keys.html` and
 * `ui/settings.html` (the Wave 2 plan §2c, spec §21, §22).
 *
 * Seeded by W2-INT-00 as `planned` into this task's own file — see
 * `tests/screen-declarations/W2-UI-08.ts` for why the deferral lives here.
 */
import type { ScreenDeclaration } from '../inventory-support.js';

export const screens: readonly ScreenDeclaration[] = [
  {
    mockup: 'ui/users.html',
    owner: 'W2-UI-11',
    status: 'shipped',
    route: '/admin/users',
    page: 'apps/web/app/(shell)/admin/users/page.tsx',
  },
  {
    mockup: 'ui/api-keys.html',
    owner: 'W2-UI-11',
    status: 'shipped',
    route: '/admin/api-keys',
    page: 'apps/web/app/(shell)/admin/api-keys/page.tsx',
  },
  {
    mockup: 'ui/settings.html',
    owner: 'W2-UI-11',
    status: 'shipped',
    route: '/admin/settings',
    page: 'apps/web/app/(shell)/admin/settings/page.tsx',
  },
];
