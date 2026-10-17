import type { ScreenDeclaration } from '../inventory-support.js';

export const screens: readonly ScreenDeclaration[] = [
  {
    mockup: 'ui/models.html',
    owner: 'W4-UI-09',
    status: 'shipped',
    route: '/admin/models',
    page: 'apps/web/app/(shell)/admin/models/page.tsx',
  },
  {
    mockup: 'ui/model-add.html',
    owner: 'W4-UI-09',
    status: 'shipped',
    route: '/admin/models/new',
    page: 'apps/web/app/(shell)/admin/models/new/page.tsx',
  },
];
