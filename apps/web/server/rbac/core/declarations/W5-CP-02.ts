import type { SubResourceDeclaration } from '../declared-sub-resources';

export const subResources: readonly SubResourceDeclaration[] = [
  {
    owner: 'W5-CP-02',
    resource: 'projects',
    sub: 'sessions',
    because:
      'Section 20.5 makes membership of a session an operation on its project, so moving one inherits the project grants.',
  },
];
