/**
 * The webhook delivery outbox, as the delivery worker reads and settles it (N-3, issue #250,
 * ADR-SDK-18-N3-250 D4). The rows are written by the run's stop (`runs.ts` `stopIn`), never here.
 *
 * Cross-tenant and unscoped like `listStaleRunIds`, for the same reason: the worker is not acting
 * *as* any one workspace. It sees a delivery's ids, its target URL and its attempt bookkeeping, and
 * nothing of the run; the payload is read afterwards through the run repository scoped to the
 * returned `workspaceId`.
 *
 * ## Claims
 *
 * {@link WebhookDeliveryRepository.claimDue} is one statement: it locks due `pending` rows with
 * `FOR UPDATE SKIP LOCKED`, so two replicas never claim one row, and moves each row's due time past
 * the attempt timeout, so a replica that dies mid-attempt leaves a row that becomes due again by
 * itself. A claim is identified by the row's `attempts` after the claim; every settle below is
 * guarded on it and on `state = 'pending'`, so a late answer from a claim that timed out and was
 * claimed again cannot overwrite the newer claim, and a settled row never changes again.
 *
 * A claim never takes a row that has used `maxAttempts` already. Before it claims, the same call
 * settles any due `pending` row at or over the limit as `failed` with `attempts_exhausted`: a row
 * whose last claim lapsed because the worker died, or threw, mid-attempt. So a row is attempted at
 * most `maxAttempts` times whatever the worker does, and `attempts` (a `smallint`) cannot grow
 * without bound.
 */
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';

import type { Database } from '../client.js';
import { webhookDeliveries } from '../schema/webhook-deliveries.js';
import type { WebhookEventType } from '../schema/webhooks.js';

/** The longest stored `last_error`: a short code, never a receiver's body. */
const MAX_ERROR_LENGTH = 200;
/** The `last_error` of a row a claim settled because it had used every attempt. */
const EXHAUSTED_ERROR = 'attempts_exhausted';

/** One claimed delivery: what the worker needs to build and send one attempt. */
interface ClaimedWebhookDelivery {
  /** The event id, sent as `webhook-id`. */
  readonly id: string;
  readonly workspaceId: string;
  readonly webhookId: string;
  readonly runId: string;
  readonly eventType: WebhookEventType;
  /** The webhook's URL, read in the same statement as the claim. */
  readonly url: string;
  /** The attempt this claim is, counting from 1; the token every settle call is guarded on. */
  readonly attempt: number;
  /** When the run stopped and the row was written: the event's `createdAt`. */
  readonly createdAt: Date;
}

interface ClaimDueInput {
  /** The most rows one claim takes. */
  readonly limit: number;
  /** How long the claim holds the row before it is due again (above the attempt timeout). */
  readonly claimMs: number;
  /** The most attempts a row gets; a due row that has had them is settled `failed`, not claimed. */
  readonly maxAttempts: number;
}

/** The outcome of one failed attempt, as stored: a status code if there was one, and a code. */
interface WebhookAttemptFailure {
  readonly statusCode: number | null;
  readonly error: string;
}

export interface WebhookDeliveryRepository {
  /**
   * Claim up to `limit` due pending deliveries with attempts left, oldest due first, across every
   * workspace, after settling due ones with none left as `failed`.
   */
  claimDue(input: ClaimDueInput): Promise<readonly ClaimedWebhookDelivery[]>;
  /** A 2xx: settle the claim as `delivered`. `false` when the claim is no longer the row's. */
  markDelivered(id: string, attempt: number, statusCode: number): Promise<boolean>;
  /** A failed attempt with attempts left: due again at `at`. `false` for a stale claim. */
  scheduleRetry(
    id: string,
    attempt: number,
    at: Date,
    failure: WebhookAttemptFailure,
  ): Promise<boolean>;
  /** The last attempt failed: settle the claim as `failed`. `false` for a stale claim. */
  markFailed(id: string, attempt: number, failure: WebhookAttemptFailure): Promise<boolean>;
  /**
   * Give a claim back without counting it as an attempt, due again at `at`: the wait for
   * accounting to settle (ADR D3). `false` for a stale claim.
   */
  deferClaim(id: string, attempt: number, at: Date): Promise<boolean>;
  /** Delete settled (`delivered` or `failed`) deliveries written before `before`. Returns how many. */
  pruneSettled(before: Date): Promise<number>;
}

function storedError(error: string): string {
  const trimmed = error.trim();
  return (trimmed === '' ? 'unknown_error' : trimmed).slice(0, MAX_ERROR_LENGTH);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

/** The PostgreSQL {@link WebhookDeliveryRepository}. */
export function createDatabaseWebhookDeliveryRepository(db: Database): WebhookDeliveryRepository {
  /** The row as one claim left it: still pending, and still this claim's. */
  const heldBy = (id: string, attempt: number) =>
    and(
      eq(webhookDeliveries.id, id),
      eq(webhookDeliveries.state, 'pending'),
      eq(webhookDeliveries.attempts, attempt),
    );

  const settle = async (
    id: string,
    attempt: number,
    set: PgUpdateSetSource<typeof webhookDeliveries>,
  ): Promise<boolean> => {
    const updated = await db
      .update(webhookDeliveries)
      .set(set)
      .where(heldBy(id, attempt))
      .returning({ id: webhookDeliveries.id });
    return updated.length > 0;
  };

  return {
    async claimDue({ limit, claimMs, maxAttempts }) {
      assertPositiveInteger(limit, 'limit');
      assertPositiveInteger(claimMs, 'claimMs');
      assertPositiveInteger(maxAttempts, 'maxAttempts');
      await db.execute(sql`
        with exhausted as (
          select id from webhook_deliveries
          where state = 'pending' and next_attempt_at <= now() and attempts >= ${maxAttempts}
          order by next_attempt_at
          limit ${limit}
          for update skip locked
        )
        update webhook_deliveries as delivery
        set state = 'failed',
            last_attempt_at = coalesce(delivery.last_attempt_at, now()),
            last_error = ${EXHAUSTED_ERROR}
        from exhausted
        where delivery.id = exhausted.id`);
      const claimed = await db.execute<{
        id: string;
        workspace_id: string;
        webhook_id: string;
        run_id: string;
        event_type: WebhookEventType;
        url: string;
        attempts: number;
        created_at: Date | string;
      }>(sql`
        with due as (
          select id from webhook_deliveries
          where state = 'pending' and next_attempt_at <= now() and attempts < ${maxAttempts}
          order by next_attempt_at
          limit ${limit}
          for update skip locked
        )
        update webhook_deliveries as delivery
        set attempts = delivery.attempts + 1,
            next_attempt_at = now() + make_interval(secs => ${claimMs / 1000})
        from due, webhooks as webhook
        where delivery.id = due.id
          and webhook.workspace_id = delivery.workspace_id
          and webhook.id = delivery.webhook_id
        returning delivery.id, delivery.workspace_id, delivery.webhook_id, delivery.run_id,
          delivery.event_type, webhook.url, delivery.attempts, delivery.created_at`);
      return claimed.rows.map((row) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        webhookId: row.webhook_id,
        runId: row.run_id,
        eventType: row.event_type,
        url: row.url,
        attempt: Number(row.attempts),
        createdAt: new Date(row.created_at),
      }));
    },
    markDelivered(id, attempt, statusCode) {
      return settle(id, attempt, {
        state: 'delivered',
        deliveredAt: sql`now()`,
        lastAttemptAt: sql`now()`,
        lastStatusCode: statusCode,
        lastError: null,
      });
    },
    scheduleRetry(id, attempt, at, failure) {
      return settle(id, attempt, {
        nextAttemptAt: at,
        lastAttemptAt: sql`now()`,
        lastStatusCode: failure.statusCode,
        lastError: storedError(failure.error),
      });
    },
    markFailed(id, attempt, failure) {
      return settle(id, attempt, {
        state: 'failed',
        lastAttemptAt: sql`now()`,
        lastStatusCode: failure.statusCode,
        lastError: storedError(failure.error),
      });
    },
    async deferClaim(id, attempt, at) {
      const updated = await db
        .update(webhookDeliveries)
        .set({ attempts: sql`${webhookDeliveries.attempts} - 1`, nextAttemptAt: at })
        .where(heldBy(id, attempt))
        .returning({ id: webhookDeliveries.id });
      return updated.length > 0;
    },
    async pruneSettled(before) {
      const removed = await db
        .delete(webhookDeliveries)
        .where(
          and(
            inArray(webhookDeliveries.state, ['delivered', 'failed']),
            lt(webhookDeliveries.createdAt, before),
          ),
        )
        .returning({ id: webhookDeliveries.id });
      return removed.length;
    },
  };
}
