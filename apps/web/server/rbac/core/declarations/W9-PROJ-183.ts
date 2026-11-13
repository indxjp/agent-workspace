import type { SubResourceDeclaration } from '../declared-sub-resources';

/**
 * Issue #183's two lifecycle segments under `projects`.
 *
 * Neither widens a grant: `permissions.ts`'s `POLICY` still decides who may write a project — §21
 * gives Owner "Everything" and a Builder "own" projects, and gives Admin and Viewer no project
 * clause at all. These entries only say where the segments belong, so `decide()` reads
 * `POST /api/projects/:id/archive` as a write **on that project** instead of refusing it as an
 * unclassified sub-resource.
 */
export const subResources: readonly SubResourceDeclaration[] = [
  {
    owner: 'W9-PROJ-183',
    resource: 'projects',
    sub: 'archive',
    because:
      'Section 20.5 makes a project the owner of its own contents and lifecycle, so retiring one is a write on that project rather than an operation on a resource of its own.',
  },
  {
    owner: 'W9-PROJ-183',
    resource: 'projects',
    sub: 'restore',
    because:
      'The inverse transition of the same lifecycle, so it inherits the same project grants as archive rather than being classified separately.',
  },
];
