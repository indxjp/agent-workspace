/**
 * The demo sweeps' port (internal spec, "Email-link sign-in" and "Privacy notice and lead
 * retention"). The sweeps ride the trigger driver (`triggers/schedule-cron.ts`) under the
 * maintenance lease, like the agent auto-archive sweep: delete each demo workspace once its
 * `demo_expires_at` has passed, delete spent and expired `login_tokens`, prune
 * `demo_run_admissions` older than the caps look back, and delete leads (`../ports.ts`,
 * `LeadStore`) past `AW_STORE_LEAD_RETENTION_DAYS`. The lead job does not run while that setting
 * is unset.
 */

/** The rows the sweeps delete. PostgreSQL in production, memory in tests. */
export interface DemoSweepStore {
  /** Ids of demo workspaces whose end is at or before `now`, oldest end first, at most `limit`. */
  expiredWorkspaceIds(now: Date, limit: number): Promise<readonly string[]>;
  /**
   * In one transaction: add the workspace's model spend, per UTC day, to `demo_daily_costs`, then
   * delete the workspace and everything in it. `false`, changing nothing, unless it is a demo
   * workspace whose end is at or before `now`, so a real workspace is never deleted.
   */
  deleteExpiredWorkspace(workspaceId: string, now: Date): Promise<boolean>;
  /** Delete `login_tokens` rows that expired or were used before `cutoff`; how many went. */
  deleteLoginTokensBefore(cutoff: Date): Promise<number>;
  /** Delete `demo_run_admissions` rows made before `cutoff`; how many went. */
  deleteAdmissionsBefore(cutoff: Date): Promise<number>;
  /**
   * Delete the guest users nothing holds: an address recorded as a lead (so an email link signed it
   * in; no other user is ever deleted here), created before `cutoff`, with no membership, no
   * identity-provider identity, no admission left and nothing referencing them. Their email is
   * personal data the demo does not keep past its 24 hours; only the lead is. Run after the
   * admissions are pruned, so the person's run cap is never reset by it. How many went.
   */
  deleteIdleGuestUsersBefore(cutoff: Date): Promise<number>;
}

/**
 * The object-storage side of a demo workspace's deletion: its files' bytes go through the files
 * domain, not around it, before the workspace's rows do. Production reads the catalog and removes
 * each file through the storage service; tests use memory.
 */
export interface DemoWorkspaceFiles {
  /** Remove every file the workspace holds. Rejects when one cannot be removed. */
  removeAll(workspaceId: string): Promise<void>;
}
