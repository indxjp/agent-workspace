import { and, asc, count, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { agents } from '../schema/agents.js';
import { apiKeys } from '../schema/api-keys.js';
import { endpointClientAgents } from '../schema/endpoint-client-agents.js';
import { endpointClientApiKeys } from '../schema/endpoint-client-api-keys.js';
import { endpointClients } from '../schema/endpoint-clients.js';
import { files } from '../schema/files.js';
import { invitations } from '../schema/invitations.js';
import { mcpServers } from '../schema/mcp-servers.js';
import { memberships, type MembershipRole } from '../schema/memberships.js';
import { projects } from '../schema/projects.js';
import { sessions } from '../schema/sessions.js';
import { shares } from '../schema/shares.js';
import { skills } from '../schema/skills.js';
import { userIdentities } from '../schema/user-identities.js';
import { users } from '../schema/users.js';
import { workspaces } from '../schema/workspaces.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { postgresViolations } from './violations.js';

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

/**
 * The reserved head of every API key name the local runtime (`aw dev`, ADR-0109) mints. Owned by
 * core so that {@link DatabaseWorkspaceDirectory.reassignLocalRuntimeKeyOwnership} selects exactly
 * these keys and no caller can widen the selection to hosted keys (issue #509, S1-24).
 */
export const LOCAL_RUNTIME_API_KEY_NAME_PREFIX = 'aw dev local runtime ';

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

const USER_COLUMNS = {
  id: users.id,
  email: users.email,
  name: users.name,
  createdAt: users.createdAt,
} as const;
const KEY_ROW_COLUMNS = {
  id: apiKeys.id,
  workspaceId: apiKeys.workspaceId,
  name: apiKeys.name,
  role: apiKeys.role,
  keyPrefix: apiKeys.keyPrefix,
  keyHash: apiKeys.keyHash,
  lastUsedAt: apiKeys.lastUsedAt,
  expiresAt: apiKeys.expiresAt,
  revokedAt: apiKeys.revokedAt,
  createdAt: apiKeys.createdAt,
} as const;
const KEY_COLUMNS = {
  ...KEY_ROW_COLUMNS,
  principalId: workspacePrincipals.id,
  actsForPrincipalId: workspacePrincipals.actsForPrincipalId,
} as const;
const INVITATION_COLUMNS = {
  id: invitations.id,
  workspaceId: invitations.workspaceId,
  email: invitations.email,
  role: invitations.role,
  invitedBy: invitations.invitedBy,
  tokenHash: invitations.tokenHash,
  expiresAt: invitations.expiresAt,
  acceptedAt: invitations.acceptedAt,
  revokedAt: invitations.revokedAt,
  createdAt: invitations.createdAt,
} as const;

/**
 * A display name for a user this program is creating for the first time, with nothing else to
 * call them: the local part of their email, exactly as `apps/web/server/rbac/handlers.ts`'s
 * `createUser` requires one from its caller but {@link DatabaseDirectoryRoot.acceptInvitation} has
 * none to ask for — the invitee never fills in a form, they redeem a link. `users_name_not_blank`
 * still has to hold, so this can never be empty: a local part that is somehow blank falls back to
 * the whole address, which the shape check already guarantees is non-blank.
 */
function defaultDisplayName(email: string): string {
  const local = email.split('@')[0]?.trim();
  return local !== undefined && local !== '' ? local : email;
}

/** Rolls back every acceptance write when a concurrent OIDC binding chose another user. */
class InvitationIdentityConflict extends Error {}

function membershipColumns() {
  return {
    id: memberships.id,
    principalId: workspacePrincipals.id,
    userId: memberships.userId,
    email: users.email,
    name: users.name,
    role: memberships.role,
    createdAt: memberships.createdAt,
  } as const;
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Whether `principalId` is an unrevoked membership principal of `workspaceId` whose membership row
 * is still present: the only principal an API key may act for (issue #509, S1-24), and the check
 * that keeps a key from outliving the person it acts for.
 */
async function isActiveMembershipPrincipal(
  executor: Database | Transaction,
  workspaceId: string,
  principalId: string,
): Promise<boolean> {
  const rows = await executor
    .select({ id: workspacePrincipals.id })
    .from(workspacePrincipals)
    .innerJoin(
      memberships,
      and(
        eq(memberships.workspaceId, workspacePrincipals.workspaceId),
        eq(memberships.id, workspacePrincipals.membershipId),
      ),
    )
    .where(
      and(
        eq(workspacePrincipals.workspaceId, workspaceId),
        eq(workspacePrincipals.id, principalId),
        eq(workspacePrincipals.kind, 'membership'),
        isNull(workspacePrincipals.revokedAt),
      ),
    )
    .limit(1);
  return rows[0] !== undefined;
}

interface EndpointBinding {
  /** `null` when the binding cannot name a target: an a2a client whose agent row is gone. */
  readonly scope: DirectoryEndpointScope | null;
  readonly clientRevokedAt: Date | null;
}

/** The endpoint bindings of one workspace's keys (or of one key), keyed by `api_keys.id`. */
async function endpointBindings(
  executor: Database | Transaction,
  workspaceId: string,
  keyId?: string,
): Promise<Map<string, EndpointBinding>> {
  const rows = await executor
    .select({
      apiKeyId: endpointClientApiKeys.apiKeyId,
      clientId: endpointClients.id,
      kind: endpointClients.kind,
      revokedAt: endpointClients.revokedAt,
      agentId: endpointClientAgents.agentId,
    })
    .from(endpointClientApiKeys)
    .innerJoin(
      endpointClients,
      and(
        eq(endpointClients.workspaceId, endpointClientApiKeys.workspaceId),
        eq(endpointClients.id, endpointClientApiKeys.clientId),
      ),
    )
    .leftJoin(
      endpointClientAgents,
      and(
        eq(endpointClientAgents.workspaceId, endpointClients.workspaceId),
        eq(endpointClientAgents.clientId, endpointClients.id),
      ),
    )
    .where(
      and(
        eq(endpointClientApiKeys.workspaceId, workspaceId),
        keyId === undefined ? undefined : eq(endpointClientApiKeys.apiKeyId, keyId),
      ),
    );
  const bindings = new Map<string, EndpointBinding>();
  for (const row of rows) {
    const existing = bindings.get(row.apiKeyId);
    if (existing !== undefined && existing.scope !== null) continue;
    const scope: DirectoryEndpointScope | null =
      row.kind === 'mcp-project'
        ? { kind: 'mcp-project', clientId: row.clientId }
        : row.agentId === null
          ? null
          : { kind: 'a2a-agent', clientId: row.clientId, agentId: row.agentId };
    bindings.set(row.apiKeyId, { scope, clientRevokedAt: row.revokedAt });
  }
  return bindings;
}

/** Insert one `api_keys` row and its `workspace_principals` row. Runs inside the caller's transaction. */
async function insertApiKey(
  tx: Transaction,
  workspaceId: string,
  input: {
    name: string;
    role: MembershipRole;
    keyPrefix: string;
    keyHash: string;
    expiresAt: Date | null;
  },
  actsForPrincipalId: string | undefined,
): Promise<Omit<DirectoryApiKeyRecord, 'endpointScope'>> {
  if (
    actsForPrincipalId !== undefined &&
    !(await isActiveMembershipPrincipal(tx, workspaceId, actsForPrincipalId))
  ) {
    throw new Error('An API key may act only for an active membership principal of its workspace.');
  }
  const rows = await tx
    .insert(apiKeys)
    .values({ ...input, workspaceId })
    .returning(KEY_ROW_COLUMNS);
  const key = rows[0];
  if (key === undefined) throw new Error('API key insert returned no row');
  const insertedPrincipal = await tx
    .insert(workspacePrincipals)
    .values({
      workspaceId,
      kind: 'api_key',
      apiKeyId: key.id,
      actsForPrincipalId: actsForPrincipalId ?? null,
    })
    .returning({
      principalId: workspacePrincipals.id,
      actsForPrincipalId: workspacePrincipals.actsForPrincipalId,
    });
  const principal = insertedPrincipal[0];
  if (principal === undefined) throw new Error('API-key principal insert returned no row');
  return {
    ...key,
    principalId: principal.principalId,
    actsForPrincipalId: principal.actsForPrincipalId,
  };
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Whether `error`'s cause chain names `constraint`.
 *
 * Drizzle wraps the driver error: what a caller catches is a `DrizzleQueryError`, and the `pg`
 * error carrying `constraint` is down its `cause` chain, not on the wrapper itself
 * (`docs/adr/W2-DB-02-constraint-violations-arrive-wrapped.md`). A shallow `'constraint' in error`
 * check here answered `false` for every caller of this function until issue #118's
 * `linkIdentity` test ran it against a real conflict for the first time — `postgresViolations`
 * (already used by `agents.ts`, `runs.ts` and the other repositories for the same reason) is the
 * walk that actually finds it.
 */
function isConstraint(error: unknown, constraint: string): boolean {
  for (const violation of postgresViolations(error)) {
    if (violation.constraint === constraint) return true;
  }
  return false;
}

export function createDatabaseDirectoryRoot(db: Database): DatabaseDirectoryRoot {
  const forWorkspace = (workspaceId: string): DatabaseWorkspaceDirectory => {
    const listMemberships = async (): Promise<readonly DirectoryMembershipRecord[]> =>
      db
        .select(membershipColumns())
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .innerJoin(
          workspacePrincipals,
          and(
            eq(workspacePrincipals.workspaceId, memberships.workspaceId),
            eq(workspacePrincipals.membershipId, memberships.id),
            eq(workspacePrincipals.kind, 'membership'),
            isNull(workspacePrincipals.revokedAt),
          ),
        )
        .where(eq(memberships.workspaceId, workspaceId))
        .orderBy(asc(users.email));

    const findInvitation = async (id: string): Promise<DirectoryInvitationRecord | null> => {
      const rows = await db
        .select(INVITATION_COLUMNS)
        .from(invitations)
        .where(and(eq(invitations.workspaceId, workspaceId), eq(invitations.id, id)))
        .limit(1);
      return rows[0] ?? null;
    };

    return {
      async listUsers() {
        return db
          .select(USER_COLUMNS)
          .from(users)
          .innerJoin(memberships, eq(memberships.userId, users.id))
          .where(eq(memberships.workspaceId, workspaceId))
          .orderBy(asc(users.email));
      },
      async createUser(input) {
        const email = normaliseEmail(input.email);
        return db.transaction(async (tx) => {
          const existingUsers = await tx
            .select(USER_COLUMNS)
            .from(users)
            .where(eq(users.email, email))
            .limit(1);
          let user = existingUsers[0];
          if (user !== undefined) {
            const member = await tx
              .select({ id: memberships.id })
              .from(memberships)
              .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, user.id)))
              .limit(1);
            if (member[0] !== undefined) return { kind: 'email-taken' as const, email };
          } else {
            const inserted = await tx
              .insert(users)
              .values({ email, name: input.name.trim() })
              .returning(USER_COLUMNS);
            user = inserted[0];
          }
          if (user === undefined) throw new Error('user insert returned no row');
          const insertedMembership = await tx
            .insert(memberships)
            .values({ workspaceId, userId: user.id, role: input.role })
            .returning({
              id: memberships.id,
              userId: memberships.userId,
              role: memberships.role,
              createdAt: memberships.createdAt,
            });
          const row = insertedMembership[0];
          if (row === undefined) throw new Error('membership insert returned no row');
          const insertedPrincipal = await tx
            .insert(workspacePrincipals)
            .values({ workspaceId, kind: 'membership', membershipId: row.id })
            .returning({ principalId: workspacePrincipals.id });
          const principal = insertedPrincipal[0];
          if (principal === undefined) {
            throw new Error('membership principal insert returned no row');
          }
          return {
            kind: 'created' as const,
            user,
            membership: { ...row, principalId: principal.principalId, email, name: user.name },
          };
        });
      },
      listMemberships,
      async createMembership(input) {
        const email = normaliseEmail(input.email);
        const found = await db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(eq(users.email, email))
          .limit(1);
        const user = found[0];
        if (user === undefined) return { kind: 'no-such-user', email };
        try {
          return await db.transaction(async (tx) => {
            const rows = await tx
              .insert(memberships)
              .values({ workspaceId, userId: user.id, role: input.role })
              .returning({
                id: memberships.id,
                userId: memberships.userId,
                role: memberships.role,
                createdAt: memberships.createdAt,
              });
            const row = rows[0];
            if (row === undefined) throw new Error('membership insert returned no row');
            const insertedPrincipal = await tx
              .insert(workspacePrincipals)
              .values({ workspaceId, kind: 'membership', membershipId: row.id })
              .returning({ principalId: workspacePrincipals.id });
            const principal = insertedPrincipal[0];
            if (principal === undefined) {
              throw new Error('membership principal insert returned no row');
            }
            return {
              kind: 'created' as const,
              membership: {
                ...row,
                principalId: principal.principalId,
                email,
                name: user.name,
              },
            };
          });
        } catch (error) {
          if (isConstraint(error, 'memberships_workspace_user_key'))
            return { kind: 'already-a-member', email };
          throw error;
        }
      },
      async changeMembershipRole(id, role) {
        return db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${workspaceId}))`);
          const rows = await tx
            .select(membershipColumns())
            .from(memberships)
            .innerJoin(users, eq(users.id, memberships.userId))
            .innerJoin(
              workspacePrincipals,
              and(
                eq(workspacePrincipals.workspaceId, memberships.workspaceId),
                eq(workspacePrincipals.membershipId, memberships.id),
                eq(workspacePrincipals.kind, 'membership'),
                isNull(workspacePrincipals.revokedAt),
              ),
            )
            .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.id, id)))
            .limit(1);
          const current = rows[0];
          if (current === undefined) return { kind: 'no-such-membership' as const, id };
          if (current.role === 'owner' && role !== 'owner') {
            const owners = await tx
              .select({ total: count() })
              .from(memberships)
              .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, 'owner')));
            if ((owners[0]?.total ?? 0) <= 1) return { kind: 'last-owner' as const, id };
          }
          await tx
            .update(memberships)
            .set({ role })
            .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.id, id)));
          return { kind: 'changed' as const, membership: { ...current, role } };
        });
      },
      async deleteMembership(id) {
        try {
          return await db.transaction(async (tx) => {
            await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${workspaceId}))`);
            const rows = await tx
              .select({ role: memberships.role })
              .from(memberships)
              .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.id, id)))
              .limit(1);
            const current = rows[0];
            if (current === undefined) return { kind: 'no-such-membership' as const, id };
            if (current.role === 'owner') {
              const owners = await tx
                .select({ total: count() })
                .from(memberships)
                .where(
                  and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, 'owner')),
                );
              if ((owners[0]?.total ?? 0) <= 1) return { kind: 'last-owner' as const, id };
            }
            await tx
              .delete(memberships)
              .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.id, id)));
            return { kind: 'deleted' as const, id };
          });
        } catch (error) {
          // RF-101 makes project ownership exact and non-null. Until RF-202 defines an explicit
          // offboarding/reassignment policy, preserve both the membership and its projects and
          // translate the resulting constraint into an expected domain refusal.
          if (isConstraint(error, 'projects_owner_principal_workspace_fk')) {
            return { kind: 'membership-in-use' as const, id, dependency: 'projects' as const };
          }
          // Issue #509 (S1-24): a local runtime key principal records the membership principal it
          // acts for, and that NO ACTION reference keeps the member. Refused as a domain outcome,
          // never surfaced as a raw constraint failure.
          if (isConstraint(error, 'workspace_principals_acts_for_workspace_fk')) {
            return {
              kind: 'membership-in-use' as const,
              id,
              dependency: 'local-runtime-keys' as const,
            };
          }
          throw error;
        }
      },
      async listApiKeys() {
        const rows = await db
          .select(KEY_COLUMNS)
          .from(apiKeys)
          .innerJoin(
            workspacePrincipals,
            and(
              eq(workspacePrincipals.workspaceId, apiKeys.workspaceId),
              eq(workspacePrincipals.apiKeyId, apiKeys.id),
            ),
          )
          .where(eq(apiKeys.workspaceId, workspaceId))
          .orderBy(asc(apiKeys.name));
        const bindings = await endpointBindings(db, workspaceId);
        return rows.map((row) => ({ ...row, endpointScope: bindings.get(row.id)?.scope ?? null }));
      },
      async createApiKey(input) {
        const { actsForPrincipalId, ...keyInput } = input;
        try {
          return await db.transaction(async (tx) => {
            const key = await insertApiKey(tx, workspaceId, keyInput, actsForPrincipalId);
            return { kind: 'created' as const, key: { ...key, endpointScope: null } };
          });
        } catch (error) {
          if (isConstraint(error, 'api_keys_workspace_name_key'))
            return { kind: 'name-taken', name: input.name };
          throw error;
        }
      },
      async createEndpointApiKey(input) {
        const { endpointClientId, actsForPrincipalId, ...keyInput } = input;
        try {
          return await db.transaction(async (tx) => {
            const clients = await tx
              .select({
                kind: endpointClients.kind,
                revokedAt: endpointClients.revokedAt,
                agentId: endpointClientAgents.agentId,
              })
              .from(endpointClients)
              .leftJoin(
                endpointClientAgents,
                and(
                  eq(endpointClientAgents.workspaceId, endpointClients.workspaceId),
                  eq(endpointClientAgents.clientId, endpointClients.id),
                ),
              )
              .where(
                and(
                  eq(endpointClients.workspaceId, workspaceId),
                  eq(endpointClients.id, endpointClientId),
                ),
              )
              .for('update', { of: endpointClients });
            const client = clients[0];
            if (client === undefined) {
              return { kind: 'no-such-endpoint-client' as const, id: endpointClientId };
            }
            if (client.revokedAt !== null) {
              return { kind: 'endpoint-client-revoked' as const, id: endpointClientId };
            }
            let scope: DirectoryEndpointScope;
            if (client.kind === 'mcp-project') {
              scope = { kind: 'mcp-project', clientId: endpointClientId };
            } else if (client.agentId !== null) {
              scope = { kind: 'a2a-agent', clientId: endpointClientId, agentId: client.agentId };
            } else {
              throw new Error('An a2a endpoint client must name exactly one agent.');
            }
            const key = await insertApiKey(tx, workspaceId, keyInput, actsForPrincipalId);
            await tx
              .insert(endpointClientApiKeys)
              .values({ workspaceId, clientId: endpointClientId, apiKeyId: key.id });
            return { kind: 'created' as const, key: { ...key, endpointScope: scope } };
          });
        } catch (error) {
          if (isConstraint(error, 'api_keys_workspace_name_key'))
            return { kind: 'name-taken', name: input.name };
          throw error;
        }
      },
      async revokeApiKey(id, now) {
        const existing = await db
          .select(KEY_COLUMNS)
          .from(apiKeys)
          .innerJoin(
            workspacePrincipals,
            and(
              eq(workspacePrincipals.workspaceId, apiKeys.workspaceId),
              eq(workspacePrincipals.apiKeyId, apiKeys.id),
            ),
          )
          .where(and(eq(apiKeys.workspaceId, workspaceId), eq(apiKeys.id, id)))
          .limit(1);
        const found = existing[0];
        if (found === undefined) return { kind: 'no-such-key', id };
        const key: DirectoryApiKeyRecord = {
          ...found,
          endpointScope: (await endpointBindings(db, workspaceId, id)).get(id)?.scope ?? null,
        };
        if (key.revokedAt !== null) return { kind: 'already-revoked', key };
        const revoked = await db.transaction(async (tx) => {
          const rows = await tx
            .update(apiKeys)
            .set({ revokedAt: sql`greatest(now(), ${now}::timestamptz)` })
            .where(
              and(
                eq(apiKeys.workspaceId, workspaceId),
                eq(apiKeys.id, id),
                isNull(apiKeys.revokedAt),
              ),
            )
            .returning(KEY_ROW_COLUMNS);
          const row = rows[0];
          if (row === undefined || row.revokedAt === null) return null;
          const principalRows = await tx
            .update(workspacePrincipals)
            .set({ revokedAt: row.revokedAt })
            .where(
              and(
                eq(workspacePrincipals.workspaceId, workspaceId),
                eq(workspacePrincipals.id, key.principalId),
                eq(workspacePrincipals.apiKeyId, id),
              ),
            )
            .returning({ id: workspacePrincipals.id });
          if (principalRows.length !== 1) {
            throw new Error('API-key revocation updated no exact principal');
          }
          return {
            ...row,
            principalId: key.principalId,
            actsForPrincipalId: key.actsForPrincipalId,
            endpointScope: key.endpointScope,
          };
        });
        return revoked === null
          ? { kind: 'already-revoked', key }
          : { kind: 'revoked', key: revoked };
      },
      async readApiKey(id) {
        const rows = await db
          .select(KEY_COLUMNS)
          .from(apiKeys)
          .innerJoin(
            workspacePrincipals,
            and(
              eq(workspacePrincipals.workspaceId, apiKeys.workspaceId),
              eq(workspacePrincipals.apiKeyId, apiKeys.id),
            ),
          )
          .where(and(eq(apiKeys.workspaceId, workspaceId), eq(apiKeys.id, id)))
          .limit(1);
        const row = rows[0];
        if (row === undefined) return null;
        const bindings = await endpointBindings(db, workspaceId, id);
        return { ...row, endpointScope: bindings.get(id)?.scope ?? null };
      },
      async reassignLocalRuntimeKeyOwnership({ toPrincipalId }) {
        return db.transaction(async (tx) => {
          // The workspace lock membership changes take, so the target cannot lose its membership
          // between the check below and the writes that reference it.
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${workspaceId}))`);
          if (!(await isActiveMembershipPrincipal(tx, workspaceId, toPrincipalId))) {
            throw new Error(
              'Local runtime key ownership can move only to an active membership principal.',
            );
          }
          const localPrincipals = await tx
            .select({
              id: workspacePrincipals.id,
              actsForPrincipalId: workspacePrincipals.actsForPrincipalId,
            })
            .from(workspacePrincipals)
            .innerJoin(
              apiKeys,
              and(
                eq(apiKeys.workspaceId, workspacePrincipals.workspaceId),
                eq(apiKeys.id, workspacePrincipals.apiKeyId),
              ),
            )
            .where(
              and(
                eq(workspacePrincipals.workspaceId, workspaceId),
                eq(workspacePrincipals.kind, 'api_key'),
                // starts_with, never LIKE: a prefix holding `%` or `_` matches only itself.
                sql`starts_with(${apiKeys.name}, ${LOCAL_RUNTIME_API_KEY_NAME_PREFIX})`,
              ),
            )
            .for('update', { of: workspacePrincipals });
          // Group the key principals by the owner their rows move to: the principal each acts
          // for, or the target when it records none. Normally there is exactly one group.
          const byOwner = new Map<string, string[]>();
          for (const principal of localPrincipals) {
            const owner = principal.actsForPrincipalId ?? toPrincipalId;
            const group = byOwner.get(owner);
            if (group === undefined) byOwner.set(owner, [principal.id]);
            else group.push(principal.id);
          }
          // `updated_at` is set to itself, overriding Drizzle's `$onUpdate`, and
          // `materialised_version_id` is left alone: a change of owner is not an edit.
          let reassigned = 0;
          for (const [owner, keyPrincipalIds] of byOwner) {
            const movedAgents = await tx
              .update(agents)
              .set({ ownerPrincipalId: owner, updatedAt: sql`${agents.updatedAt}` })
              .where(
                and(
                  eq(agents.workspaceId, workspaceId),
                  inArray(agents.ownerPrincipalId, keyPrincipalIds),
                ),
              )
              .returning({ id: agents.id });
            const movedSessions = await tx
              .update(sessions)
              .set({ ownerPrincipalId: owner, updatedAt: sql`${sessions.updatedAt}` })
              .where(
                and(
                  eq(sessions.workspaceId, workspaceId),
                  inArray(sessions.ownerPrincipalId, keyPrincipalIds),
                ),
              )
              .returning({ id: sessions.id });
            const movedSkills = await tx
              .update(skills)
              .set({ ownerPrincipalId: owner, updatedAt: sql`${skills.updatedAt}` })
              .where(
                and(
                  eq(skills.workspaceId, workspaceId),
                  inArray(skills.ownerPrincipalId, keyPrincipalIds),
                ),
              )
              .returning({ id: skills.id });
            const movedFiles = await tx
              .update(files)
              .set({ ownerPrincipalId: owner, updatedAt: sql`${files.updatedAt}` })
              .where(
                and(
                  eq(files.workspaceId, workspaceId),
                  inArray(files.ownerPrincipalId, keyPrincipalIds),
                ),
              )
              .returning({ id: files.id });
            const movedMcpServers = await tx
              .update(mcpServers)
              .set({ ownerPrincipalId: owner, updatedAt: sql`${mcpServers.updatedAt}` })
              .where(
                and(
                  eq(mcpServers.workspaceId, workspaceId),
                  inArray(mcpServers.ownerPrincipalId, keyPrincipalIds),
                ),
              )
              .returning({ id: mcpServers.id });
            const movedProjects = await tx
              .update(projects)
              .set({ ownerPrincipalId: owner, updatedAt: sql`${projects.updatedAt}` })
              .where(
                and(
                  eq(projects.workspaceId, workspaceId),
                  inArray(projects.ownerPrincipalId, keyPrincipalIds),
                ),
              )
              .returning({ id: projects.id });
            const movedShares = await tx
              .update(shares)
              .set({ publisherPrincipalId: owner })
              .where(
                and(
                  eq(shares.workspaceId, workspaceId),
                  inArray(shares.publisherPrincipalId, keyPrincipalIds),
                ),
              )
              .returning({ id: shares.id });
            reassigned +=
              movedAgents.length +
              movedSessions.length +
              movedSkills.length +
              movedFiles.length +
              movedMcpServers.length +
              movedProjects.length +
              movedShares.length;
          }
          const unset = localPrincipals
            .filter((principal) => principal.actsForPrincipalId === null)
            .map((principal) => principal.id);
          if (unset.length > 0) {
            await tx
              .update(workspacePrincipals)
              .set({ actsForPrincipalId: toPrincipalId })
              .where(
                and(
                  eq(workspacePrincipals.workspaceId, workspaceId),
                  inArray(workspacePrincipals.id, unset),
                  isNull(workspacePrincipals.actsForPrincipalId),
                ),
              );
          }
          return { reassigned };
        });
      },
      async listInvitations() {
        return db
          .select(INVITATION_COLUMNS)
          .from(invitations)
          .where(eq(invitations.workspaceId, workspaceId))
          .orderBy(desc(invitations.createdAt));
      },
      async createInvitation(input) {
        const email = normaliseEmail(input.email);
        try {
          const rows = await db
            .insert(invitations)
            .values({
              workspaceId,
              email,
              role: input.role,
              invitedBy: input.invitedBy,
              tokenHash: input.tokenHash,
              expiresAt: input.expiresAt,
            })
            .returning(INVITATION_COLUMNS);
          const invitation = rows[0];
          if (invitation === undefined) throw new Error('invitation insert returned no row');
          return { kind: 'created', invitation };
        } catch (error) {
          if (isConstraint(error, 'invitations_workspace_email_pending_key')) {
            return { kind: 'already-invited', email };
          }
          throw error;
        }
      },
      async resendInvitation(id, tokenHash, expiresAt) {
        const rows = await db
          .update(invitations)
          .set({ tokenHash, expiresAt })
          .where(
            and(
              eq(invitations.workspaceId, workspaceId),
              eq(invitations.id, id),
              isNull(invitations.acceptedAt),
              isNull(invitations.revokedAt),
            ),
          )
          .returning(INVITATION_COLUMNS);
        const updated = rows[0];
        if (updated !== undefined) return { kind: 'resent' as const, invitation: updated };

        // The conditional UPDATE is the decision point. Reading state only after it returns no row
        // avoids a resend/accept race where an earlier SELECT saw "pending" and a later UPDATE
        // rotated the token after acceptance had already committed.
        const current = await findInvitation(id);
        if (current === null) return { kind: 'no-such-invitation' as const, id };
        if (current.acceptedAt !== null) {
          return { kind: 'already-accepted' as const, invitation: current };
        }
        if (current.revokedAt !== null) {
          return { kind: 'revoked' as const, invitation: current };
        }
        throw new Error('pending invitation resend updated no row');
      },
      async revokeInvitation(id, now) {
        const rows = await db
          .update(invitations)
          .set({ revokedAt: sql`greatest(now(), ${now}::timestamptz)` })
          .where(
            and(
              eq(invitations.workspaceId, workspaceId),
              eq(invitations.id, id),
              isNull(invitations.revokedAt),
              isNull(invitations.acceptedAt),
            ),
          )
          .returning(INVITATION_COLUMNS);
        const revoked = rows[0];
        if (revoked !== undefined) return { kind: 'revoked' as const, invitation: revoked };

        // As with resend, the guarded write is the lifecycle decision. Only after it refuses do we
        // read the terminal state, so a concurrent acceptance cannot be mislabeled as revocation.
        const current = await findInvitation(id);
        if (current === null) return { kind: 'no-such-invitation' as const, id };
        if (current.acceptedAt !== null) {
          return { kind: 'already-accepted' as const, invitation: current };
        }
        if (current.revokedAt !== null) {
          return { kind: 'already-revoked' as const, invitation: current };
        }
        throw new Error('pending invitation revoke updated no row');
      },
    };
  };

  return {
    forWorkspace,
    async authenticateApiKeyHash(keyHash, now) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select(KEY_COLUMNS)
          .from(apiKeys)
          .innerJoin(
            workspacePrincipals,
            and(
              eq(workspacePrincipals.workspaceId, apiKeys.workspaceId),
              eq(workspacePrincipals.apiKeyId, apiKeys.id),
            ),
          )
          .where(
            and(
              eq(apiKeys.keyHash, keyHash),
              isNull(apiKeys.revokedAt),
              isNull(workspacePrincipals.revokedAt),
              or(
                isNull(apiKeys.expiresAt),
                gt(apiKeys.expiresAt, sql`greatest(now(), ${now}::timestamptz)`),
              ),
            ),
          )
          .limit(1);
        const key = rows[0];
        if (key === undefined) return null;
        // A key that acts for a person never outlives that person's principal or membership.
        if (
          key.actsForPrincipalId !== null &&
          !(await isActiveMembershipPrincipal(tx, key.workspaceId, key.actsForPrincipalId))
        ) {
          return null;
        }
        // An endpoint-bound key authenticates only while its client is live and still names a
        // target; a deleted agent cascades its row away, which fails closed here.
        const binding = (await endpointBindings(tx, key.workspaceId, key.id)).get(key.id);
        if (binding !== undefined && (binding.scope === null || binding.clientRevokedAt !== null)) {
          return null;
        }
        const updated = await tx
          .update(apiKeys)
          .set({ lastUsedAt: sql`greatest(now(), ${now}::timestamptz)` })
          .where(eq(apiKeys.id, key.id))
          .returning(KEY_ROW_COLUMNS);
        const updatedKey = updated[0];
        return updatedKey === undefined
          ? null
          : {
              ...updatedKey,
              principalId: key.principalId,
              actsForPrincipalId: key.actsForPrincipalId,
              endpointScope: binding?.scope ?? null,
            };
      });
    },
    async resolveRole(email, workspaceId) {
      const rows = await db
        .select({ role: memberships.role })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(eq(memberships.workspaceId, workspaceId), eq(users.email, normaliseEmail(email))),
        )
        .limit(1);
      return rows[0]?.role ?? null;
    },
    async principalById(workspaceId, principalId) {
      const principalRows = await db
        .select({
          kind: workspacePrincipals.kind,
          membershipId: workspacePrincipals.membershipId,
          apiKeyId: workspacePrincipals.apiKeyId,
          actsForPrincipalId: workspacePrincipals.actsForPrincipalId,
        })
        .from(workspacePrincipals)
        .where(
          and(
            eq(workspacePrincipals.workspaceId, workspaceId),
            eq(workspacePrincipals.id, principalId),
            isNull(workspacePrincipals.revokedAt),
          ),
        )
        .limit(1);
      const principal = principalRows[0];
      if (principal === undefined) return null;
      if (principal.kind === 'membership') {
        if (principal.membershipId === null) {
          throw new Error(
            `workspace_principals ${principalId} is kind 'membership' with a null membership_id; ` +
              'the source XOR check should make this unreachable.',
          );
        }
        const rows = await db
          .select({ role: memberships.role, userId: users.id, name: users.name })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(
            and(
              eq(memberships.workspaceId, workspaceId),
              eq(memberships.id, principal.membershipId),
            ),
          )
          .limit(1);
        const row = rows[0];
        // The explicit else: a membership row removed since the principal was minted is not
        // re-read as some stale role, it is "this principal does not authenticate any more".
        if (row === undefined) return null;
        return {
          principalId,
          kind: 'membership',
          role: row.role,
          label: row.name,
          userId: row.userId,
          apiKeyId: null,
          actsForPrincipalId: null,
        };
      }
      if (principal.apiKeyId === null) {
        throw new Error(
          `workspace_principals ${principalId} is kind 'api_key' with a null api_key_id; the ` +
            'source XOR check should make this unreachable.',
        );
      }
      const rows = await db
        .select({
          role: apiKeys.role,
          name: apiKeys.name,
          expiresAt: apiKeys.expiresAt,
          revokedAt: apiKeys.revokedAt,
        })
        .from(apiKeys)
        .where(and(eq(apiKeys.workspaceId, workspaceId), eq(apiKeys.id, principal.apiKeyId)))
        .limit(1);
      const row = rows[0];
      // An endpoint-scoped key must not mint browser tokens or be re-read as an ordinary
      // principal: ADR-0134 keeps its authority to the one endpoint it is bound to.
      if (
        row !== undefined &&
        (await endpointBindings(db, workspaceId, principal.apiKeyId)).has(principal.apiKeyId)
      ) {
        return null;
      }
      // Re-checks the same freshness `authenticateApiKeyHash` applies to a directly-presented key:
      // a key that has since been revoked or has expired must stop authenticating a browser token
      // it minted on exactly the same request it would stop authenticating itself.
      if (
        row === undefined ||
        row.revokedAt !== null ||
        (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now())
      ) {
        return null;
      }
      // A key that acts for a person never outlives that person's principal or membership.
      if (
        principal.actsForPrincipalId !== null &&
        !(await isActiveMembershipPrincipal(db, workspaceId, principal.actsForPrincipalId))
      ) {
        return null;
      }
      return {
        principalId,
        kind: 'api_key',
        role: row.role,
        label: row.name,
        userId: null,
        apiKeyId: principal.apiKeyId,
        actsForPrincipalId: principal.actsForPrincipalId,
      };
    },
    async findUserByEmail(email) {
      const rows = await db
        .select(USER_COLUMNS)
        .from(users)
        .where(eq(users.email, normaliseEmail(email)))
        .limit(1);
      return rows[0] ?? null;
    },
    async findIdentity(issuer, subject) {
      const rows = await db
        .select({ userId: userIdentities.userId, email: users.email })
        .from(userIdentities)
        .innerJoin(users, eq(users.id, userIdentities.userId))
        .where(and(eq(userIdentities.issuer, issuer), eq(userIdentities.subject, subject)))
        .limit(1);
      return rows[0] ?? null;
    },
    async linkIdentity(issuer, subject, userId) {
      try {
        await db.insert(userIdentities).values({ issuer, subject, userId });
      } catch (error) {
        if (isConstraint(error, 'user_identities_issuer_subject_key')) {
          // A replay is idempotent only when the durable binding still names the same user. A
          // different user is identity substitution, not a successful replay.
          const existing = await db
            .select({ userId: userIdentities.userId })
            .from(userIdentities)
            .where(and(eq(userIdentities.issuer, issuer), eq(userIdentities.subject, subject)))
            .limit(1);
          if (existing[0]?.userId === userId) return;
          throw new Error('OIDC identity is already bound to a different user', { cause: error });
        }
        throw error;
      }
    },
    async membershipsForUser(userId) {
      return db
        .select({
          principalId: workspacePrincipals.id,
          workspaceId: memberships.workspaceId,
          workspaceSlug: workspaces.slug,
          workspaceName: workspaces.name,
          role: memberships.role,
        })
        .from(memberships)
        .innerJoin(
          workspacePrincipals,
          and(
            eq(workspacePrincipals.workspaceId, memberships.workspaceId),
            eq(workspacePrincipals.membershipId, memberships.id),
            eq(workspacePrincipals.kind, 'membership'),
            isNull(workspacePrincipals.revokedAt),
          ),
        )
        .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
        .where(eq(memberships.userId, userId))
        .orderBy(asc(workspaces.name));
    },
    async acceptInvitation(id, tokenHash, identity, now) {
      const email = normaliseEmail(identity.email);
      try {
        return await db.transaction(async (tx) => {
          // One condition, one query: id, hash and email are checked together, so a wrong id, a
          // wrong hash and a wrong email are one and the same "no row" outcome rather than three
          // branches that could disagree about which is faster or which is logged. An archived
          // workspace is folded into that same absence: lifecycle state is part of the positive
          // admission query, not a later rejection that confirms the tenant exists. `FOR UPDATE`
          // serialises a concurrent replay of the same token against the same row.
          const rows = await tx
            .select({ ...INVITATION_COLUMNS, workspaceSlug: workspaces.slug })
            .from(invitations)
            .innerJoin(workspaces, eq(workspaces.id, invitations.workspaceId))
            .where(
              and(
                eq(invitations.id, id),
                eq(invitations.tokenHash, tokenHash),
                eq(invitations.email, email),
                isNull(workspaces.archivedAt),
              ),
            )
            .for('update')
            .limit(1);
          const invitation = rows[0];
          if (invitation === undefined) return { kind: 'invalid' as const };
          // Every branch past this point already matched id, hash and email, so distinguishing them
          // reveals nothing about a workspace the caller could not already prove they were invited
          // to — the concealment property is the query above, not these checks.
          if (invitation.revokedAt !== null) return { kind: 'revoked' as const };
          if (invitation.acceptedAt !== null) return { kind: 'already-accepted' as const };
          if (invitation.expiresAt.getTime() <= now.getTime()) return { kind: 'expired' as const };

          // The OIDC binding is part of this transaction, never a callback-side provisional write.
          // A pre-existing binding must name the same global user as the invitation email. The
          // post-insert re-read handles a concurrent binder; throwing rolls back a user we may have
          // inserted earlier in this transaction instead of leaving residue from a refused accept.
          const existingBindings = await tx
            .select({ userId: userIdentities.userId })
            .from(userIdentities)
            .where(
              and(
                eq(userIdentities.issuer, identity.issuer),
                eq(userIdentities.subject, identity.subject),
              ),
            )
            .limit(1);

          let user: DirectoryUserRecord | undefined;
          const existingBinding = existingBindings[0];
          if (existingBinding !== undefined) {
            const boundUsers = await tx
              .select(USER_COLUMNS)
              .from(users)
              .where(and(eq(users.id, existingBinding.userId), eq(users.email, email)))
              .limit(1);
            user = boundUsers[0];
            if (user === undefined) return { kind: 'invalid' as const };
          } else {
            const existingUsers = await tx
              .select(USER_COLUMNS)
              .from(users)
              .where(eq(users.email, email))
              .limit(1);
            user = existingUsers[0];
            if (user === undefined) {
              const inserted = await tx
                .insert(users)
                .values({ email, name: defaultDisplayName(email) })
                .onConflictDoNothing({ target: users.email })
                .returning(USER_COLUMNS);
              user = inserted[0];
              if (user === undefined) {
                const racedUsers = await tx
                  .select(USER_COLUMNS)
                  .from(users)
                  .where(eq(users.email, email))
                  .limit(1);
                user = racedUsers[0];
              }
            }
            if (user === undefined) throw new Error('invitation acceptance created no user row');

            await tx
              .insert(userIdentities)
              .values({ issuer: identity.issuer, subject: identity.subject, userId: user.id })
              .onConflictDoNothing({
                target: [userIdentities.issuer, userIdentities.subject],
              });
            const committedBindings = await tx
              .select({ userId: userIdentities.userId })
              .from(userIdentities)
              .where(
                and(
                  eq(userIdentities.issuer, identity.issuer),
                  eq(userIdentities.subject, identity.subject),
                ),
              )
              .limit(1);
            if (committedBindings[0]?.userId !== user.id) {
              throw new InvitationIdentityConflict();
            }
          }
          if (user === undefined) throw new Error('invitation acceptance created no user row');

          const insertedMembership = await tx
            .insert(memberships)
            .values({ workspaceId: invitation.workspaceId, userId: user.id, role: invitation.role })
            .onConflictDoNothing({ target: [memberships.workspaceId, memberships.userId] })
            .returning({
              id: memberships.id,
              userId: memberships.userId,
              role: memberships.role,
              createdAt: memberships.createdAt,
            });
          const membershipRow = insertedMembership[0];
          if (membershipRow === undefined) {
            // The token is still consumed: a single-use link that failed only because the invitee
            // already has another way into the workspace must not stay live for a second attempt.
            const existingPrincipals = await tx
              .select({ principalId: workspacePrincipals.id })
              .from(memberships)
              .innerJoin(
                workspacePrincipals,
                and(
                  eq(workspacePrincipals.workspaceId, memberships.workspaceId),
                  eq(workspacePrincipals.membershipId, memberships.id),
                  eq(workspacePrincipals.kind, 'membership'),
                  isNull(workspacePrincipals.revokedAt),
                ),
              )
              .where(
                and(
                  eq(memberships.workspaceId, invitation.workspaceId),
                  eq(memberships.userId, user.id),
                ),
              )
              .limit(1);
            const existingPrincipal = existingPrincipals[0];
            if (existingPrincipal === undefined) {
              throw new Error('existing invitation member has no exact principal');
            }
            await tx
              .update(invitations)
              .set({ acceptedAt: sql`greatest(now(), ${now}::timestamptz)` })
              .where(eq(invitations.id, id));
            return {
              kind: 'already-member' as const,
              workspaceId: invitation.workspaceId,
              userId: user.id,
              principalId: existingPrincipal.principalId,
            };
          }

          const insertedPrincipal = await tx
            .insert(workspacePrincipals)
            .values({
              workspaceId: invitation.workspaceId,
              kind: 'membership',
              membershipId: membershipRow.id,
            })
            .returning({ principalId: workspacePrincipals.id });
          const principal = insertedPrincipal[0];
          if (principal === undefined) {
            throw new Error('membership principal insert returned no row');
          }

          await tx
            .update(invitations)
            .set({ acceptedAt: sql`greatest(now(), ${now}::timestamptz)` })
            .where(eq(invitations.id, id));

          return {
            kind: 'accepted' as const,
            workspaceId: invitation.workspaceId,
            workspaceSlug: invitation.workspaceSlug,
            user,
            membership: {
              ...membershipRow,
              principalId: principal.principalId,
              email,
              name: user.name,
            },
          };
        });
      } catch (error) {
        if (error instanceof InvitationIdentityConflict) return { kind: 'invalid' as const };
        throw error;
      }
    },
  };
}
