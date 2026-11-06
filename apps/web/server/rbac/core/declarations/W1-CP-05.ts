import type { SubResourceDeclaration } from '../declared-sub-resources';

export const subResources: readonly SubResourceDeclaration[] = [
  {
    owner: 'W1-CP-05',
    resource: 'agents',
    sub: 'resources',
    because:
      '§21 gives Builder and Admin agent-management access; §17 Step 3 makes resource assignments part of the agent definition, so they inherit the parent agent authorization.',
  },
];
