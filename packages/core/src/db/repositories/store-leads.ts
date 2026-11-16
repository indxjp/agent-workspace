import { lt, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { storeLeads, type StoreEnquiryDetail } from '../schema/store-leads.js';

/**
 * The `store_leads` table (internal spec, "Privacy notice and lead retention"). Not tenant-scoped:
 * a lead is the store's, and outlives the demo workspace it came from, so this repository takes no
 * `WorkspaceScope`; `tenancy-readers.test-support.ts` records the exemption.
 *
 * The demo provisioner records a contact each time a visitor's link binds them; the retention job
 * deletes the leads whose last contact is older than the configured period. Times come from the
 * caller's `Clock`.
 */
export interface StoreLeadRepository {
  /**
   * Record a contact from `email` (lower-cased by the caller) at `now`: one statement that makes
   * the lead or updates it. `entry`, when given, joins the lead's entries once. The last contact
   * never moves back, so a late write cannot shorten the retention of a newer one.
   */
  recordContact(input: {
    readonly email: string;
    readonly entry: string | null;
    readonly now: Date;
  }): Promise<void>;
  /**
   * Keep `message` as the enquiry of `email`'s lead (made if new), with the entry and setup it was
   * about. A later enquiry replaces the earlier one. The last contact moves to `now`, never back.
   */
  recordEnquiry(input: {
    readonly email: string;
    readonly message: string;
    readonly detail: StoreEnquiryDetail | null;
    readonly now: Date;
  }): Promise<void>;
  /**
   * Add `entry` to the launch notices of `email`'s lead (made if new), once. The last contact moves
   * to `now`, never back.
   */
  recordLaunchNotice(input: {
    readonly email: string;
    readonly entry: string;
    readonly now: Date;
  }): Promise<void>;
  /** Delete every lead last contacted before `cutoff`, and answer how many went. */
  deleteLastContactBefore(cutoff: Date): Promise<number>;
}

export function createDatabaseStoreLeadRepository(db: Database): StoreLeadRepository {
  return {
    async recordContact({ email, entry, now }) {
      const entries = entry === null ? [] : [entry];
      await db
        .insert(storeLeads)
        .values({ email, entries, createdAt: now, lastContactAt: now })
        .onConflictDoUpdate({
          target: storeLeads.email,
          set: {
            lastContactAt: sql`greatest(${storeLeads.lastContactAt}, excluded.last_contact_at)`,
            entries: sql`case
              when cardinality(excluded.entries) = 0 then ${storeLeads.entries}
              when excluded.entries[1] = any(${storeLeads.entries}) then ${storeLeads.entries}
              else array_append(${storeLeads.entries}, excluded.entries[1])
            end`,
          },
        });
    },
    async recordEnquiry({ email, message, detail, now }) {
      await db
        .insert(storeLeads)
        .values({
          email,
          enquiry: message,
          enquirySetup: detail,
          createdAt: now,
          lastContactAt: now,
        })
        .onConflictDoUpdate({
          target: storeLeads.email,
          set: {
            enquiry: message,
            enquirySetup: detail,
            lastContactAt: sql`greatest(${storeLeads.lastContactAt}, excluded.last_contact_at)`,
          },
        });
    },
    async recordLaunchNotice({ email, entry, now }) {
      await db
        .insert(storeLeads)
        .values({ email, launchNotices: [entry], createdAt: now, lastContactAt: now })
        .onConflictDoUpdate({
          target: storeLeads.email,
          set: {
            lastContactAt: sql`greatest(${storeLeads.lastContactAt}, excluded.last_contact_at)`,
            launchNotices: sql`case
              when ${entry} = any(${storeLeads.launchNotices}) then ${storeLeads.launchNotices}
              else array_append(${storeLeads.launchNotices}, ${entry})
            end`,
          },
        });
    },
    async deleteLastContactBefore(cutoff) {
      const rows = await db
        .delete(storeLeads)
        .where(lt(storeLeads.lastContactAt, cutoff))
        .returning({ id: storeLeads.id });
      return rows.length;
    },
  };
}
