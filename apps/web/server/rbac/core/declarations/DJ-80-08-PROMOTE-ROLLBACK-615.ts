import type { SubResourceDeclaration } from '../declared-sub-resources';

export const subResources: readonly SubResourceDeclaration[] = [
  {
    owner: 'DJ-80-08-PROMOTE-ROLLBACK-615',
    resource: 'agents',
    sub: 'promote',
    because:
      '§21 gives Builder and Admin agent-management access, and a promote points the production environment at a saved version of the agent definition, the same pointer move DJ-S1-06-AGENT-POINTERS-444 declared, so it inherits the parent agent authorization exactly as pointers do.',
  },
  {
    owner: 'DJ-80-08-PROMOTE-ROLLBACK-615',
    resource: 'agents',
    sub: 'rollback',
    because:
      '§21 gives Builder and Admin agent-management access, and a rollback points an environment back at a saved version of the agent definition it pointed at before, the same pointer move DJ-S1-06-AGENT-POINTERS-444 declared, so it inherits the parent agent authorization exactly as pointers do.',
  },
];
