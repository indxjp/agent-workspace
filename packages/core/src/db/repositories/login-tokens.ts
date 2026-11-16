import { and, eq, gt, gte, isNull, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { loginTokens } from '../schema/login-tokens.js';

/** One email-link row as the sign-in domain writes it: hashes and times, never a secret or address. */
export interface NewLoginTokenRecord {
  readonly id: string;
  /** SHA-256 of the link's secret, lower-case hex. */
  readonly tokenHash: string;
  /** SHA-256 of the lower-cased address, lower-case hex. */
  readonly emailHash: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/**
 * The `login_tokens` table (spec §21, "Guest"). Not tenant-scoped: a link is sent before any
 * workspace exists, so this repository takes no `WorkspaceScope`; `tenancy-readers.test-support.ts`
 * records the exemption.
 */
export interface LoginTokenRepository {
  /**
   * Store a newly issued link if fewer than `limit` links were issued to its `emailHash` at or
   * after `since`: the per-address issue limit. The count and the insert are one transaction under
   * a lock on the address, so concurrent calls for one address, from any number of clients, store
   * at most `limit` rows between them. `true` when the row was stored, `false` when the limit held.
   */
  reserve(
    record: NewLoginTokenRecord,
    window: { readonly since: Date; readonly limit: number },
  ): Promise<boolean>;
  /** Remove a reservation, so a link that could not be sent does not count against the limit. */
  release(id: string): Promise<void>;
  /**
   * Mark the link used if, and only if, one row has this `tokenHash` and `emailHash`, is unused and
   * expires after `now`. One `UPDATE ... RETURNING`, so of two concurrent calls exactly one is
   * `true`. `false` for a reused, expired, tampered or misaddressed link.
   */
  consume(input: {
    readonly tokenHash: string;
    readonly emailHash: string;
    readonly now: Date;
  }): Promise<boolean>;
}

export function createDatabaseLoginTokenRepository(db: Database): LoginTokenRepository {
  return {
    reserve(record, { since, limit }) {
      return db.transaction(async (tx) => {
        // One lock per address for the length of the transaction; a different address never waits.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${record.emailHash}, 0))`,
        );
        const rows = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(loginTokens)
          .where(
            and(eq(loginTokens.emailHash, record.emailHash), gte(loginTokens.createdAt, since)),
          );
        if ((rows[0]?.count ?? 0) >= limit) return false;
        await tx.insert(loginTokens).values({
          id: record.id,
          tokenHash: record.tokenHash,
          emailHash: record.emailHash,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
        });
        return true;
      });
    },
    async release(id) {
      await db.delete(loginTokens).where(eq(loginTokens.id, id));
    },
    async consume({ tokenHash, emailHash, now }) {
      const rows = await db
        .update(loginTokens)
        .set({ usedAt: now })
        .where(
          and(
            eq(loginTokens.tokenHash, tokenHash),
            eq(loginTokens.emailHash, emailHash),
            isNull(loginTokens.usedAt),
            gt(loginTokens.expiresAt, now),
          ),
        )
        .returning({ id: loginTokens.id });
      return rows.length === 1;
    },
  };
}
