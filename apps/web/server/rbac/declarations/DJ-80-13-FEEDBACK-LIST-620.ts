import type { SubResourceDeclaration } from '../declared-sub-resources';

export const subResources: readonly SubResourceDeclaration[] = [
  {
    owner: 'DJ-80-13-FEEDBACK-LIST-620',
    resource: 'agents',
    sub: 'feedback',
    because:
      '§21 lets every role read the agents of its workspace, and the ratings of an agent’s runs are read to improve that agent definition, so the list is a read of the agent; the handler then narrows the rows to the runs the caller’s own `runs` grant reads, exactly as `GET /api/runs` does.',
  },
];
