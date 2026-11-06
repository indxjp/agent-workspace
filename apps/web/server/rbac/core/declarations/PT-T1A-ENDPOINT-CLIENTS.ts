import type { SubResourceDeclaration } from '../declared-sub-resources';

export const subResources: readonly SubResourceDeclaration[] = [
  {
    owner: 'PT-T1A-ENDPOINT-CLIENTS',
    resource: 'endpoint-clients',
    sub: 'keys',
    because:
      'minting an endpoint-scoped API key for a client is a write on that client, the same §21 width as editing it (ADR-0134): Owner and Admin "Everything"/"API keys", Builder only for a client it created.',
  },
];
