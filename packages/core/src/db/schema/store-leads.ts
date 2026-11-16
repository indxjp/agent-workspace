/**
 * `store_leads` — a visitor who signed in to an Agent Store demo (internal spec, "Privacy notice
 * and lead retention"): the address, the demos tried and, from P4, the enquiry. Lead data is
 * personal data under APPI: the retention job deletes a lead once its last contact is older than
 * the configured period (`AW_STORE_LEAD_RETENTION_DAYS`), and the demo workspace it came from is
 * deleted after 24 hours regardless.
 *
 * Not tenant-scoped: a lead is the store's, not a workspace's, and outlives the demo workspace.
 * `tenancy-readers.test-support.ts` records the exemption. Times are written by the caller from its
 * `Clock`.
 */
import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import { primaryKeyId } from './columns.js';

/** The part of an enquiry that is not its message: the entry and the setup the visitor chose. */
export interface StoreEnquiryDetail {
  readonly entry?: string | undefined;
  readonly setup?: Readonly<Record<string, string>> | undefined;
}

export const storeLeads = pgTable(
  'store_leads',
  {
    id: primaryKeyId(),
    /** The lower-cased address. One lead per address; a later sign-in updates it. */
    email: text('email').notNull(),
    /** The catalog entries whose demos the visitor opened, each once, in the order first opened. */
    entries: text('entries')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** The enquiry the visitor sent from the store (P4); `NULL` until one is sent. */
    enquiry: text('enquiry'),
    /** What the enquiry was about: the entry and the Customize-tab setup, when it named any. */
    enquirySetup: jsonb('enquiry_setup').$type<StoreEnquiryDetail>(),
    /** The coming-soon entries the visitor asked to be told about, each once, in order asked. */
    launchNotices: text('launch_notices')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** The latest sign-in or enquiry. The retention period counts from here. */
    lastContactAt: timestamp('last_contact_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('store_leads_email_key').on(table.email),
    index('store_leads_last_contact_idx').on(table.lastContactAt),
    check('store_leads_email_lower_case', sql`${table.email} = lower(${table.email})`),
    check(
      'store_leads_last_contact_after_created',
      sql`${table.lastContactAt} >= ${table.createdAt}`,
    ),
  ],
);

export type StoreLead = typeof storeLeads.$inferSelect;
