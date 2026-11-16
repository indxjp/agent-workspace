import type { SubResourceDeclaration } from '../declared-sub-resources';

export const subResources: readonly SubResourceDeclaration[] = [
  {
    owner: 'W4-CP-08',
    resource: 'model-connections',
    sub: 'test',
    because:
      'Section 13 makes Test Connection an operation on one saved provider connection, so it inherits the model-connections grants rather than becoming a separate resource.',
  },
];
