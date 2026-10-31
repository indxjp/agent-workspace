import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Database } from '../../client.js';
import { agents } from '../../schema/agents.js';
import { apiKeys } from '../../schema/api-keys.js';
import { endpointClientAgents } from '../../schema/endpoint-client-agents.js';
import { endpointClientApiKeys } from '../../schema/endpoint-client-api-keys.js';
import { endpointClients } from '../../schema/endpoint-clients.js';
import { files } from '../../schema/files.js';
import { invitations } from '../../schema/invitations.js';
import { mcpServers } from '../../schema/mcp-servers.js';
import { memberships, type MembershipRole } from '../../schema/memberships.js';
import { projects } from '../../schema/projects.js';
import { sessions } from '../../schema/sessions.js';
import { shares } from '../../schema/shares.js';
import { skills } from '../../schema/skills.js';
import { users } from '../../schema/users.js';
import { workspacePrincipals } from '../../schema/workspace-principals.js';
import type {
  DatabaseWorkspaceDirectory,
  DirectoryApiKeyRecord,
  DirectoryEndpointScope,
  DirectoryInvitationRecord,
  DirectoryMembershipRecord,
} from '../directory.js';
import {
  endpointBindings,
  INVITATION_COLUMNS,
  isActiveMembershipPrincipal,
  isConstraint,
  KEY_COLUMNS,
  KEY_ROW_COLUMNS,
  LOCAL_RUNTIME_API_KEY_NAME_PREFIX,
  normaliseEmail,
  type Transaction,
  USER_COLUMNS,
} from './queries.js';
import { UUID_PATTERN } from '../runs/rows.js';

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

export function createDatabaseWorkspaceDirectory(
  db: Database,
  workspaceId: string,
): DatabaseWorkspaceDirectory {
  // One query for both reads, so a by-principal lookup can never see a different set of members
  // than the list: a membership whose principal is revoked is in neither.
  const membershipRows = (principalId?: string) =>
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
      .where(
        and(
          eq(memberships.workspaceId, workspaceId),
          principalId === undefined ? undefined : eq(workspacePrincipals.id, principalId),
        ),
      )
      .orderBy(asc(users.email));

  const listMemberships = async (): Promise<readonly DirectoryMembershipRecord[]> =>
    membershipRows();

  const findMembershipByPrincipal = async (
    principalId: string,
  ): Promise<DirectoryMembershipRecord | null> =>
    // `workspace_principals.id` is a uuid column: a malformed id is no principal, not a driver error.
    UUID_PATTERN.test(principalId)
      ? ((await membershipRows(principalId).limit(1))[0] ?? null)
      : null;

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
    findMembershipByPrincipal,
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
              .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, 'owner')));
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
          switch (client.kind) {
            case 'mcp-project':
              scope = { kind: 'mcp-project', clientId: endpointClientId };
              break;
            case 'a2a-agent':
              if (client.agentId === null) {
                throw new Error('An a2a endpoint client must name exactly one agent.');
              }
              scope = { kind: 'a2a-agent', clientId: endpointClientId, agentId: client.agentId };
              break;
            case 'builder':
              throw new Error('A builder endpoint client has no API key.');
            case 'app-backend':
              throw new Error('An app-backend endpoint client has no API key.');
            default: {
              const unreachable: never = client.kind;
              throw new Error(`unhandled endpoint client kind ${String(unreachable)}`);
            }
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
}
