import type { SubResourceDeclaration } from '../declared-sub-resources';

/**
 * Issue #121's `invitations` sub-resources.
 *
 * `resend` is declared here: `POST /api/invitations/:id/resend` goes through the ordinary
 * `authorise()`/`decide()` gate, at the same width as every other write on `invitations`
 * (`permissions.ts`'s `MANAGE` for Admin, `EVERYTHING`'s fallback for Owner, `NOTHING` for Builder
 * and Viewer) — resending is administering the invitation row, not accepting it.
 *
 * `accept` is deliberately **not** declared here. A new invitee cannot yet have a tenant session;
 * the exact acceptance POST instead verifies the dedicated signed OIDC identity cookie that carries
 * no workspace or role. `decide()` cannot express that identity-only proof without granting the
 * other invitation writes to every role. `authorisation-matrix.test.ts` therefore records accept in
 * `IDENTITY_ONLY_ROUTES`, distinctly from routes that require no identity proof.
 * Leaving `accept` unclassified means mistakenly routing it through `authorise()` gets a hard
 * refusal rather than silently inheriting Owner/Admin-only invitation administration.
 */
export const subResources: readonly SubResourceDeclaration[] = [
  {
    owner: 'W9-TEAM-121',
    resource: 'invitations',
    sub: 'resend',
    because:
      "Issue #121: resending a pending invitation — minting a fresh token and expiry for the same row — is administering the invitation, the same operation `PATCH /api/memberships/:id` is for a membership. It inherits `invitations`' own grants rather than becoming a separate resource.",
  },
];
