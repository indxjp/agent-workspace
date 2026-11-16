import { and, eq, exists, inArray, isNotNull, lt, lte, notExists, or, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { demoDailyCosts } from '../schema/demo-daily-costs.js';
import { demoRunAdmissions } from '../schema/demo-run-admissions.js';
import { loginTokens } from '../schema/login-tokens.js';
import { mcpServers } from '../schema/mcp-servers.js';
import { memberships } from '../schema/memberships.js';
import { projects } from '../schema/projects.js';
import { runUsageRecords } from '../schema/run-usage-records.js';
import { runs } from '../schema/runs.js';
import { sessions } from '../schema/sessions.js';
import { shares } from '../schema/shares.js';
import { storeLeads } from '../schema/store-leads.js';
import { userIdentities } from '../schema/user-identities.js';
import { users } from '../schema/users.js';
import { workspaces } from '../schema/workspaces.js';

/**
 * The rows the Agent Store demo sweeps delete (internal spec, "Email-link sign-in"): demo
 * workspaces past their end, spent or expired `login_tokens`, and `demo_run_admissions` older than
 * the caps look back. Not tenant-scoped; `tenancy-readers.test-support.ts` records the exemption.
 */
export interface DemoSweepRepository {
  /** Ids of demo workspaces whose end is at or before `now`, oldest end first, at most `limit`. */
  expiredWorkspaceIds(now: Date, limit: number): Promise<readonly string[]>;
  /**
   * In one transaction: add the workspace's model spend, per UTC day, to `demo_daily_costs`, then
   * delete the workspace (every tenant table cascades from it). `false`, changing nothing, unless
   * the workspace has a `demo_expires_at` at or before `now`.
   */
  deleteExpiredWorkspace(workspaceId: string, now: Date): Promise<boolean>;
  /** Delete `login_tokens` that expired, or were used, before `cutoff`; how many went. */
  deleteLoginTokensBefore(cutoff: Date): Promise<number>;
  /** Delete `demo_run_admissions` made before `cutoff`; how many went. */
  deleteAdmissionsBefore(cutoff: Date): Promise<number>;
  /**
   * Delete the users an email link made and nothing now holds: an address recorded as a lead
   * (`store_leads`, written only by the demo provisioner when an email link binds a guest),
   * created before `cutoff`, with no membership, no identity-provider identity, no admission still inside the caps' look-back and
   * nothing that references them (a session, a project, a share). The guest's email address is
   * personal data the 24-hour demo does not keep; only the lead does. Run it after the admissions
   * are pruned, so a person's run cap is never reset by it. A user a binding holds locked is
   * left for the next sweep. How many went.
   */
  deleteIdleGuestUsersBefore(cutoff: Date): Promise<number>;
}

export function createDatabaseDemoSweepRepository(db: Database): DemoSweepRepository {
  return {
    async expiredWorkspaceIds(now, limit) {
      const rows = await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(and(isNotNull(workspaces.demoExpiresAt), lte(workspaces.demoExpiresAt, now)))
        .orderBy(workspaces.demoExpiresAt, workspaces.id)
        .limit(limit);
      return rows.map((row) => row.id);
    },
    deleteExpiredWorkspace(workspaceId, now) {
      return db.transaction(async (tx) => {
        // The row lock keeps a second sweep from carrying the same spend twice.
        const [locked] = await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(
            and(
              eq(workspaces.id, workspaceId),
              isNotNull(workspaces.demoExpiresAt),
              lte(workspaces.demoExpiresAt, now),
            ),
          )
          .for('update');
        if (locked === undefined) return false;
        const day = sql<string>`(date_trunc('day', ${runUsageRecords.createdAt} at time zone 'UTC'))::date::text`;
        const spend = await tx
          .select({
            day,
            total: sql<string>`coalesce(sum(${runUsageRecords.costUsd}), 0)::text`,
            unpriced: sql<boolean>`bool_or(${runs.accountingState} <> 'complete')`,
          })
          .from(runUsageRecords)
          .innerJoin(runs, eq(runs.id, runUsageRecords.runId))
          .where(eq(runUsageRecords.workspaceId, workspaceId))
          .groupBy(day);
        // A run whose settlement failed has no ledger row to carry; its day is unpriced.
        const failedDay = sql<string>`(date_trunc('day', ${runs.createdAt} at time zone 'UTC'))::date::text`;
        const failed = await tx
          .select({ day: failedDay })
          .from(runs)
          .where(and(eq(runs.workspaceId, workspaceId), eq(runs.accountingState, 'failed')))
          .groupBy(failedDay);
        const carry = new Map<string, { total: string; unpriced: boolean }>();
        for (const row of spend) carry.set(row.day, { total: row.total, unpriced: row.unpriced });
        for (const row of failed) {
          carry.set(row.day, { total: carry.get(row.day)?.total ?? '0', unpriced: true });
        }
        for (const [carriedDay, { total, unpriced }] of carry) {
          await tx
            .insert(demoDailyCosts)
            .values({ day: carriedDay, costUsd: total, unpricedUsage: unpriced, updatedAt: now })
            .onConflictDoUpdate({
              target: demoDailyCosts.day,
              set: {
                costUsd: sql`${demoDailyCosts.costUsd} + excluded.cost_usd`,
                unpricedUsage: sql`${demoDailyCosts.unpricedUsage} or excluded.unpriced_usage`,
                updatedAt: now,
              },
            });
        }
        // `mcp_servers` references `secrets` with ON DELETE RESTRICT, which is checked the moment a
        // secret goes. Whether the workspace's cascade reaches a connector before its secret
        // depends on the order PostgreSQL fires the two foreign keys' triggers in (their object
        // ids), which no test of ours controls, so the connectors go first, explicitly.
        await tx.delete(mcpServers).where(eq(mcpServers.workspaceId, workspaceId));
        await tx.delete(workspaces).where(eq(workspaces.id, workspaceId));
        return true;
      });
    },
    async deleteLoginTokensBefore(cutoff) {
      const rows = await db
        .delete(loginTokens)
        .where(or(lt(loginTokens.expiresAt, cutoff), lt(loginTokens.usedAt, cutoff)))
        .returning({ id: loginTokens.id });
      return rows.length;
    },
    async deleteAdmissionsBefore(cutoff) {
      const rows = await db
        .delete(demoRunAdmissions)
        .where(lt(demoRunAdmissions.createdAt, cutoff))
        .returning({ id: demoRunAdmissions.id });
      return rows.length;
    },
    deleteIdleGuestUsersBefore(cutoff) {
      return db.transaction(async (tx) => {
        const idle = await tx
          .select({ id: users.id })
          .from(users)
          .where(
            and(
              lt(users.createdAt, cutoff),
              // Only an address that signed in through an email link: a user an administrator made,
              // or any other user with no membership and no identity, is never deleted here.
              exists(
                tx
                  .select({ one: sql`1` })
                  .from(storeLeads)
                  .where(eq(storeLeads.email, users.email)),
              ),
              notExists(
                tx
                  .select({ one: sql`1` })
                  .from(memberships)
                  .where(eq(memberships.userId, users.id)),
              ),
              notExists(
                tx
                  .select({ one: sql`1` })
                  .from(userIdentities)
                  .where(eq(userIdentities.userId, users.id)),
              ),
              notExists(
                tx
                  .select({ one: sql`1` })
                  .from(demoRunAdmissions)
                  .where(eq(demoRunAdmissions.userId, users.id)),
              ),
              notExists(
                tx
                  .select({ one: sql`1` })
                  .from(sessions)
                  .where(eq(sessions.userId, users.id)),
              ),
              notExists(
                tx
                  .select({ one: sql`1` })
                  .from(projects)
                  .where(eq(projects.createdBy, users.id)),
              ),
              notExists(
                tx
                  .select({ one: sql`1` })
                  .from(shares)
                  .where(eq(shares.createdBy, users.id)),
              ),
            ),
          )
          .for('update', { skipLocked: true });
        if (idle.length === 0) return 0;
        const gone = await tx
          .delete(users)
          .where(
            inArray(
              users.id,
              idle.map((row) => row.id),
            ),
          )
          .returning({ id: users.id });
        return gone.length;
      });
    },
  };
}
