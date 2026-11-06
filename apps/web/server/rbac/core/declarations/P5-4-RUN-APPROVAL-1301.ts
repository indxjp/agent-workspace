import type { SubResourceDeclaration } from '../declared-sub-resources';

export const subResources: readonly SubResourceDeclaration[] = [
  {
    owner: 'P5-4-RUN-APPROVAL-1301',
    resource: 'runs',
    sub: 'approval',
    because:
      'deciding the tool call a paused run waits on is how that run continues, the same §21 verb as `interrupt` (SDK-03-RUN-CONTROL-235): Builder "Create/edit/run agents" and Viewer "Run permitted agents" both reach it for their own runs, so `parseOperation` reads its POST as `run`, not a write. A browser token scope never reaches it (ADR-0145 D2.2 defers visitor approval).',
  },
];
