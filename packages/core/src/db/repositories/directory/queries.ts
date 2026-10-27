import { and, eq, isNull } from 'drizzle-orm';

import type { Database } from '../../client.js';
import { apiKeys } from '../../schema/api-keys.js';
import { endpointClientAgents } from '../../schema/endpoint-client-agents.js';
import { endpointClientApiKeys } from '../../schema/endpoint-client-api-keys.js';
import { endpointClients, type EndpointClientKind } from '../../schema/endpoint-clients.js';
import { invitations } from '../../schema/invitations.js';
import { memberships } from '../../schema/memberships.js';
import { users } from '../../schema/users.js';
import { workspacePrincipals } from '../../schema/workspace-principals.js';
import type { DirectoryEndpointScope } from '../directory.js';
import { postgresViolations } from '../violations.js';

/**
 * The reserved head of every API key name the local runtime (`aw dev`, ADR-0109) mints. Owned by
 * core so that {@link DatabaseWorkspaceDirectory.reassignLocalRuntimeKeyOwnership} selects exactly
 * these keys and no caller can widen the selection to hosted keys (issue #509, S1-24).
 */
export const LOCAL_RUNTIME_API_KEY_NAME_PREFIX = 'aw dev local runtime ';

export const USER_COLUMNS = {
  id: users.id,
  email: users.email,
  name: users.name,
  createdAt: users.createdAt,
} as const;
export const KEY_ROW_COLUMNS = {
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
export const KEY_COLUMNS = {
  ...KEY_ROW_COLUMNS,
  principalId: workspacePrincipals.id,
  actsForPrincipalId: workspacePrincipals.actsForPrincipalId,
} as const;
export const INVITATION_COLUMNS = {
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

export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Whether `principalId` is an unrevoked membership principal of `workspaceId` whose membership row
 * is still present: the only principal an API key may act for (issue #509, S1-24), and the check
 * that keeps a key from outliving the person it acts for.
 */
export async function isActiveMembershipPrincipal(
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
export async function endpointBindings(
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
    const scope = endpointScopeOf(row);
    bindings.set(row.apiKeyId, { scope, clientRevokedAt: row.revokedAt });
  }
  return bindings;
}

/**
 * The scope an endpoint client's API key carries. A `builder` client binds no key (it is reached
 * by an OAuth token only), so a key bound to one fails closed instead of becoming another scope.
 */
function endpointScopeOf(row: {
  readonly kind: EndpointClientKind;
  readonly clientId: string;
  readonly agentId: string | null;
}): DirectoryEndpointScope | null {
  switch (row.kind) {
    case 'mcp-project':
      return { kind: 'mcp-project', clientId: row.clientId };
    case 'a2a-agent':
      return row.agentId === null
        ? null
        : { kind: 'a2a-agent', clientId: row.clientId, agentId: row.agentId };
    case 'builder':
      throw new Error('A builder endpoint client has no API key.');
    default: {
      const unreachable: never = row.kind;
      throw new Error(`unhandled endpoint client kind ${String(unreachable)}`);
    }
  }
}

export function normaliseEmail(email: string): string {
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
export function isConstraint(error: unknown, constraint: string): boolean {
  for (const violation of postgresViolations(error)) {
    if (violation.constraint === constraint) return true;
  }
  return false;
}
