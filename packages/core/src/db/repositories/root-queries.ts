import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { agents } from '../schema/agents.js';
import { auditEvents } from '../schema/audit-events.js';
import { workspaces } from '../schema/workspaces.js';
import { checkedAuditEvent } from './audit-events.js';
import type { DatabaseRoot, WorkspaceMembership } from './root.js';

type RootQueries = Pick<
  DatabaseRoot,
  | 'listWorkspaceIds'
  | 'findShareWorkspace'
  | 'resolveMembership'
  | 'getWorkspaceModelDefault'
  | 'setWorkspaceModelDefault'
  | 'getWorkspaceSetupAgentId'
  | 'setWorkspaceSetupAgentId'
  | 'clearWorkspaceSetupAgentId'
  | 'recordAuditEvent'
>;

// `updated_at` is set to itself, overriding Drizzle's `$onUpdate`, and `materialised_version_id`
// is left alone: marking or clearing the setup agent is not an edit (C21, plan §4).
async function markSetupAgent(
  db: Database,
  workspaceId: string,
  agentId: string,
  at: Date | null,
): Promise<boolean> {
  const rows = await db
    .update(agents)
    .set({ setupConfiguredAt: at, updatedAt: sql`${agents.updatedAt}` })
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)))
    .returning({ id: agents.id });
  return rows.length > 0;
}

/** The checked membership lookup: workspace by slug, user by email, membership, live principal. */
async function resolveMembership(
  db: Database,
  email: string,
  workspaceSlug: string,
): Promise<WorkspaceMembership | null> {
  const workspace = await db.query.workspaces.findFirst({
    columns: { id: true },
    where: (row, { eq }) => eq(row.slug, workspaceSlug),
  });
  if (workspace === undefined) return null;

  const user = await db.query.users.findFirst({
    columns: { id: true, name: true },
    where: (row, { eq }) => eq(row.email, email),
  });
  if (user === undefined) return null;

  const membership = await db.query.memberships.findFirst({
    columns: { id: true, role: true },
    where: (row, { and, eq }) => and(eq(row.workspaceId, workspace.id), eq(row.userId, user.id)),
  });
  // The explicit else. An identity exists because three rows were read and agreed, never
  // because nothing objected (ADR-0015).
  if (membership === undefined) return null;

  const principal = await db.query.workspacePrincipals.findFirst({
    columns: { id: true },
    where: (row, { and, eq, isNull }) =>
      and(
        eq(row.workspaceId, workspace.id),
        eq(row.membershipId, membership.id),
        eq(row.kind, 'membership'),
        isNull(row.revokedAt),
      ),
  });
  if (principal === undefined) return null;

  return {
    principalId: principal.id,
    userId: user.id,
    userLabel: user.name,
    workspaceId: workspace.id,
    role: membership.role,
  };
}

/** The unscoped root queries of {@link DatabaseRoot}: bounded projections, no row content. */
export function rootQueries(db: Database): RootQueries {
  return {
    listWorkspaceIds: async () =>
      (await db.query.workspaces.findMany({ columns: { id: true } })).map(({ id }) => id),
    findShareWorkspace: async (tokenHash) =>
      (
        await db.query.shares.findFirst({
          columns: { workspaceId: true },
          // This unscoped lookup is used only by the anonymous /p surface. Workspace/private
          // shares must never disclose even which tenant owns their otherwise-valid token.
          where: (row, { and, eq }) =>
            and(eq(row.tokenHash, tokenHash), eq(row.visibility, 'public')),
        })
      )?.workspaceId ?? null,
    resolveMembership: (email, workspaceSlug) => resolveMembership(db, email, workspaceSlug),
    async getWorkspaceModelDefault(workspaceId) {
      const row = await db.query.workspaces.findFirst({
        columns: { defaultModelConnectionId: true, defaultModel: true },
        where: (candidate, { eq: matches }) => matches(candidate.id, workspaceId),
      });
      if (row === undefined || row.defaultModelConnectionId === null || row.defaultModel === null) {
        return null;
      }
      return { connectionId: row.defaultModelConnectionId, model: row.defaultModel };
    },
    async setWorkspaceModelDefault(workspaceId, value) {
      const rows = await db
        .update(workspaces)
        .set({
          defaultModelConnectionId: value === null ? null : value.connectionId,
          defaultModel: value === null ? null : value.model,
        })
        .where(eq(workspaces.id, workspaceId))
        .returning({ id: workspaces.id });
      return rows.length > 0;
    },
    async getWorkspaceSetupAgentId(workspaceId) {
      const [row] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.workspaceId, workspaceId), isNotNull(agents.setupConfiguredAt)))
        .orderBy(desc(agents.setupConfiguredAt))
        .limit(1);
      return row?.id ?? null;
    },
    setWorkspaceSetupAgentId: (workspaceId, agentId) =>
      markSetupAgent(db, workspaceId, agentId, new Date()),
    clearWorkspaceSetupAgentId: (workspaceId, agentId) =>
      markSetupAgent(db, workspaceId, agentId, null),
    async recordAuditEvent(event) {
      const insert = db.insert(auditEvents).values(checkedAuditEvent(event));
      // A caller that names the id names the event: writing it again (a retry after a lost reply)
      // is the same row, not a second one.
      await (event.id === undefined
        ? insert
        : insert.onConflictDoNothing({ target: auditEvents.id }));
    },
  };
}
