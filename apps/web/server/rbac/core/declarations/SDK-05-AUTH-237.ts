import type { SubResourceDeclaration } from '../declared-sub-resources';

export const subResources: readonly SubResourceDeclaration[] = [
  {
    owner: 'SDK-05-AUTH-237',
    resource: 'agents',
    sub: 'grants',
    because:
      '§21 gives Viewer read access to agents and "Run permitted agents": GET treats the grant list as part of the parent agent row, while PUT applies the parent agent write width.',
  },
];
