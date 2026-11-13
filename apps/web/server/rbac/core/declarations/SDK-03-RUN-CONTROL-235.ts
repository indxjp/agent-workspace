import type { SubResourceDeclaration } from '../declared-sub-resources';

export const subResources: readonly SubResourceDeclaration[] = [
  {
    owner: 'SDK-03-RUN-CONTROL-235',
    resource: 'runs',
    sub: 'interrupt',
    because:
      '§21 names stopping a run you started as part of running it — Builder "Create/edit/run agents" and Viewer "Run permitted agents" both use "run" for the same verb `parseOperation` already reads a run-starting POST as, so an interrupt is that verb and not a write.',
  },
  {
    owner: 'SDK-03-RUN-CONTROL-235',
    resource: 'runs',
    sub: 'revoke-tokens',
    because:
      'the rename of the existing `POST /api/runs/:id` (W1-CP-04, spec §24) to a named path: the capability and its role gate are unchanged, so the new path inherits the same parent classification the old one always had.',
  },
];
