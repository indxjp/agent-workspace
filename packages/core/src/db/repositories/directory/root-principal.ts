import { and, eq, isNull } from 'drizzle-orm';

import type { Database } from '../../client.js';
import { apiKeys } from '../../schema/api-keys.js';
import { memberships } from '../../schema/memberships.js';
import { users } from '../../schema/users.js';
import { workspacePrincipals } from '../../schema/workspace-principals.js';
import type { DirectoryPrincipalRecord } from '../directory.js';
import { endpointBindings, isActiveMembershipPrincipal } from './queries.js';

interface PrincipalRow {
  readonly membershipId: string | null;
  readonly apiKeyId: string | null;
  readonly actsForPrincipalId: string | null;
}

async function findLivePrincipal(db: Database, workspaceId: string, principalId: string) {
  const rows = await db
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
  return rows[0];
}

async function membershipPrincipal(
  db: Database,
  workspaceId: string,
  principalId: string,
  principal: PrincipalRow,
): Promise<DirectoryPrincipalRecord | null> {
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
      and(eq(memberships.workspaceId, workspaceId), eq(memberships.id, principal.membershipId)),
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

async function apiKeyPrincipal(
  db: Database,
  workspaceId: string,
  principalId: string,
  principal: PrincipalRow,
): Promise<DirectoryPrincipalRecord | null> {
  if (principal.apiKeyId === null) {
    throw new Error(
      `workspace_principals ${principalId} is kind 'api_key' with a null api_key_id; the ` +
        'source XOR check should make this unreachable.',
    );
  }
  const apiKeyId = principal.apiKeyId;
  const rows = await db
    .select({
      role: apiKeys.role,
      name: apiKeys.name,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.workspaceId, workspaceId), eq(apiKeys.id, apiKeyId)))
    .limit(1);
  const row = rows[0];
  // An endpoint-scoped key must not mint browser tokens or be re-read as an ordinary
  // principal: ADR-0134 keeps its authority to the one endpoint it is bound to.
  if (row !== undefined && (await endpointBindings(db, workspaceId, apiKeyId)).has(apiKeyId)) {
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
    apiKeyId,
    actsForPrincipalId: principal.actsForPrincipalId,
  };
}

/** Re-reads one principal's current identity and role, or `null` when it no longer authenticates. */
export async function readPrincipalById(
  db: Database,
  workspaceId: string,
  principalId: string,
): Promise<DirectoryPrincipalRecord | null> {
  const principal = await findLivePrincipal(db, workspaceId, principalId);
  if (principal === undefined) return null;
  return principal.kind === 'membership'
    ? membershipPrincipal(db, workspaceId, principalId, principal)
    : apiKeyPrincipal(db, workspaceId, principalId, principal);
}
