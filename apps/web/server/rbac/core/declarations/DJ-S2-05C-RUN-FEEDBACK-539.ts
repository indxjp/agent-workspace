import type { SubResourceDeclaration } from '../declared-sub-resources';

export const subResources: readonly SubResourceDeclaration[] = [
  {
    owner: 'DJ-S2-05C-RUN-FEEDBACK-539',
    resource: 'runs',
    sub: 'feedback',
    because:
      'rating the answer a run gave you is part of running it, the same §21 verb as `interrupt` (SDK-03-RUN-CONTROL-235): Builder "Create/edit/run agents" and Viewer "Run permitted agents" both reach it for their own runs, so `parseOperation` reads its POST as `run`, not a write.',
  },
];
