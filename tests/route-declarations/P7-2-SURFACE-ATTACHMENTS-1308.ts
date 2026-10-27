/**
 * P7-2 · `POST /api/sessions/:engineSessionId/attachments` — issue #1308 (ADR-0146 Decision 6): a
 * surface visitor's browser token uploads one file into its own session. Spec §34 prints neither
 * the route nor an upload, so it carries a `mandate` (ADR-0026) citing §16 (file management).
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'POST',
    path: '/api/sessions/:engineSessionId/attachments',
    owner: 'P7-2-SURFACE-ATTACHMENTS-1308',
    landed: true,
    mandate: {
      section: '16',
      because:
        'A surface visitor must hand a file to a run without a workspace-wide file write; the route stores one file under the reserved .attachments/<sessionId>/ prefix and returns its fileId.',
    },
  },
];
