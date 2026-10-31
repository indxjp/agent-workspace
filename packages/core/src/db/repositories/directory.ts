import type { Database } from '../client.js';
import type { MembershipRole } from '../schema/memberships.js';
import { LOCAL_RUNTIME_API_KEY_NAME_PREFIX } from './directory/queries.js';
import { createDatabaseDirectoryRootQueries } from './directory/root.js';
import { createDatabaseWorkspaceDirectory } from './directory/workspace.js';

export { LOCAL_RUNTIME_API_KEY_NAME_PREFIX };

export interface DirectoryUserRecord {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly createdAt: Date;
}

export interface DirectoryMembershipRecord {
  readonly id: string;
  readonly principalId: string;
  readonly userId: string;
  readonly email: string;
  /**
   * The joined `users.name` as stored. No read path derives this value from the email, but the
   * stored name can be an address local part all the same: `defaultDisplayName` seeds it from the
   * local part for a user created by invitation acceptance, and it stays that until the invitee
   * edits their profile. `users.name` is `notNull` with a `users_name_not_blank` check, so this is
   * a `string` and never `string | null`.
   */
  readonly name: string;
  readonly role: MembershipRole;
  readonly createdAt: Date;
}

/**
 * What an endpoint-scoped key may reach (ADR-0134). `null` on a record means the key is not bound
 * to an endpoint client and carries the ordinary role-based authority.
 */
export type DirectoryEndpointScope =
  | { readonly kind: 'a2a-agent'; readonly clientId: string; readonly agentId: string }
  | { readonly kind: 'mcp-project'; readonly clientId: string };

export interface DirectoryApiKeyRecord {
  readonly id: string;
  readonly principalId: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly role: MembershipRole;
  readonly keyPrefix: string;
  readonly keyHash: string;
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
  /**
   * The membership principal this key's principal acts for (issue #509, S1-24), or `null` for a
   * key that owns what it writes. Only the per-run local runtime key sets it.
   */
  readonly actsForPrincipalId: string | null;
  /** The endpoint client this key is bound to (ADR-0134), or `null` for an ordinary key. */
  readonly endpointScope: DirectoryEndpointScope | null;
}

/** An `invitations` row, hash included. Nothing outside this file and its one caller reads the hash. */
export interface DirectoryInvitationRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly email: string;
  readonly role: MembershipRole;
  readonly invitedBy: string | null;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

/**
 * Accepting an invitation — issue #121's atomic transaction.
 *
 * `invalid` is one outcome for three different facts (no row with this id, a token hash that does
 * not match it, an authenticated email that does not match it), collapsed by the query itself
 * rather than by a branch: {@link DatabaseDirectoryRoot.acceptInvitation}'s single `SELECT` filters
 * on all three at once, so there is no code path that could tell them apart even by a timing
 * difference. Verifier attack 2 requires exactly this: neither a wrong email nor a foreign
 * workspace's token may "reveal that [the other workspace] exists".
 */
export type AcceptInvitationOutcome =
  | {
      readonly kind: 'accepted';
      readonly workspaceId: string;
      readonly workspaceSlug: string;
      readonly user: DirectoryUserRecord;
      readonly membership: DirectoryMembershipRecord;
    }
  | {
      /** Already a member of the target workspace. The token is still consumed (see the header). */
      readonly kind: 'already-member';
      readonly workspaceId: string;
      readonly userId: string;
      readonly principalId: string;
    }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'revoked' }
  | { readonly kind: 'already-accepted' };

export interface DatabaseWorkspaceDirectory {
  listUsers(): Promise<readonly DirectoryUserRecord[]>;
  createUser(input: {
    email: string;
    name: string;
    role: MembershipRole;
  }): Promise<
    | { kind: 'created'; user: DirectoryUserRecord; membership: DirectoryMembershipRecord }
    | { kind: 'email-taken'; email: string }
  >;
  listMemberships(): Promise<readonly DirectoryMembershipRecord[]>;
  /**
   * The workspace's membership whose live principal is `principalId`, or `null` when there is none:
   * the id names another workspace's principal, an API key, a revoked principal or nothing at all.
   */
  findMembershipByPrincipal(principalId: string): Promise<DirectoryMembershipRecord | null>;
  createMembership(input: {
    email: string;
    role: MembershipRole;
  }): Promise<
    | { kind: 'created'; membership: DirectoryMembershipRecord }
    | { kind: 'no-such-user'; email: string }
    | { kind: 'already-a-member'; email: string }
  >;
  changeMembershipRole(
    id: string,
    role: MembershipRole,
  ): Promise<
    | { kind: 'changed'; membership: DirectoryMembershipRecord }
    | { kind: 'no-such-membership'; id: string }
    | { kind: 'last-owner'; id: string }
  >;
  deleteMembership(id: string): Promise<
    | { kind: 'deleted'; id: string }
    | { kind: 'no-such-membership'; id: string }
    | { kind: 'last-owner'; id: string }
    | {
        kind: 'membership-in-use';
        id: string;
        /**
         * What still references the member: `projects` it owns, or `local-runtime-keys`, the
         * per-run `aw dev` keys that act for its membership principal (issue #509, S1-24), revoked
         * ones included, since they keep that reference as the record of who they wrote for.
         */
        dependency: 'projects' | 'local-runtime-keys';
      }
  >;
  listApiKeys(): Promise<readonly DirectoryApiKeyRecord[]>;
  createApiKey(input: {
    name: string;
    role: MembershipRole;
    keyPrefix: string;
    keyHash: string;
    expiresAt: Date | null;
    /**
     * The membership principal the new key acts for (issue #509, S1-24). It must be an unrevoked
     * membership principal of this workspace with its membership present; anything else is a
     * programming error and throws, rolling the key back. Hosted callers pass nothing.
     */
    actsForPrincipalId?: string;
  }): Promise<
    { kind: 'created'; key: DirectoryApiKeyRecord } | { kind: 'name-taken'; name: string }
  >;
  /**
   * Mint a key bound to one endpoint client (ADR-0134). The client is locked and re-checked in the
   * same transaction, so a key can never be bound to a client that was revoked a moment earlier.
   */
  createEndpointApiKey(input: {
    name: string;
    role: MembershipRole;
    keyPrefix: string;
    keyHash: string;
    expiresAt: Date | null;
    endpointClientId: string;
    actsForPrincipalId: string;
  }): Promise<
    | { kind: 'created'; key: DirectoryApiKeyRecord }
    | { kind: 'name-taken'; name: string }
    | { kind: 'no-such-endpoint-client'; id: string }
    | { kind: 'endpoint-client-revoked'; id: string }
  >;
  revokeApiKey(
    id: string,
    now: Date,
  ): Promise<
    | { kind: 'revoked'; key: DirectoryApiKeyRecord }
    | { kind: 'no-such-key'; id: string }
    | { kind: 'already-revoked'; key: DirectoryApiKeyRecord }
  >;
  readApiKey(id: string): Promise<DirectoryApiKeyRecord | null>;
  /**
   * Issue #509 (S1-24)'s repair at local start. Every resource owned by an API-key principal whose
   * key name starts with {@link LOCAL_RUNTIME_API_KEY_NAME_PREFIX} (revoked and expired keys
   * included; the prefix is fixed here, never chosen by a caller) moves to the
   * principal that key acts for, or to `toPrincipalId` when it records none: `owner_principal_id`
   * in agents, sessions, skills, files, MCP servers and projects, and `publisher_principal_id` in
   * shares. Those principals' unset `acts_for_principal_id` is then backfilled to `toPrincipalId`.
   *
   * One transaction, idempotent (a second call moves nothing and returns 0). Actor attribution
   * (`agent_versions.created_by_principal_id`, `audit_events.actor_principal_id`,
   * `browser_tokens.minted_by_principal_id`) is never touched: it records who acted. Throws, with
   * nothing changed, when `toPrincipalId` is not an active membership principal of this workspace.
   */
  reassignLocalRuntimeKeyOwnership(input: {
    readonly toPrincipalId: string;
  }): Promise<{ readonly reassigned: number }>;
  listInvitations(): Promise<readonly DirectoryInvitationRecord[]>;
  createInvitation(input: {
    email: string;
    role: MembershipRole;
    invitedBy: string | null;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<
    | { kind: 'created'; invitation: DirectoryInvitationRecord }
    | { kind: 'already-invited'; email: string }
  >;
  resendInvitation(
    id: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<
    | { kind: 'resent'; invitation: DirectoryInvitationRecord }
    | { kind: 'no-such-invitation'; id: string }
    | { kind: 'already-accepted'; invitation: DirectoryInvitationRecord }
    | { kind: 'revoked'; invitation: DirectoryInvitationRecord }
  >;
  revokeInvitation(
    id: string,
    now: Date,
  ): Promise<
    | { kind: 'revoked'; invitation: DirectoryInvitationRecord }
    | { kind: 'already-revoked'; invitation: DirectoryInvitationRecord }
    | { kind: 'no-such-invitation'; id: string }
    | { kind: 'already-accepted'; invitation: DirectoryInvitationRecord }
  >;
}

/**
 * One CURRENT membership a user holds, with the workspace named both ways — `id` for scoping a
 * query, `slug` for the session token, `name` for display (issue #118).
 */
interface DirectoryUserMembershipRecord {
  readonly principalId: string;
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly workspaceName: string;
  readonly role: MembershipRole;
}

/**
 * The non-secret identity and current role a `workspace_principals` row resolves to right now —
 * issue #236 (SDK-04, S-1)'s "the role is read from the directory at request time, never carried
 * in the token" (`apps/web/server/rbac/principal.ts`'s header), applied to a browser token's
 * *minter* rather than to the caller who presented a session or an API key directly.
 */
export interface DirectoryPrincipalRecord {
  readonly principalId: string;
  readonly kind: 'membership' | 'api_key';
  readonly role: MembershipRole;
  /** Stable display attribution. Never used for authorization. */
  readonly label: string;
  /** `users.id`, present exactly for a membership principal. */
  readonly userId: string | null;
  /** `api_keys.id`, present exactly for an API-key principal. */
  readonly apiKeyId: string | null;
  /**
   * The membership principal an API-key principal acts for (issue #509, S1-24); always `null` for
   * a membership principal and for a hosted key.
   */
  readonly actsForPrincipalId: string | null;
}

export interface DatabaseDirectoryRoot {
  forWorkspace(workspaceId: string): DatabaseWorkspaceDirectory;
  authenticateApiKeyHash(keyHash: string, now: Date): Promise<DirectoryApiKeyRecord | null>;
  resolveRole(email: string, workspaceId: string): Promise<MembershipRole | null>;
  /**
   * Re-read one principal's current identity and role, or `null` when it no longer authenticates:
   * no such principal in this workspace, its `workspace_principals` row is revoked, its membership
   * has been removed, or its API key has since been revoked or has expired. The one caller is the
   * browser-token verifier, re-reading a token's minter on every request rather than trusting
   * whatever the minter could do at mint time.
   */
  principalById(workspaceId: string, principalId: string): Promise<DirectoryPrincipalRecord | null>;
  /** A `users` row by email, or `null`. Used to bind an OIDC identity to an existing account. */
  findUserByEmail(email: string): Promise<DirectoryUserRecord | null>;
  /**
   * The user a (issuer, subject) pair is already bound to, with that user's directory email, or
   * `null` if never seen. The email is what a session is minted for, never the IdP's claim.
   */
  findIdentity(
    issuer: string,
    subject: string,
  ): Promise<{ readonly userId: string; readonly email: string } | null>;
  /**
   * Bind an (issuer, subject) pair to a user. Idempotent: binding the same pair to the same user
   * twice succeeds silently, because a replayed callback must not fail on the second attempt.
   */
  linkIdentity(issuer: string, subject: string, userId: string): Promise<void>;
  /** Every CURRENT membership this user holds, across every workspace (issue #118). */
  membershipsForUser(userId: string): Promise<readonly DirectoryUserMembershipRecord[]>;
  /**
   * Redeem an invitation — issue #121's one atomic transaction. Unscoped, the way
   * {@link authenticateApiKeyHash} is: the caller does not yet know which workspace the invitation
   * names, because that is exactly what this call establishes. `tokenHash` is computed by the
   * caller (`apps/web/server/invitations/token.ts`); this layer never sees the plaintext.
   */
  acceptInvitation(
    id: string,
    tokenHash: string,
    identity: {
      readonly email: string;
      readonly issuer: string;
      readonly subject: string;
    },
    now: Date,
  ): Promise<AcceptInvitationOutcome>;
}

export function createDatabaseDirectoryRoot(db: Database): DatabaseDirectoryRoot {
  const forWorkspace = (workspaceId: string): DatabaseWorkspaceDirectory =>
    createDatabaseWorkspaceDirectory(db, workspaceId);

  return { forWorkspace, ...createDatabaseDirectoryRootQueries(db) };
}
