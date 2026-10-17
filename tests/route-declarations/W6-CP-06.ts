import type { RouteDeclaration } from '../inventory-support.js';
export const routes: readonly RouteDeclaration[] = [
  {
    method: 'GET',
    path: '/api/metrics',
    owner: 'W6-CP-06',
    landed: true,
    mandate: { section: '35', because: 'The minimal Runs list reads status, duration and cost.' },
  },
];
