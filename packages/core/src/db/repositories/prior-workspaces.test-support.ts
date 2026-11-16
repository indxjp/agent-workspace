import { sql } from 'drizzle-orm';

import type { Database } from '../client.js';

/** The columns every migration of `workspaces` has had. */
export interface PriorWorkspaceRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

/**
 * Insert workspaces into a database migrated only to an earlier revision. A typed
 * `insert(workspaces)` names every column of today's schema, so it fails there once a later
 * migration adds a column; this names only the columns the table has always had.
 */
export async function insertPriorWorkspaces(
  db: Database,
  rows: PriorWorkspaceRow | readonly PriorWorkspaceRow[],
): Promise<void> {
  const list: readonly PriorWorkspaceRow[] = 'id' in rows ? [rows] : rows;
  for (const row of list) {
    await db.execute(
      sql`insert into workspaces (id, slug, name) values (${row.id}, ${row.slug}, ${row.name})`,
    );
  }
}
