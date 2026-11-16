/**
 * `recipe_runs` and `recipe_steps`: a recipe's progress, in the app's own schema (issue #1513).
 * They are the app kit's shared tables, created by the app template's migration
 * `0001_app_kit_recipes`, whose text is {@link createRecipeTablesSql}.
 *
 * Run and principal ids are platform ids, kept as text without foreign keys: app data never
 * references the platform's tables. `workspace_id` is on both tables, and a step's foreign key
 * pairs it with its recipe run's, so a step cannot belong to another workspace's run. An `error`
 * holds a public code only, which a check enforces.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { quoted } from './columns.js';
import { RECIPE_RUN_STATUSES, RECIPE_STEP_STATUSES } from './recipe-port.js';
import { appSchemaName } from './schema-name.js';

export const RECIPE_RUNS_TABLE = 'recipe_runs';
export const RECIPE_STEPS_TABLE = 'recipe_steps';

const listOf = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

const RUN_STATUS_CHECK = `"status" IN (${listOf(RECIPE_RUN_STATUSES)})`;
const STEP_STATUS_CHECK = `"status" IN (${listOf(RECIPE_STEP_STATUSES)})`;
const ERROR_CHECK = `"error" IS NULL OR "error" ~ '^[a-z][a-z0-9_]{0,63}$'`;
const DECISION_CHECK = `"decision" IS NULL OR "decision" IN ('approve', 'reject')`;
/**
 * A continuation exists only after a decision on the step's approval, so only on a step that
 * stopped in `awaiting_approval` with a run of its own.
 */
const CONTINUATION_CHECK = `("continuation_run_id" IS NULL) = ("decision" IS NULL) AND ("decision" IS NULL OR "run_id" IS NOT NULL)`;

/**
 * The Drizzle tables of an app's recipes, for reading them in the app's own queries.
 *
 * @throws {RangeError} when `appName` is not a valid app name.
 */
export function recipeTables(appName: string) {
  const schema = pgSchema(appSchemaName(appName));
  const recipeRuns = schema.table(
    RECIPE_RUNS_TABLE,
    {
      id: uuid('id').primaryKey().defaultRandom(),
      workspace_id: text('workspace_id').notNull(),
      recipe: text('recipe').notNull(),
      status: text('status', { enum: RECIPE_RUN_STATUSES }).notNull(),
      input: jsonb('input').notNull(),
      dedupe_key: text('dedupe_key').notNull(),
      started_by: text('started_by'),
      lease_owner: text('lease_owner'),
      lease_expires_at: timestamp('lease_expires_at', { withTimezone: true, mode: 'string' }),
      error: text('error'),
      created_at: timestamp('created_at', { withTimezone: true, mode: 'string' })
        .notNull()
        .defaultNow(),
      updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' })
        .notNull()
        .defaultNow(),
    },
    (table) => [
      unique(`${RECIPE_RUNS_TABLE}_dedupe_key`).on(
        table.workspace_id,
        table.recipe,
        table.dedupe_key,
      ),
      unique(`${RECIPE_RUNS_TABLE}_workspace_id_id`).on(table.workspace_id, table.id),
      index(`${RECIPE_RUNS_TABLE}_list_idx`).on(
        table.workspace_id,
        table.created_at.desc(),
        table.id.desc(),
      ),
      index(`${RECIPE_RUNS_TABLE}_status_idx`).on(table.workspace_id, table.status),
      check(`${RECIPE_RUNS_TABLE}_status_check`, sql.raw(RUN_STATUS_CHECK)),
      check(`${RECIPE_RUNS_TABLE}_error_check`, sql.raw(ERROR_CHECK)),
    ],
  );
  const recipeSteps = schema.table(
    RECIPE_STEPS_TABLE,
    {
      workspace_id: text('workspace_id').notNull(),
      recipe_run_id: uuid('recipe_run_id').notNull(),
      key: text('key').notNull(),
      status: text('status', { enum: RECIPE_STEP_STATUSES }).notNull(),
      run_id: text('run_id'),
      continuation_run_id: text('continuation_run_id'),
      decision: text('decision', { enum: ['approve', 'reject'] }),
      output: jsonb('output'),
      error: text('error'),
      started_at: timestamp('started_at', { withTimezone: true, mode: 'string' })
        .notNull()
        .defaultNow(),
      ended_at: timestamp('ended_at', { withTimezone: true, mode: 'string' }),
    },
    (table) => [
      primaryKey({ name: `${RECIPE_STEPS_TABLE}_pkey`, columns: [table.recipe_run_id, table.key] }),
      foreignKey({
        name: `${RECIPE_STEPS_TABLE}_recipe_run_fk`,
        columns: [table.workspace_id, table.recipe_run_id],
        foreignColumns: [recipeRuns.workspace_id, recipeRuns.id],
      }).onDelete('cascade'),
      index(`${RECIPE_STEPS_TABLE}_run_id_idx`).on(table.workspace_id, table.run_id),
      index(`${RECIPE_STEPS_TABLE}_continuation_run_id_idx`).on(
        table.workspace_id,
        table.continuation_run_id,
      ),
      check(`${RECIPE_STEPS_TABLE}_status_check`, sql.raw(STEP_STATUS_CHECK)),
      check(`${RECIPE_STEPS_TABLE}_error_check`, sql.raw(ERROR_CHECK)),
      check(`${RECIPE_STEPS_TABLE}_decision_check`, sql.raw(DECISION_CHECK)),
      check(`${RECIPE_STEPS_TABLE}_continuation_check`, sql.raw(CONTINUATION_CHECK)),
    ],
  );
  return { recipeRuns, recipeSteps };
}

/**
 * The two tables as one deterministic SQL text, statements split by Drizzle's breakpoint, for the
 * app's `0001_app_kit_recipes` migration.
 *
 * @throws {RangeError} when `appName` is not a valid app name.
 */
export function createRecipeTablesSql(appName: string): string {
  const schema = quoted(appSchemaName(appName));
  const runs = `${schema}.${quoted(RECIPE_RUNS_TABLE)}`;
  const steps = `${schema}.${quoted(RECIPE_STEPS_TABLE)}`;
  return [
    [
      `CREATE TABLE IF NOT EXISTS ${runs} (`,
      '  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),',
      '  "workspace_id" text NOT NULL,',
      '  "recipe" text NOT NULL,',
      '  "status" text NOT NULL,',
      '  "input" jsonb NOT NULL,',
      '  "dedupe_key" text NOT NULL,',
      '  "started_by" text,',
      '  "lease_owner" text,',
      '  "lease_expires_at" timestamptz,',
      '  "error" text,',
      '  "created_at" timestamptz NOT NULL DEFAULT now(),',
      '  "updated_at" timestamptz NOT NULL DEFAULT now(),',
      `  CONSTRAINT "${RECIPE_RUNS_TABLE}_dedupe_key" UNIQUE ("workspace_id", "recipe", "dedupe_key"),`,
      `  CONSTRAINT "${RECIPE_RUNS_TABLE}_workspace_id_id" UNIQUE ("workspace_id", "id"),`,
      `  CONSTRAINT "${RECIPE_RUNS_TABLE}_status_check" CHECK (${RUN_STATUS_CHECK}),`,
      `  CONSTRAINT "${RECIPE_RUNS_TABLE}_error_check" CHECK (${ERROR_CHECK})`,
      ');',
      `CREATE INDEX IF NOT EXISTS "${RECIPE_RUNS_TABLE}_list_idx" ON ${runs} ("workspace_id", "created_at" DESC, "id" DESC);`,
      `CREATE INDEX IF NOT EXISTS "${RECIPE_RUNS_TABLE}_status_idx" ON ${runs} ("workspace_id", "status");`,
      '',
    ].join('\n'),
    [
      `CREATE TABLE IF NOT EXISTS ${steps} (`,
      '  "workspace_id" text NOT NULL,',
      '  "recipe_run_id" uuid NOT NULL,',
      '  "key" text NOT NULL,',
      '  "status" text NOT NULL,',
      '  "run_id" text,',
      '  "continuation_run_id" text,',
      '  "decision" text,',
      '  "output" jsonb,',
      '  "error" text,',
      '  "started_at" timestamptz NOT NULL DEFAULT now(),',
      '  "ended_at" timestamptz,',
      `  CONSTRAINT "${RECIPE_STEPS_TABLE}_pkey" PRIMARY KEY ("recipe_run_id", "key"),`,
      `  CONSTRAINT "${RECIPE_STEPS_TABLE}_recipe_run_fk" FOREIGN KEY ("workspace_id", "recipe_run_id") REFERENCES ${runs} ("workspace_id", "id") ON DELETE CASCADE,`,
      `  CONSTRAINT "${RECIPE_STEPS_TABLE}_status_check" CHECK (${STEP_STATUS_CHECK}),`,
      `  CONSTRAINT "${RECIPE_STEPS_TABLE}_error_check" CHECK (${ERROR_CHECK}),`,
      `  CONSTRAINT "${RECIPE_STEPS_TABLE}_decision_check" CHECK (${DECISION_CHECK}),`,
      `  CONSTRAINT "${RECIPE_STEPS_TABLE}_continuation_check" CHECK (${CONTINUATION_CHECK})`,
      ');',
      `CREATE INDEX IF NOT EXISTS "${RECIPE_STEPS_TABLE}_run_id_idx" ON ${steps} ("workspace_id", "run_id");`,
      `CREATE INDEX IF NOT EXISTS "${RECIPE_STEPS_TABLE}_continuation_run_id_idx" ON ${steps} ("workspace_id", "continuation_run_id");`,
      '',
    ].join('\n'),
  ].join('--> statement-breakpoint\n');
}
