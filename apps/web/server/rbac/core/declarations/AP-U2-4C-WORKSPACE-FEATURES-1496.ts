import type { SubResourceDeclaration } from '../declared-sub-resources';

export const subResources: readonly SubResourceDeclaration[] = [
  {
    owner: 'AP-U2-4C-WORKSPACE-FEATURES-1496',
    resource: 'workspaces',
    sub: 'features',
    because:
      '§21 Owner — workspace settings; a member may read which features are on. The switches inherit `workspaces` member-scoped grant (ADR-0160 D6): the resolvers in `server/workspaces/access.ts` let any member read and only the Owner write.',
  },
];
