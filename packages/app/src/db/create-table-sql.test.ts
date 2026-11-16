import { describe, expect, it } from 'vitest';

import { enumOf, money, person, richText, tags, text } from '../fields/index.js';
import { definePages } from '../pages/define-pages.js';
import { defineResource } from '../resource.js';
import { createAuditTableSql } from './audit.js';
import { createTableSql } from './create-table-sql.js';
import { appSchemaName, derivedIdentifier } from './schema-name.js';

const tickets = defineResource({
  name: 'ticket',
  fields: {
    title: text({ max: 200 }),
    body: richText({ optional: true }),
    status: enumOf(['open', 'closed'], { default: 'open' }),
    assignee: person({ optional: true }),
    budget: money({ currency: 'JPY', optional: true }),
    labels: tags(),
  },
  access: { read: 'member', create: 'member', update: 'member', delete: 'role:admin' },
  search: ['title', 'body'],
});

describe('createTableSql', () => {
  it('renders the fixture resource as committed', () => {
    expect(createTableSql(tickets, 'service-desk')).toMatchInlineSnapshot(`
      "CREATE TABLE IF NOT EXISTS "app_service_desk"."tickets" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "workspace_id" text NOT NULL,
        "created_by" text NOT NULL,
        "updated_by" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "title" text NOT NULL,
        "body" jsonb,
        "status" text NOT NULL,
        "assignee" uuid,
        "budget" numeric,
        "budget_currency" text,
        "labels" text[] NOT NULL,
        "_search" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce("title", '')) || to_tsvector('simple'::regconfig, coalesce("body", '[]'::jsonb))) STORED,
        CONSTRAINT "tickets_title_check" CHECK (char_length("title") <= 200),
        CONSTRAINT "tickets_body_check" CHECK (jsonb_typeof("body") = 'array'),
        CONSTRAINT "tickets_status_check" CHECK ("status" IN ('open', 'closed')),
        CONSTRAINT "tickets_budget_currency_check" CHECK ("budget_currency" = 'JPY'),
        CONSTRAINT "tickets_labels_check" CHECK (cardinality("labels") <= 100)
      );
      CREATE INDEX IF NOT EXISTS "tickets_list_idx" ON "app_service_desk"."tickets" ("workspace_id", "created_at" DESC, "id" DESC);
      CREATE INDEX IF NOT EXISTS "tickets_search_idx" ON "app_service_desk"."tickets" USING gin ("_search");
      "
    `);
  });

  it('gives the same bytes for the same input', () => {
    expect(createTableSql(tickets, 'service-desk')).toBe(createTableSql(tickets, 'service-desk'));
    expect(createAuditTableSql('service-desk')).toBe(createAuditTableSql('service-desk'));
  });

  it('has no search column or index without search', () => {
    const notes = defineResource({
      name: 'note',
      fields: { title: text() },
      access: { read: 'member', create: 'member', update: 'member', delete: 'member' },
    });
    const sql = createTableSql(notes, 'desk');
    expect(sql).not.toContain('_search');
    expect(sql).not.toContain('gin');
  });

  it('gives the page kind its terms column, its revision pointer and its revisions table', () => {
    const pages = definePages({
      access: { read: 'member', create: 'member', update: 'member', delete: 'member' },
    });
    const sql = createTableSql(pages, 'wiki');
    expect(sql).toContain(`"_search_text" text NOT NULL DEFAULT '',\n  "_revision_id" uuid,`);
    expect(sql).toContain(
      `"_search" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, "_search_text")) STORED`,
    );
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "app_wiki"."page_revisions" (');
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "page_revisions_list_idx" ON "app_wiki"."page_revisions" ("workspace_id", "page_id", "at" DESC, "id" DESC);',
    );
    // Deleting a page keeps its history: the revisions reference no page row.
    expect(sql).not.toContain('REFERENCES');
  });

  it('refuses an app name that is not a name key', () => {
    expect(() => createTableSql(tickets, 'Service Desk')).toThrow(RangeError);
    expect(() => createTableSql(tickets, `a${'b'.repeat(59)}`)).toThrow(RangeError);
  });
});

describe('app schema names and derived identifiers', () => {
  it('maps a kebab app name to app_<snake>', () => {
    expect(appSchemaName('service-desk')).toBe('app_service_desk');
    expect(appSchemaName('a'.repeat(59))).toHaveLength(63);
  });

  it('keeps a derived identifier within 63 characters and distinct', () => {
    const long = 'x'.repeat(60);
    const one = derivedIdentifier(long, 'list_idx');
    const other = derivedIdentifier(`${'x'.repeat(59)}y`, 'list_idx');
    expect(one.length).toBeLessThanOrEqual(63);
    expect(one.endsWith('_list_idx')).toBe(true);
    expect(one).not.toBe(other);
    expect(derivedIdentifier('tickets', 'list_idx')).toBe('tickets_list_idx');
  });
});
