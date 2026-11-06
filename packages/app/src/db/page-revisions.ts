/**
 * `<name>_revisions` (`page_revisions` for the default name): every saved state of a page's title
 * and body, in the app's own schema (issue #1520). `createTableSql` of a `definePages` resource
 * appends {@link createPageRevisionsSql}, so the generated migration creates the pages and their
 * history together; the table is never altered after (forward-only).
 *
 * `page_id` has no foreign key on purpose: deleting a page (a subtree, with `cascade`) keeps its
 * revisions, which a cascading key would delete and a restricting one would block. The page store
 * writes a revision only in the transaction that saves its page, in the page's workspace, which
 * every row carries. The author is a principal id kept as text, as `created_by` and the audit
 * table's `actor` are (an identity assertion's subject is opaque, ADR-0142); every agent save
 * carries its run, which a check enforces.
 */
import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import type { DefinedResource } from '../resource.js';
import { quoted } from './columns.js';
import { appSchemaName, derivedIdentifier } from './schema-name.js';

const VIA_CHECK = `"via" IN ('person', 'agent')`;
/** Every agent save carries the run it was made in (F-10). */
const AGENT_RUN_CHECK = `"via" <> 'agent' OR "run_id" IS NOT NULL`;
const BLOCKS_CHECK = `jsonb_typeof("blocks") = 'array'`;

/** The revisions table of a `definePages` resource: `<name>_revisions`. */
export function pageRevisionsTableName(resource: DefinedResource): string {
  return derivedIdentifier(resource.name, 'revisions');
}

function namesOf(table: string) {
  return {
    list: derivedIdentifier(table, 'list_idx'),
    via: derivedIdentifier(table, 'via_check'),
    agentRun: derivedIdentifier(table, 'agent_run_check'),
    blocks: derivedIdentifier(table, 'blocks_check'),
  };
}

/**
 * The Drizzle table of a page resource's revisions, for an app's own queries.
 *
 * @throws {RangeError} when `appName` is not a valid app name.
 */
export function pageRevisionsTable(resource: DefinedResource, appName: string) {
  const name = pageRevisionsTableName(resource);
  const names = namesOf(name);
  return pgSchema(appSchemaName(appName)).table(
    name,
    {
      id: uuid('id').primaryKey().defaultRandom(),
      workspace_id: text('workspace_id').notNull(),
      page_id: uuid('page_id').notNull(),
      title: text('title').notNull(),
      blocks: jsonb('blocks').notNull(),
      author_principal_id: text('author_principal_id').notNull(),
      via: text('via', { enum: ['person', 'agent'] }).notNull(),
      run_id: text('run_id'),
      at: timestamp('at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    },
    (table) => [
      index(names.list).on(table.workspace_id, table.page_id, table.at.desc(), table.id.desc()),
      check(names.via, sql.raw(VIA_CHECK)),
      check(names.agentRun, sql.raw(AGENT_RUN_CHECK)),
      check(names.blocks, sql.raw(BLOCKS_CHECK)),
    ],
  );
}

/**
 * The revisions table of `resource` as deterministic SQL, with its newest-first index on
 * `(workspace_id, page_id, at DESC, id DESC)`.
 *
 * @throws {RangeError} when `appName` is not a valid app name.
 */
export function createPageRevisionsSql(resource: DefinedResource, appName: string): string {
  const name = pageRevisionsTableName(resource);
  const names = namesOf(name);
  const table = `${quoted(appSchemaName(appName))}.${quoted(name)}`;
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (`,
    '  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),',
    '  "workspace_id" text NOT NULL,',
    '  "page_id" uuid NOT NULL,',
    '  "title" text NOT NULL,',
    '  "blocks" jsonb NOT NULL,',
    '  "author_principal_id" text NOT NULL,',
    '  "via" text NOT NULL,',
    '  "run_id" text,',
    '  "at" timestamptz NOT NULL DEFAULT now(),',
    `  CONSTRAINT ${quoted(names.via)} CHECK (${VIA_CHECK}),`,
    `  CONSTRAINT ${quoted(names.agentRun)} CHECK (${AGENT_RUN_CHECK}),`,
    `  CONSTRAINT ${quoted(names.blocks)} CHECK (${BLOCKS_CHECK})`,
    ');',
    `CREATE INDEX IF NOT EXISTS ${quoted(names.list)} ON ${table} ("workspace_id", "page_id", "at" DESC, "id" DESC);`,
    '',
  ].join('\n');
}
