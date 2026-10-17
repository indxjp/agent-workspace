import type { SubResourceDeclaration } from '../declared-sub-resources';

export const subResources: readonly SubResourceDeclaration[] = [
  {
    owner: 'SDK-02-AGENT-POLICY-234',
    resource: 'agents',
    sub: 'policy',
    because:
      '§21 gives Builder and Admin agent-management access, and §17 Step 4 makes the tool, skill and limit policy part of the agent definition it already governs, so it inherits the parent agent authorization exactly as W1-CP-05 declared resources does.',
  },
];
