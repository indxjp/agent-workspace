/**
 * W2-UI-09 · Skills and skill detail, from `ui/skills.html` and `ui/skill.html`
 * (the Wave 2 plan §2c, spec §7).
 *
 * Seeded by W2-INT-00 as `planned` into this task's own file — see
 * `tests/screen-declarations/W2-UI-08.ts` for why the deferral lives here rather than in the
 * inventory's own declaration file.
 */
import type { ScreenDeclaration } from '../inventory-support.js';

export const screens: readonly ScreenDeclaration[] = [
  {
    mockup: 'ui/skills.html',
    owner: 'W2-UI-09',
    status: 'shipped',
    route: '/skills',
    page: 'apps/web/app/(shell)/skills/page.tsx',
  },
  {
    mockup: 'ui/skill.html',
    owner: 'W2-UI-09',
    status: 'shipped',
    route: '/skills/:name',
    page: 'apps/web/app/(shell)/skills/[name]/page.tsx',
  },
];
