import type { SubResourceDeclaration } from '../declared-sub-resources';

export const subResources: readonly SubResourceDeclaration[] = [
  {
    owner: 'DJ-S1-05-AGENT-VERSIONS-443',
    resource: 'agents',
    sub: 'versions',
    because:
      '§21 gives Builder and Admin agent-management access, and ADR-0101 makes a version a numbered snapshot of the agent definition itself, so saving or listing one inherits the parent agent authorization exactly as SDK-02-AGENT-POLICY-234 declared policy does.',
  },
];
