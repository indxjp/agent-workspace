import { z } from 'zod';

import { FeatureIdSchema } from './features.js';
import { IsoDateTimeSchema, UuidSchema } from './identifiers.js';

/**
 * Spec §21's four roles, as the membership wire spells them.
 *
 * Written here rather than imported from the server's RBAC module because a wire contract may
 * not depend on the decision table. The duplication is gated rather than commented:
 * `apps/web/contracts/team.test.ts` asserts this tuple equals the server's `ROLES` both as a
 * value and as a type, so the two lists cannot drift silently.
 */
export const MEMBERSHIP_ROLES = ['owner', 'admin', 'builder', 'viewer'] as const;

/** One of §21's four roles. */
export type MembershipRoleName = (typeof MEMBERSHIP_ROLES)[number];

/** The bounds the user and membership routes apply to their string fields. */
export const USER_EMAIL_MAX_LENGTH = 320;
export const USER_NAME_MAX_LENGTH = 200;

/**
 * The two durable identities a credential resolves to, as the wire spells them.
 *
 * The server's own `PrincipalKind` (`apps/web/server/rbac/principal.ts`) writes the second one
 * `api_key`, because that is the value stored in `workspace_principals.kind` under a CHECK
 * constraint — renaming it would be a data migration. Every enum this package publishes is
 * kebab-case (`connectors.ts` already prints the literal `'api-key'`), so the wire keeps the
 * kebab-case spelling and the server maps `api_key → api-key` at the edge. The correspondence is
 * gated rather than commented: `apps/web/server/sdk-conformance.test.ts` asserts the two
 * vocabularies stay in step, so neither can gain or rename a member alone.
 */
export const PRINCIPAL_KINDS = ['membership', 'api-key'] as const;

/** One of the two principal kinds the RBAC layer distinguishes. */
export type PrincipalKindName = (typeof PRINCIPAL_KINDS)[number];

/**
 * The body of `GET /api/me`: the principal the presented credential resolves to, and nothing
 * else — no key hash, no key prefix, no session id, no `via`, no `actor`, no `apiKeyId`.
 *
 * `userId` is `null` for exactly an API-key principal: a key is a workspace-local machine
 * identity with no `users` row behind it, while a membership principal always names one. `label`
 * is display attribution — the member's name or the key's name — and is never an authorization
 * input; `principalId` is the `workspace_principals.id` every `ownerPrincipalId` compares against.
 *
 * `features` is the set switched on for `workspaceId` (ADR-0160 D8): installed in the deployment
 * and not switched off by the workspace's Owner, in `FEATURE_IDS` order.
 *
 * A revoked key or an expired session never reaches this shape: it is `401 unauthenticated` in
 * the standard `{ error: { code, message } }` envelope, never a `200` carrying a stale principal.
 */
export const MeResponseSchema = z
  .object({
    principalId: z.string().min(1),
    kind: z.enum(PRINCIPAL_KINDS),
    role: z.enum(MEMBERSHIP_ROLES),
    workspaceId: z.string().min(1),
    userId: z.string().min(1).nullable(),
    label: z.string().min(1),
    features: z.array(FeatureIdSchema),
  })
  .strict();

export type MeResponse = z.infer<typeof MeResponseSchema>;

/**
 * One row of `GET /api/memberships`, as a client is allowed to trust it: nothing is read off this
 * response before it has been checked here.
 *
 * `name` is the stored `users.name`, never derived from the address. `createdAt` is when the
 * membership was created, which is the join date a members table shows.
 *
 * `principalId` is the `workspace_principals.id` this membership backs — the identifier every
 * `ownerPrincipalId` on an agent, project or session compares against.
 */
export const MembershipResourceSchema = z
  .object({
    id: z.string().min(1),
    principalId: UuidSchema,
    userId: z.string().min(1),
    email: z.string().min(1),
    name: z.string().min(1),
    role: z.enum(MEMBERSHIP_ROLES),
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export type MembershipResource = z.infer<typeof MembershipResourceSchema>;

/** The body of `GET /api/memberships`. */
export const MembershipListResponseSchema = z
  .object({ memberships: z.array(MembershipResourceSchema) })
  .strict();

export type MembershipListResponse = z.infer<typeof MembershipListResponseSchema>;

/** The `201` of `POST /api/memberships` and the `200` of `PATCH /api/memberships/:id`. */
export const MembershipResponseSchema = z.object({ membership: MembershipResourceSchema }).strict();

export type MembershipResponse = z.infer<typeof MembershipResponseSchema>;

/**
 * One row of `GET /api/users`: the global user behind a membership of the caller's workspace.
 * `createdAt` is when the user account was created, not when it joined this workspace.
 */
export const UserResourceSchema = z
  .object({
    id: z.string().min(1),
    email: z.string().min(1),
    name: z.string().min(1),
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export type UserResource = z.infer<typeof UserResourceSchema>;

/** The body of `GET /api/users`. */
export const UserListResponseSchema = z.object({ users: z.array(UserResourceSchema) }).strict();

export type UserListResponse = z.infer<typeof UserListResponseSchema>;

/**
 * The `201` of `POST /api/users`: the user that was created (or already existed globally) and the
 * membership that attached it to the caller's workspace, in one transaction.
 */
export const CreatedUserResponseSchema = z
  .object({ user: UserResourceSchema, membership: MembershipResourceSchema })
  .strict();

export type CreatedUserResponse = z.infer<typeof CreatedUserResponseSchema>;

/**
 * The body of `POST /api/memberships`: attach a user that already exists to the workspace.
 * `email` is lower-cased by the server and must name an existing user (`404 no_such_user`);
 * `role` must be one the caller may confer (`403 forbidden_role_conferral`). A user that is
 * already a member is `409 already_a_member`.
 */
export interface AddMemberInput {
  readonly email: string;
  readonly role: MembershipRoleName;
}

/** The body of `PATCH /api/memberships/:id`: the new role, and nothing else. */
export interface ChangeMembershipRoleInput {
  readonly role: MembershipRoleName;
}

/**
 * The body of `POST /api/users`: create the global user (or reuse an existing one) and make it a
 * member of the caller's workspace. `name` is trimmed and at most {@link USER_NAME_MAX_LENGTH}
 * characters; `email` at most {@link USER_EMAIL_MAX_LENGTH}. An address that already belongs to
 * the workspace is `409 email_taken`.
 */
export interface CreateUserInput {
  readonly email: string;
  readonly name: string;
  readonly role: MembershipRoleName;
}
