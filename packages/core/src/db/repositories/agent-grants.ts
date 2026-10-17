/**
 * `agent_grants` repository — the mechanism behind spec §21's Viewer "run permitted agents"
 * (issue #117). Copies `./agents.ts`'s shape, narrowed to the one question a caller ever asks of
 * it: does a named grant exist. There is no create/list/delete here because this task's Minimum
 * implementation names no grant-management API — see `docs/adr/W9-AUTH-117-*.md`.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { agentGrants } from '../schema/agent-grants.js';
import { agents } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';

/**
 * Grant lookups for exactly one workspace. No method takes a workspace id — the same rule every
 * repository in this directory holds, so a call site has no parameter at which the tenant filter
 * can be forgotten.
 */
export interface AgentGrantRepository {
  /** Whether `agent_grants` names this exact (agent, user) pair in this workspace. */
  hasGrant(agentId: string, userId: string): Promise<boolean>;
  /** Membership principals currently permitted to run this agent. */
  listPrincipalIds(agentId: string): Promise<readonly string[] | null>;
  /** Atomically replace the complete grant set after validating every principal in this tenant. */
  replacePrincipalIds(
    agentId: string,
    principalIds: readonly string[],
  ): Promise<
    | { readonly kind: 'updated'; readonly principalIds: readonly string[] }
    | { readonly kind: 'agent-not-found' }
    | { readonly kind: 'principal-not-found'; readonly principalId: string }
  >;
}

/** Hands out an {@link AgentGrantRepository} bound to one workspace. */
export interface AgentGrantRepositoryProvider {
  forScope(scope: WorkspaceScope): AgentGrantRepository;
}

/** The PostgreSQL {@link AgentGrantRepositoryProvider}. */
export function createDatabaseAgentGrantRepositoryProvider(
  db: Database,
): AgentGrantRepositoryProvider {
  return {
    forScope(scope: WorkspaceScope): AgentGrantRepository {
      const checked = requireWorkspaceScope(scope, 'AgentGrantRepositoryProvider');
      return {
        async hasGrant(agentId: string, userId: string): Promise<boolean> {
          const rows = await db
            .select({ id: agentGrants.id })
            .from(agentGrants)
            .where(
              and(
                eq(agentGrants.workspaceId, checked.workspaceId),
                eq(agentGrants.agentId, agentId),
                eq(agentGrants.userId, userId),
              ),
            )
            .limit(1);
          return rows.length > 0;
        },
        async listPrincipalIds(agentId: string): Promise<readonly string[] | null> {
          const agentRows = await db
            .select({ id: agents.id })
            .from(agents)
            .where(and(eq(agents.workspaceId, checked.workspaceId), eq(agents.id, agentId)))
            .limit(1);
          if (agentRows.length === 0) return null;
          const rows = await db
            .select({ principalId: workspacePrincipals.id })
            .from(agentGrants)
            .innerJoin(
              memberships,
              and(
                eq(memberships.workspaceId, agentGrants.workspaceId),
                eq(memberships.userId, agentGrants.userId),
              ),
            )
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
                eq(agentGrants.workspaceId, checked.workspaceId),
                eq(agentGrants.agentId, agentId),
              ),
            )
            .orderBy(asc(workspacePrincipals.id));
          return rows.map((row) => row.principalId);
        },
        async replacePrincipalIds(agentId, principalIds) {
          return db.transaction(async (tx) => {
            // A replacement is one set operation. Serialising callers for the same agent prevents
            // READ COMMITTED delete/insert interleavings from leaving a union or a unique-key 500.
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtext(${`${checked.workspaceId}:${agentId}`}))`,
            );
            const agentRows = await tx
              .select({ id: agents.id })
              .from(agents)
              .where(and(eq(agents.workspaceId, checked.workspaceId), eq(agents.id, agentId)))
              .limit(1);
            if (agentRows.length === 0) return { kind: 'agent-not-found' as const };

            const principalRows =
              principalIds.length === 0
                ? []
                : await tx
                    .select({
                      principalId: workspacePrincipals.id,
                      userId: memberships.userId,
                    })
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
                        eq(workspacePrincipals.workspaceId, checked.workspaceId),
                        eq(workspacePrincipals.kind, 'membership'),
                        isNull(workspacePrincipals.revokedAt),
                        inArray(workspacePrincipals.id, principalIds),
                      ),
                    );
            const usersByPrincipal = new Map(
              principalRows.map((row) => [row.principalId, row.userId] as const),
            );
            for (const principalId of principalIds) {
              if (!usersByPrincipal.has(principalId)) {
                return { kind: 'principal-not-found' as const, principalId };
              }
            }

            await tx
              .delete(agentGrants)
              .where(
                and(
                  eq(agentGrants.workspaceId, checked.workspaceId),
                  eq(agentGrants.agentId, agentId),
                ),
              );
            if (principalIds.length > 0) {
              const replacements: Array<{
                workspaceId: string;
                agentId: string;
                userId: string;
              }> = [];
              for (const principalId of principalIds) {
                const userId = usersByPrincipal.get(principalId);
                if (userId === undefined) {
                  throw new Error('validated grant principal lost its membership mapping');
                }
                replacements.push({
                  workspaceId: checked.workspaceId,
                  agentId,
                  userId,
                });
              }
              await tx.insert(agentGrants).values(replacements);
            }
            return { kind: 'updated' as const, principalIds: [...principalIds].sort() };
          });
        },
      };
    },
  };
}
