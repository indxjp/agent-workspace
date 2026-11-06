import type { SubResourceDeclaration } from '../declared-sub-resources';

export const subResources: readonly SubResourceDeclaration[] = [
  {
    owner: 'W9-PROV-126',
    resource: 'model-connections',
    sub: 'credential',
    because:
      'Issue #126 makes credential rotation a write-only operation on one saved provider connection, the same relationship W4-CP-08 already established for "test" under this resource, so it inherits the model-connections grants rather than becoming a separate resource.',
  },
];
