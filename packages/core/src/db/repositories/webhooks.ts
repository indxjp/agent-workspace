/**
 * The webhook repository (N-3, issue #250, ADR-SDK-18-N3-250 D1): a workspace's run-outcome
 * endpoints, scoped like every other provider here. It stores where and for which events; the
 * signing secret is the caller's to store through `SecretsService`, and the URL's egress check is
 * the caller's to make before {@link WebhookRepository.create}.
 */
import { isUuid } from '@indx-workspace/contracts';
import { WEBHOOK_MAX_PER_WORKSPACE } from '@indx-workspace/contracts/webhooks';
import { and, asc, count, eq, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { webhooks, type Webhook, type WebhookEventType } from '../schema/webhooks.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';

interface WebhookRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly url: string;
  readonly events: readonly WebhookEventType[];
  readonly createdAt: Date;
}

interface NewWebhookInput {
  /** Already checked by the contract and the egress policy. */
  readonly url: string;
  /** Non-empty and distinct; the caller applies the all-three default. */
  readonly events: readonly WebhookEventType[];
}

type CreateWebhookOutcome =
  | { readonly kind: 'created'; readonly webhook: WebhookRecord }
  | { readonly kind: 'limit-reached'; readonly limit: number };

export interface WebhookRepository {
  /** Every webhook of the workspace, oldest first. At most {@link WEBHOOK_MAX_PER_WORKSPACE}. */
  list(): Promise<readonly WebhookRecord[]>;
  /** `null` for an unknown id, another workspace's id, and a string that is not a UUID. */
  get(id: string): Promise<WebhookRecord | null>;
  /**
   * Insert a webhook unless the workspace already holds {@link WEBHOOK_MAX_PER_WORKSPACE}. The
   * count and the insert are serialised per workspace, so two concurrent creates cannot both pass
   * the last free slot.
   */
  create(input: NewWebhookInput): Promise<CreateWebhookOutcome>;
  /**
   * Delete a webhook and, by cascade, its deliveries, so a pending one is never sent. `false` for
   * an unknown id, another workspace's id, and a string that is not a UUID.
   */
  remove(id: string): Promise<boolean>;
}

export interface WebhookRepositoryProvider {
  forScope(scope: WorkspaceScope): WebhookRepository;
}

function toRecord(row: Webhook): WebhookRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    url: row.url,
    events: [...row.events],
    createdAt: row.createdAt,
  };
}

/** The PostgreSQL {@link WebhookRepositoryProvider}. */
export function createDatabaseWebhookRepositoryProvider(db: Database): WebhookRepositoryProvider {
  return {
    forScope(scope) {
      const { workspaceId } = requireWorkspaceScope(scope, 'WebhookRepositoryProvider');
      const tenant = eq(webhooks.workspaceId, workspaceId);
      const inScope = (id: string) => and(tenant, eq(webhooks.id, id));

      return {
        async list() {
          const rows = await db
            .select()
            .from(webhooks)
            .where(tenant)
            .orderBy(asc(webhooks.createdAt), asc(webhooks.id));
          return rows.map(toRecord);
        },
        async get(id) {
          if (!isUuid(id)) return null;
          const rows = await db.select().from(webhooks).where(inScope(id)).limit(1);
          const row = rows[0];
          return row === undefined ? null : toRecord(row);
        },
        create(input) {
          return db.transaction(async (tx): Promise<CreateWebhookOutcome> => {
            // One lock per workspace's webhook set: the count below cannot go stale before the
            // insert commits.
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${`webhooks:${workspaceId}`}, 0))`,
            );
            const held = await tx.select({ value: count() }).from(webhooks).where(tenant);
            if ((held[0]?.value ?? 0) >= WEBHOOK_MAX_PER_WORKSPACE) {
              return { kind: 'limit-reached', limit: WEBHOOK_MAX_PER_WORKSPACE };
            }
            const inserted = await tx
              .insert(webhooks)
              .values({ workspaceId, url: input.url, events: [...input.events] })
              .returning();
            const row = inserted[0];
            if (row === undefined) throw new Error('webhook insert returned no row');
            return { kind: 'created', webhook: toRecord(row) };
          });
        },
        async remove(id) {
          if (!isUuid(id)) return false;
          const removed = await db
            .delete(webhooks)
            .where(inScope(id))
            .returning({ id: webhooks.id });
          return removed.length > 0;
        },
      };
    },
  };
}
