/**
 * `webhooks` — the endpoints a workspace has the platform post its runs' outcomes to (N-3, issue
 * #250, ADR-SDK-18-N3-250 D1). A row says where (`url`) and for which terminal outcomes
 * (`events`); `webhook_deliveries` is the outbox of what is owed to it.
 *
 * The signing secret is not here. The platform must sign with it, so it cannot be hashed; it is
 * stored through `SecretsService` under a name derived from the id (`WEBHOOK_<ID>_SIGNING_SECRET`,
 * ADR D1), the way a trigger's Zoom token is. A webhook has no update: a change is a remove and a
 * create, and a remove deletes the row, which cascades to its pending deliveries so nothing more is
 * sent to it.
 *
 * `url` is validated by the contract and by the egress policy at create (ADR D5); the checks here
 * are the storage bounds only.
 */
import { WEBHOOK_EVENT_TYPES, WEBHOOK_URL_MAX_LENGTH } from '@indx-workspace/contracts/webhooks';
import { check, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { createdAt, primaryKeyId } from './columns.js';
import { workspaces } from './workspaces.js';

export const webhookEventTypes = WEBHOOK_EVENT_TYPES;
export type WebhookEventType = (typeof webhookEventTypes)[number];

/** The only shape an event type may take, so inlining it into a `CHECK` needs no quoting. */
const SAFE_EVENT_TYPE = /^run\.[a-z]+(?:_[a-z]+)*$/u;

/**
 * `ARRAY['run.completed', …]::text[]` for DDL inlining. A value outside {@link SAFE_EVENT_TYPE}
 * throws at module load rather than being escaped, the way `oneOf` gates its values.
 */
export function webhookEventTypeArray(): ReturnType<typeof sql.raw> {
  for (const type of webhookEventTypes) {
    if (!SAFE_EVENT_TYPE.test(type)) throw new Error(`unsafe webhook event type ${type}`);
  }
  return sql.raw(`ARRAY[${webhookEventTypes.map((type) => `'${type}'`).join(', ')}]::text[]`);
}

export const webhooks = pgTable(
  'webhooks',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    /** A non-empty subset of the event types; the contract also refuses a repeated one. */
    events: text('events').array().notNull().$type<WebhookEventType[]>(),
    createdAt: createdAt(),
  },
  (table) => [
    // The target of the tenant-paired reference from `webhook_deliveries`, and the tenant index.
    unique('webhooks_workspace_id_key').on(table.workspaceId, table.id),
    check(
      'webhooks_url_length',
      sql`char_length(${table.url}) between 1 and ${sql.raw(String(WEBHOOK_URL_MAX_LENGTH))}`,
    ),
    check(
      'webhooks_events_valid',
      sql`cardinality(${table.events}) between 1 and ${sql.raw(String(webhookEventTypes.length))} and ${table.events} <@ ${webhookEventTypeArray()}`,
    ),
  ],
);

export type Webhook = typeof webhooks.$inferSelect;
export type NewWebhook = typeof webhooks.$inferInsert;
