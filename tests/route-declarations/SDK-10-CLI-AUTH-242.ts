/**
 * SDK-10-CLI-AUTH-242 · `aw login` as a person (S-22) — issue #242, ADR-0083.
 *
 * An OAuth 2.0 device authorization grant (RFC 8628) under `/api/auth/cli`: start, the approval
 * page and its form, the token poll and sign-out, and the workspace switch. None is printed in spec
 * §34, so each carries a mandate; `/api/auth/*` passes `routeShape` through the exception
 * `W9-AUTH-118` already relies on.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'POST',
    path: '/api/auth/cli-device',
    owner: 'SDK-10-CLI-AUTH-242',
    landed: true,
    mandate: {
      section: '21',
      because:
        'Section 21 makes a person a member of a workspace; this starts the terminal sign-in that proves one.',
    },
  },
  {
    method: 'GET',
    path: '/api/auth/cli-verify',
    owner: 'SDK-10-CLI-AUTH-242',
    landed: true,
    mandate: {
      section: '21',
      because:
        'The signed-in person (section 21) sees the code their terminal printed before approving it.',
    },
  },
  {
    method: 'POST',
    path: '/api/auth/cli-verify',
    owner: 'SDK-10-CLI-AUTH-242',
    landed: true,
    mandate: {
      section: '21',
      because:
        'The signed-in person (section 21) approves or denies a terminal sign-in as themselves.',
    },
  },
  {
    method: 'POST',
    path: '/api/auth/cli-token',
    owner: 'SDK-10-CLI-AUTH-242',
    landed: true,
    mandate: {
      section: '21',
      because:
        'The terminal receives a short-lived token for the approving member (section 21), once.',
    },
  },
  {
    method: 'DELETE',
    path: '/api/auth/cli-token',
    owner: 'SDK-10-CLI-AUTH-242',
    landed: true,
    mandate: {
      section: '21',
      because: 'A member (section 21) signs the terminal out, revoking its token.',
    },
  },
  {
    method: 'POST',
    path: '/api/auth/cli-workspace',
    owner: 'SDK-10-CLI-AUTH-242',
    landed: true,
    mandate: {
      section: '21',
      because:
        'A user belongs to workspaces with a role in each (section 21); the terminal picks which.',
    },
  },
];
