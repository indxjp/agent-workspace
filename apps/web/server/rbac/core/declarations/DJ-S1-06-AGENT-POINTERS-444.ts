import type { SubResourceDeclaration } from '../declared-sub-resources';

export const subResources: readonly SubResourceDeclaration[] = [
  {
    owner: 'DJ-S1-06-AGENT-POINTERS-444',
    resource: 'agents',
    sub: 'pointers',
    because:
      '§21 gives Builder and Admin agent-management access, and ADR-0101 makes an environment pointer the choice of which saved version of the agent definition runs, so moving one rewrites the agent itself and inherits the parent agent authorization exactly as DJ-S1-05-AGENT-VERSIONS-443 declared versions do.',
  },
];
