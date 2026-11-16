import type { SubResourceDeclaration } from '../declared-sub-resources';

export const subResources: readonly SubResourceDeclaration[] = [
  {
    owner: 'P7-2-SURFACE-ATTACHMENTS-1308',
    resource: 'sessions',
    sub: 'attachments',
    because:
      '§21 Builder — "share own agents, projects and sessions" — and Viewer — "view their own sessions". A file handed to a session is stored in that session and is read back only through it, so uploading one is writing the session; §21 gives no separate capability over it, and the own-row grant is what `sessions` already carries.',
  },
];
