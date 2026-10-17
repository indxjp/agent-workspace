/**
 * The port between RBAC/invitation routes and the rows spec §27 names: `users`, `memberships`,
 * `api_keys`, plus issue #121's `invitations`.
 *
 * ## Why this stays a port
 *
 * The durable implementation lives in `packages/core/src/db/repositories/directory.ts` and is
 * adapted in `postgres-directory.ts`. Routes still depend on this interface so browser delivery
 * concerns do not acquire a queryable database handle, and fast unit tests can exercise the same
 * contract through `memory-directory.ts`.
 *
 * The port is shaped exactly like the repository layer's — a record type, a discriminated outcome
 * union with one member per correction the caller can make, and no workspace-scoped method that
 * takes a workspace id, because the workspace is fixed when the directory is opened.
 *
 * ## The one method that is not workspace-scoped, and why
 *
 * {@link DirectoryRoot.authenticateApiKey}. A presented key names no workspace: the workspace is
 * what the lookup *establishes*. `api_keys.key_hash` is globally unique for this reason
 * (`packages/core/src/db/schema/api-keys.ts`), and the same exception is already made in the
 * repository layer for `findRunWorkspace`. It returns the workspace and the role and no row
 * content beyond them.
 */
import type { ConferredRole } from './conferral';
import type { Role } from './roles';
import type { TokenScope } from './token-scope';

/** A `users` row, as an API response may see it. */
export interface UserSummary {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly createdAt: string;
}

/** A `memberships` row joined to the user it names. */
export interface MembershipSummary {
  readonly id: string;
  /** The exact WorkspacePrincipal backed by this Membership. */
  readonly principalId: string;
  readonly userId: string;
  readonly email: string;
  /**
   * The stored `users.name`, joined in, so a member list can show a profile name from this response
   * alone. No layer between the row and this field derives the value from the email — but the
   * stored name itself can still be an address local part: `defaultDisplayName` seeds it that way
   * for a user created by invitation acceptance (`packages/core/src/db/repositories/directory.ts`,
   * and the memory substitute), and it reads that way until the invitee edits their profile.
   * `users.name` is `notNull` and not blank, so this is never `null` or `''`.
   */
  readonly name: string;
  readonly role: Role;
  readonly createdAt: string;
}

/**
 * An `api_keys` row, as an API response may see it.
 *
 * There is no `keyHash` field and no `key` field, and that is the point of the type rather than an
 * omission: §22 says *"Show the raw secret only once"*, so the shape a list route can return is
 * one that has nowhere to put a secret. `keyPrefix` is the displayable head — `ak_live_<key_id>` —
 * which R-12 §1.4 keeps in clear precisely so that a key can be named after its secret is gone.
 */
export interface ApiKeySummary {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
  readonly keyPrefix: string;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

/**
 * The stored form of an API key, hash included.
 *
 * Nothing outside a test and the authenticator reads this. It exists as a named type so that
 * `api-keys.test.ts` can read a row back and assert, against the row this program actually
 * stored, that the plaintext is not in it — which is the half of the acceptance criterion that a
 * response-body scan cannot prove.
 */
export interface StoredApiKey extends ApiKeySummary {
  readonly workspaceId: string;
  /** Lower-case hex SHA-256 of the secret half. Never the secret. */
  readonly keyHash: string;
  /** The public half, in clear. Never enough to authenticate. */
  readonly keyId: string;
}

/**
 * What `POST /api/users` was given.
 *
 * `role` is a {@link ConferredRole}, not a `Role`. That is the whole enforcement of *"a caller may
 * never grant a role it does not itself hold"*: the only thing in the program that produces one is
 * `conferRole`, which needs the caller's own role, so a route that took a role from a request body
 * and reached this input without asking cannot compile. See `conferral.ts`.
 */
export interface CreateUserInput {
  readonly email: string;
  readonly name: string;
  readonly role: ConferredRole;
}

/** What `POST /api/memberships` was given. `role` is conferred, not merely parsed. */
export interface CreateMembershipInput {
  readonly email: string;
  readonly role: ConferredRole;
}

/** What `POST /api/api-keys` was given. */
export interface CreateApiKeyInput {
  readonly name: string;
  readonly role: ConferredRole;
  /** ISO-8601, or `null` for a key that does not expire (§22's nullable `expires_at`). */
  readonly expiresAt: string | null;
}

/** Creating a user, and every correction the caller can make. */
export type CreateUserOutcome =
  | { readonly kind: 'created'; readonly user: UserSummary; readonly membership: MembershipSummary }
  | { readonly kind: 'email-taken'; readonly email: string };

/** Creating a membership. */
export type CreateMembershipOutcome =
  | { readonly kind: 'created'; readonly membership: MembershipSummary }
  | { readonly kind: 'no-such-user'; readonly email: string }
  | { readonly kind: 'already-a-member'; readonly email: string };

/** Changing or removing a membership. */
export type MembershipChangeOutcome =
  | { readonly kind: 'changed'; readonly membership: MembershipSummary }
  | { readonly kind: 'no-such-membership'; readonly id: string }
  | {
      /**
       * §21 makes Owner the role that can do everything, so a workspace with no Owner is a
       * workspace nobody can administer. Removing or demoting the last one is refused rather than
       * performed and regretted.
       */
      readonly kind: 'last-owner';
      readonly id: string;
    };

/** Removing a membership. */
export type DeleteMembershipOutcome =
  | { readonly kind: 'deleted'; readonly id: string }
  | { readonly kind: 'no-such-membership'; readonly id: string }
  | { readonly kind: 'last-owner'; readonly id: string }
  | {
      /** RF-202 owns reassignment policy; until then, exact ownership makes removal unsafe. */
      readonly kind: 'membership-in-use';
      readonly id: string;
      readonly dependency: 'projects' | 'local-runtime-keys';
    };

/**
 * Creating an API key. `presented` is the whole key and exists in this object and in the `201`
 * response body, and nowhere else in the program — not in the store, not in a log line.
 */
export type CreateApiKeyOutcome =
  | { readonly kind: 'created'; readonly key: ApiKeySummary; readonly presented: string }
  | { readonly kind: 'name-taken'; readonly name: string }
  | { readonly kind: 'expiry-in-the-past'; readonly expiresAt: string };

/** Revoking an API key. Revocation is a timestamp, not a delete: §22 lists `revoked_at`. */
export type RevokeApiKeyOutcome =
  | {
      readonly kind: 'revoked';
      readonly key: ApiKeySummary;
      /** The `mcp-project` endpoint client the key was scoped to, whose tool sandbox it kept open. */
      readonly mcpProjectClientId: string | null;
    }
  | { readonly kind: 'no-such-key'; readonly id: string }
  | { readonly kind: 'already-revoked'; readonly key: ApiKeySummary };

/** The non-secret identity and display attribution a presented API key establishes. */
export interface ApiKeyIdentity {
  /** The exact WorkspacePrincipal backed by this API key. */
  readonly principalId: string;
  readonly apiKeyId: string;
  readonly workspaceId: string;
  readonly role: Role;
  /** Stable display attribution from the stored key name. Never credential material. */
  readonly label: string;
  /**
   * The membership principal this key acts for, or `null` for a key that owns what it writes.
   * Only the per-run local runtime key sets it (issue #509, S1-24); `Principal.fromApiKey` makes
   * it the caller's `ownerPrincipalId`. Absent means `null`: every directory implementation sets
   * it, and the many hand-built hosted-key fixtures need not spell out the hosted default.
   */
  readonly actsForPrincipalId?: string | null;
  /**
   * The endpoint scope of a key bound to an endpoint client (ADR-0134), or `null`/absent for a key
   * with the whole width of its role. `Principal.fromApiKey` carries it so `decide()` refuses every
   * route outside the scope's grammar.
   */
  readonly scope?: TokenScope | null;
}

/**
 * An `invitations` row, as an API response may see it — issue #121.
 *
 * There is no `tokenHash` field, for the same reason {@link ApiKeySummary} has no `keyHash`: §22's
 * "show the raw secret only once, store only a secure hash" is this task's own mandate too, and a
 * type with nowhere to put the hash is what makes leaking it a compile error rather than a review
 * comment.
 */
export interface InvitationSummary {
  readonly id: string;
  readonly email: string;
  readonly role: Role;
  readonly invitedBy: string | null;
  readonly expiresAt: string;
  readonly acceptedAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

/** What `POST /api/invitations` was given. `role` is conferred, not merely parsed — see `conferral.ts`. */
export interface CreateInvitationInput {
  readonly email: string;
  readonly role: ConferredRole;
  /** `memberships.user_id` of the inviter, or `null` for an API-key caller (refused before this). */
  readonly invitedBy: string | null;
}

/** Creating an invitation, and every correction the caller can make. */
export type CreateInvitationOutcome =
  | { readonly kind: 'created'; readonly invitation: InvitationSummary; readonly token: string }
  | {
      /** The partial unique index's own outcome: a pending invitation to this address already exists. */
      readonly kind: 'already-invited';
      readonly email: string;
    };

/** Resending an invitation: a fresh token and a fresh expiry for the same row. */
export type ResendInvitationOutcome =
  | { readonly kind: 'resent'; readonly invitation: InvitationSummary; readonly token: string }
  | { readonly kind: 'no-such-invitation'; readonly id: string }
  | { readonly kind: 'already-accepted'; readonly invitation: InvitationSummary }
  | { readonly kind: 'revoked'; readonly invitation: InvitationSummary };

/** Revoking an invitation. Revocation is a timestamp, not a delete — same reasoning as API keys. */
export type RevokeInvitationOutcome =
  | { readonly kind: 'revoked'; readonly invitation: InvitationSummary }
  | { readonly kind: 'already-revoked'; readonly invitation: InvitationSummary }
  | { readonly kind: 'no-such-invitation'; readonly id: string }
  | { readonly kind: 'already-accepted'; readonly invitation: InvitationSummary };

/**
 * Accepting an invitation. See `packages/core/src/db/repositories/directory.ts`'s
 * `AcceptInvitationOutcome` for why `invalid` is one outcome for three different facts.
 */
export type AcceptInvitationOutcome =
  | {
      readonly kind: 'accepted';
      readonly workspaceId: string;
      readonly workspaceSlug: string;
      readonly user: UserSummary;
      readonly membership: MembershipSummary;
    }
  | {
      readonly kind: 'already-member';
      readonly workspaceId: string;
      readonly userId: string;
      readonly principalId: string;
    }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'revoked' }
  | { readonly kind: 'already-accepted' };

/**
 * One CURRENT membership a user holds, named both ways: `workspaceId` for scoping a query,
 * `workspaceSlug` for the session token (`apps/web/server/auth/session.ts` mints `ws` as a slug),
 * `workspaceName` for display. Issue #118.
 */
export interface UserMembershipSummary {
  /** The exact Membership principal used when the user selects this workspace. */
  readonly principalId: string;
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly workspaceName: string;
  readonly role: Role;
}

/** The rows of one workspace. No method takes a workspace id; the workspace is already fixed. */
export interface WorkspaceDirectory {
  listUsers(): Promise<UserSummary[]>;
  createUser(input: CreateUserInput): Promise<CreateUserOutcome>;
  listMemberships(): Promise<MembershipSummary[]>;
  createMembership(input: CreateMembershipInput): Promise<CreateMembershipOutcome>;
  changeMembershipRole(id: string, role: ConferredRole): Promise<MembershipChangeOutcome>;
  deleteMembership(id: string): Promise<DeleteMembershipOutcome>;
  listApiKeys(): Promise<ApiKeySummary[]>;
  createApiKey(input: CreateApiKeyInput): Promise<CreateApiKeyOutcome>;
  revokeApiKey(id: string): Promise<RevokeApiKeyOutcome>;
  /** The stored row, hash included. For the authenticator and for the test that reads it back. */
  readStoredApiKey(id: string): Promise<StoredApiKey | null>;
  listInvitations(): Promise<InvitationSummary[]>;
  createInvitation(input: CreateInvitationInput): Promise<CreateInvitationOutcome>;
  resendInvitation(id: string): Promise<ResendInvitationOutcome>;
  revokeInvitation(id: string): Promise<RevokeInvitationOutcome>;
}

/** Everything the routes of this task need from persistence. */
export interface DirectoryRoot {
  forWorkspace(workspaceId: string): WorkspaceDirectory;
  /**
   * Resolve a presented key to an identity, or `null`.
   *
   * `null` for a key that never existed, a revoked key and an expired key alike — R-12 §1.5: three
   * conditions that are already one SQL query returning zero rows, and distinguishing them over
   * HTTP turns the 401 into an oracle for enumerating retired keys.
   */
  authenticateApiKey(presented: string, now: Date): Promise<ApiKeyIdentity | null>;
  /** The role a session's subject holds in a workspace, or `null` if no membership joins them. */
  resolveRole(email: string, workspaceId: string): Promise<Role | null>;
  /** A `users` row by email, or `null`. Resolves an OIDC identity to an existing account. */
  findUserByEmail(email: string): Promise<UserSummary | null>;
  /**
   * The user a (issuer, subject) pair is already bound to, with that user's directory email, or
   * `null` if never seen (issue #118).
   */
  findIdentity(
    issuer: string,
    subject: string,
  ): Promise<{ readonly userId: string; readonly email: string } | null>;
  /** Bind an (issuer, subject) pair to a user. Idempotent for a replayed callback. */
  linkIdentity(issuer: string, subject: string, userId: string): Promise<void>;
  /** Every CURRENT membership this user holds, across every workspace (issue #118). */
  membershipsForUser(userId: string): Promise<readonly UserMembershipSummary[]>;
  /**
   * Redeem an invitation. Unscoped, like {@link authenticateApiKey}: the caller does not yet know
   * which workspace the invitation names — establishing that is the whole point of the call.
   * `token` is the plaintext the invitee presents; hashing it is this implementation's job, not the
   * handler's, the same split `authenticateApiKey` draws for a bearer key.
   */
  acceptInvitation(
    id: string,
    token: string,
    identity: {
      readonly email: string;
      readonly issuer: string;
      readonly subject: string;
    },
  ): Promise<AcceptInvitationOutcome>;
}
