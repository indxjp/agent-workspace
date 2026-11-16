import type { SubResourceDeclaration } from '../declared-sub-resources';

export const subResources: readonly SubResourceDeclaration[] = [
  {
    owner: 'BLD-8-AGENT-RESTORE-1851',
    resource: 'agents',
    sub: 'restore',
    because:
      '§21 gives Builder and Admin agent-management access, and a restore clears the archive mark of one agent definition the way a PATCH edits it, so it inherits the parent agent authorization: the Owner, an Admin, or the Builder who owns the agent.',
  },
];
