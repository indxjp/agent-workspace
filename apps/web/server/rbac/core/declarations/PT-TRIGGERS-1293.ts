import type { SubResourceDeclaration } from '../declared-sub-resources';

export const subResources: readonly SubResourceDeclaration[] = [
  {
    owner: 'PT-TRIGGERS-1293',
    resource: 'triggers',
    sub: 'secret',
    because:
      'rotating the URL secret of a trigger is a write on that trigger, the same §21 width as editing it (ADR-0144): Owner and Admin "Everything"/"API keys", Builder only for a trigger it owns.',
  },
];
