import type { SubResourceDeclaration } from '../declared-sub-resources';

export const subResources: readonly SubResourceDeclaration[] = [
  {
    owner: 'SDK-19-SKILL-REVISIONS-251',
    resource: 'skills',
    sub: 'revisions',
    because:
      '§21 lets a Builder change a skill they own and an Admin any skill, and publishing a revision freezes that same skill content, so it inherits the parent skill update grant exactly as PATCH does.',
  },
];
