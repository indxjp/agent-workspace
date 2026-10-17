import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'GET',
    path: '/api/agents/:id/grants',
    owner: 'SDK-05-AUTH-237',
    landed: true,
    mandate: {
      section: '21',
      because:
        '§21 permits a Viewer to run explicitly permitted agents; reading the complete grant set is how an authorised agent editor manages that permission.',
    },
  },
  {
    method: 'PUT',
    path: '/api/agents/:id/grants',
    owner: 'SDK-05-AUTH-237',
    landed: true,
    mandate: {
      section: '21',
      because:
        '§21 permits a Viewer to run explicitly permitted agents; replacing the complete grant set is the control-plane operation that makes the permission explicit and revocable.',
    },
  },
];
