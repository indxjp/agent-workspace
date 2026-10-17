import { z } from 'zod';

import { IsoDateTimeSchema } from './identifiers.js';
import { MEMBERSHIP_ROLES, MembershipResourceSchema, type MembershipRoleName } from './team.js';

/** The longest token `POST /api/invitations/:id/accept` reads, in string code units. */
export const INVITATION_TOKEN_MAX_LENGTH = 4096;

/**
 * One row of `GET /api/invitations`, as a client is allowed to trust it.
 *
 * **There is no `token` field and no `tokenHash` field, and adding one would be the defect.** §22's
 * rule that the raw secret is shown once and only its hash is stored is enforced on the server by a
 * type with nowhere to put either; this schema is the same guarantee on the way back in. A list
 * response that carried a token would fail `.strict()` here rather than reaching a consumer.
 *
 * The four states a client shows — pending, expired, accepted, revoked — are **not** a field. The
 * wire row carries timestamps, and a consumer derives the state from them with a fixed precedence.
 *
 * `invitedBy` is a `users.id`, nullable because the directory types it so.
 */
export const InvitationResourceSchema = z
  .object({
    id: z.string().min(1),
    email: z.string().min(1),
    role: z.enum(MEMBERSHIP_ROLES),
    invitedBy: z.string().min(1).nullable(),
    expiresAt: IsoDateTimeSchema,
    acceptedAt: IsoDateTimeSchema.nullable(),
    revokedAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export type InvitationResource = z.infer<typeof InvitationResourceSchema>;

/** The body of `GET /api/invitations`. */
export const InvitationListResponseSchema = z
  .object({ invitations: z.array(InvitationResourceSchema) })
  .strict();

export type InvitationListResponse = z.infer<typeof InvitationListResponseSchema>;

/**
 * The `200` of `DELETE /api/invitations/:id`: the row with `revokedAt` set. Revocation is a
 * timestamp rather than a delete, so the route answers with the row (and answers the same way
 * for a second revoke) instead of a `204`.
 */
export const InvitationResponseSchema = z.object({ invitation: InvitationResourceSchema }).strict();

export type InvitationResponse = z.infer<typeof InvitationResponseSchema>;

/**
 * The `201` from `POST /api/invitations` and the `200` from `POST /api/invitations/:id/resend` —
 * the only two response bodies in the platform that carry an invitation's plaintext token.
 *
 * `warning` is the server's own sentence saying this is the only time the token is shown; it is
 * parsed rather than reworded so a reveal element states the guarantee the server actually made.
 * `link` is the relative `/accept-invitation?id=…&token=…` the server builds, so it carries the
 * token too: every consumer of this type must treat both fields as the secret.
 */
export const IssuedInvitationResponseSchema = z
  .object({
    invitation: InvitationResourceSchema,
    token: z.string().min(1),
    link: z.string().min(1),
    warning: z.string().min(1),
  })
  .strict();

export type IssuedInvitationResponse = z.infer<typeof IssuedInvitationResponseSchema>;

/**
 * The `200` of `POST /api/invitations/:id/accept`: the workspace the invitee just joined and the
 * membership that was created for them. This is the one response that renders the membership's
 * `principalId`. The route also sets the session cookie for that workspace, which only a
 * same-origin browser client receives.
 */
export const AcceptedInvitationResponseSchema = z
  .object({ workspaceId: z.string().min(1), membership: MembershipResourceSchema })
  .strict();

export type AcceptedInvitationResponse = z.infer<typeof AcceptedInvitationResponseSchema>;

/**
 * The body of `POST /api/invitations`: exactly these two fields — the route refuses any other
 * key as `400 invalid_field`. `role` must be one the caller may confer
 * (`403 forbidden_role_conferral`); a pending invitation to the same address is
 * `409 already_invited`.
 */
export interface CreateInvitationInput {
  readonly email: string;
  readonly role: MembershipRoleName;
}

/**
 * The body of `POST /api/invitations/:id/accept`: the plaintext token from the invitation link,
 * and nothing else. At most {@link INVITATION_TOKEN_MAX_LENGTH} code units.
 */
export interface AcceptInvitationInput {
  readonly token: string;
}
