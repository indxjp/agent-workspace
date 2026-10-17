import type { ScreenDeclaration } from '../inventory-support.js';
export const screens: readonly ScreenDeclaration[] = [
  {
    mockup: 'ui/public-run.html',
    owner: 'W5-CP-06',
    status: 'shipped',
    route: '/p/:token',
    page: 'apps/web/app/p/[token]/page.tsx',
  },
  {
    mockup: 'ui/public-agent.html',
    owner: 'W5-CP-06',
    status: 'shipped',
    route: '/p/:token',
    page: 'apps/web/app/p/[token]/page.tsx',
  },
];
