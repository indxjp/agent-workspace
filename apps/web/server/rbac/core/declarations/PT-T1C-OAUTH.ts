import type { SubResourceDeclaration } from '../declared-sub-resources';

export const subResources: readonly SubResourceDeclaration[] = [
  {
    owner: 'PT-T1C-OAUTH',
    resource: 'endpoint-clients',
    sub: 'secret',
    because:
      'rotating the OAuth client secret of an endpoint client is a write on that client, the same §21 width as editing it (ADR-0134 part 3): Owner and Admin "Everything"/"API keys", Builder only for a client it created.',
  },
];
