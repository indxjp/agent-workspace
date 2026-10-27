/**
 * P8-4 · built-in search over workspace files (issue #1314, ADR-0147). Spec §34 does not print the
 * route, so it carries a `mandate` (ADR-0026) citing §16 (file management).
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'GET',
    path: '/api/files/search',
    owner: 'P8-4-FILE-SEARCH-1314',
    landed: true,
    mandate: {
      section: '16',
      because:
        'spec §16 makes files a managed workspace resource, and ADR-0147 makes finding text inside them a platform capability, so a caller reads one ranked list of passages with their paths and pages instead of downloading every file.',
    },
  },
  {
    method: 'GET',
    path: '/api/sessions/:engineSessionId/file-search',
    owner: 'P8-4-FILE-SEARCH-1314',
    landed: true,
    mandate: {
      section: '16',
      because:
        'a private runner route like the session state family: the running agent searches only the files its run was granted, so spec §16 file access reaches the agent as cited passages and not as every granted file read in full.',
    },
  },
];
