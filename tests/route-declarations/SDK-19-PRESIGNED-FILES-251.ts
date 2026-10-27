/**
 * SDK-19 · presigned file transfer (issue #251, N-4). Spec §34 prints neither route, so each carries
 * a `mandate` (ADR-0026) citing §16 (file management); the SDK specification's §5.6 and §8 N-4 row
 * are the design this implements.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'POST',
    path: '/api/files/:id/upload-urls',
    owner: 'SDK-19-PRESIGNED-FILES-251',
    landed: true,
    mandate: {
      section: '16',
      because:
        'A browser-token holder must upload a session file without the control plane relaying the bytes; the route signs a short-lived PUT on the object store.',
    },
  },
  {
    method: 'POST',
    path: '/api/files/:id/upload-complete',
    owner: 'SDK-19-PRESIGNED-FILES-251',
    landed: true,
    mandate: {
      section: '16',
      because:
        'A signed-link upload is only a file once the control plane has checked the object the PUT wrote; the route verifies its size and marks the pending row ready.',
    },
  },
  {
    method: 'POST',
    path: '/api/files/:id/download-urls',
    owner: 'SDK-19-PRESIGNED-FILES-251',
    landed: true,
    mandate: {
      section: '16',
      because:
        'A browser-token holder must read a session file without the control plane relaying the bytes; the route signs a short-lived GET on the object store.',
    },
  },
];
