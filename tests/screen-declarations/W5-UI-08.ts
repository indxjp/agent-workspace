import type { ScreenDeclaration } from '../inventory-support.js';
export const screens: readonly ScreenDeclaration[] = [
  {
    mockup: 'ui/projects.html',
    owner: 'W5-UI-08',
    status: 'shipped',
    route: '/projects',
    page: 'apps/web/app/(shell)/projects/page.tsx',
  },
  {
    mockup: 'ui/project.html',
    owner: 'W5-UI-08',
    status: 'shipped',
    route: '/projects/:id',
    page: 'apps/web/app/(shell)/projects/[id]/page.tsx',
  },
];
