import { eq } from 'drizzle-orm';

import type { Database } from '../client.js';
import { demoEntryStates } from '../schema/demo-entry-states.js';

/** What the daily production test decided about one entry. */
export type DemoEntryStateName = 'available' | 'maintenance';

/**
 * The daily production test's verdicts (internal spec, "The GCP deployment"): one row per catalog
 * entry, replaced by each verdict. Not tenant-scoped; `tenancy-readers.test-support.ts` records the
 * exemption. Times come from the caller's `Clock`.
 */
export interface DemoEntryStatesRepository {
  /** Keep `state` and its reason as the entry's verdict, replacing the earlier one. */
  set(input: {
    readonly entry: string;
    readonly state: DemoEntryStateName;
    readonly reason: string;
    readonly now: Date;
  }): Promise<void>;
  /** The slugs of the entries whose verdict is `maintenance`, in slug order. */
  underMaintenance(): Promise<readonly string[]>;
}

export function createDatabaseDemoEntryStatesRepository(db: Database): DemoEntryStatesRepository {
  return {
    async set({ entry, state, reason, now }) {
      await db
        .insert(demoEntryStates)
        .values({ entry, state, reason, updatedAt: now })
        .onConflictDoUpdate({
          target: demoEntryStates.entry,
          set: { state, reason, updatedAt: now },
        });
    },
    async underMaintenance() {
      const rows = await db
        .select({ entry: demoEntryStates.entry })
        .from(demoEntryStates)
        .where(eq(demoEntryStates.state, 'maintenance'))
        .orderBy(demoEntryStates.entry);
      return rows.map((row) => row.entry);
    },
  };
}
