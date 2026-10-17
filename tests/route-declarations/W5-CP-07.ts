import type { RouteDeclaration } from '../inventory-support.js';
export const routes: readonly RouteDeclaration[] = [
  {
    method: 'GET',
    path: '/api/sharing-policies',
    owner: 'W5-CP-07',
    landed: true,
    mandate: { section: '20.6', because: 'Administrators need the public-sharing policy state.' },
  },
  {
    method: 'PATCH',
    path: '/api/sharing-policies',
    owner: 'W5-CP-07',
    landed: true,
    mandate: { section: '20.6', because: 'Owners can disable public sharing.' },
  },
];
