import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'POST',
    path: '/api/setup',
    owner: 'W7-UI-04',
    landed: true,
    mandate: {
      section: '30',
      because: 'The first-run wizard must persist its validated configuration before sign-in.',
    },
  },
  {
    method: 'GET',
    path: '/api/setup/runtime-detect',
    owner: 'W7-UI-04',
    landed: true,
    mandate: {
      section: '30',
      because: 'The first-run Runtime step must show real host probes and disabled reasons.',
    },
  },
];
