/**
 * P8-4 · the `file-search` sub segment of `/api/sessions/:engineSessionId` — spec §16, §21 · #1314.
 *
 * Declared for the reason `W2-CP-07.ts` beside this file records: `decide()` refuses a sub segment
 * nobody has classified. The route is private to a run (a runner principal only), so §21's roles
 * never reach it; the declaration is what lets the authorisation matrix classify it.
 */
import type { SubResourceDeclaration } from '../declared-sub-resources';

export const subResources: readonly SubResourceDeclaration[] = [
  {
    owner: 'P8-4-FILE-SEARCH-1314',
    resource: 'sessions',
    sub: 'file-search',
    because:
      "§21 Viewer — \"view their own sessions\". A run's search over the files it was granted is the session reading its own files, answered as cited passages; §16's files stay a separate resource with their own grants, and the route confines the answer to the run's own grant snapshot.",
  },
];
