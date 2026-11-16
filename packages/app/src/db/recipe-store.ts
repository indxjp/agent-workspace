/**
 * `recipeStoreOf`: the {@link RecipeStore} over PostgreSQL (issue #1513), in the app's schema.
 *
 * Every value is a bound parameter; identifiers come from the validated app name. The lease is
 * one conditional `UPDATE … RETURNING`, so of two replicas claiming a run, one wins; a start with
 * a dedupe key already taken returns the run that holds it (`ON CONFLICT`). An `error` is a public
 * code, checked here and by the table.
 */
import { sql, type SQL } from 'drizzle-orm';

import type { Json } from '../recipe.js';
import { quoted } from './columns.js';
import { pageRequestOf } from './policy.js';
import type { Page } from './port.js';
import {
  publicCodeOf,
  recipeRunsListKey,
  recipeRunsPage,
  type ApprovalDecision,
  type NewRecipeRun,
  type RecipeRunRecord,
  type RecipeRunStatus,
  type RecipeStepRecord,
  type RecipeStore,
} from './recipe-port.js';
import { RECIPE_RUNS_TABLE, RECIPE_STEPS_TABLE } from './recipe-tables.js';
import { appSchemaName } from './schema-name.js';
import type { AppSqlRunner } from './store.js';

/** What {@link recipeStoreOf} takes. */
export interface RecipeStoreOptions {
  readonly db: AppSqlRunner;
  /** The app's name key; the tables live in the schema `app_<name>`. */
  readonly appName: string;
}

const TIMESTAMP_US = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const at = (column: string): string =>
  `to_char("${column}" AT TIME ZONE 'UTC', ${TIMESTAMP_US}) AS "${column}"`;

const RUN_COLUMNS = sql.raw(
  [
    '"id"',
    '"workspace_id"',
    '"recipe"',
    '"status"',
    '"input"',
    '"dedupe_key"',
    '"started_by"',
    '"lease_owner"',
    at('lease_expires_at'),
    '"error"',
    at('created_at'),
    at('updated_at'),
  ].join(', '),
);

const STEP_COLUMNS = sql.raw(
  [
    '"recipe_run_id"',
    '"key"',
    '"status"',
    '"run_id"',
    '"continuation_run_id"',
    '"decision"',
    '"output"',
    '"error"',
    at('started_at'),
    at('ended_at'),
  ].join(', '),
);

type Raw = Record<string, unknown>;

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function runOf(raw: Raw): RecipeRunRecord {
  return {
    id: String(raw['id']),
    workspaceId: String(raw['workspace_id']),
    recipe: String(raw['recipe']),
    status: raw['status'] as RecipeRunStatus,
    input: (raw['input'] ?? null) as Json,
    dedupeKey: String(raw['dedupe_key']),
    startedBy: textOrNull(raw['started_by']),
    leaseOwner: textOrNull(raw['lease_owner']),
    leaseExpiresAt: textOrNull(raw['lease_expires_at']),
    error: textOrNull(raw['error']),
    createdAt: String(raw['created_at']),
    updatedAt: String(raw['updated_at']),
  };
}

function stepOf(raw: Raw): RecipeStepRecord {
  return {
    recipeRunId: String(raw['recipe_run_id']),
    key: String(raw['key']),
    status: raw['status'] as RecipeStepRecord['status'],
    runId: textOrNull(raw['run_id']),
    continuationRunId: textOrNull(raw['continuation_run_id']),
    decision: textOrNull(raw['decision']) as ApprovalDecision | null,
    output: (raw['output'] ?? null) as Json | null,
    error: textOrNull(raw['error']),
    startedAt: String(raw['started_at']),
    endedAt: textOrNull(raw['ended_at']),
  };
}

const jsonParameter = (value: Json): SQL => sql`${JSON.stringify(value)}::jsonb`;
const instant = (value: Date): SQL => sql`${value.toISOString()}::timestamptz`;

/**
 * The recipe store of `options.appName` over PostgreSQL, on the tables its migrations created.
 *
 * @throws {RangeError} when `appName` is not a valid app name.
 */
export function recipeStoreOf(options: RecipeStoreOptions): RecipeStore {
  const { db } = options;
  const schema = quoted(appSchemaName(options.appName));
  const runs = sql.raw(`${schema}.${quoted(RECIPE_RUNS_TABLE)}`);
  const steps = sql.raw(`${schema}.${quoted(RECIPE_STEPS_TABLE)}`);

  const runRows = async (query: SQL): Promise<RecipeRunRecord[]> =>
    (await db.execute(query)).rows.map(runOf);
  const stepRows = async (query: SQL): Promise<RecipeStepRecord[]> =>
    (await db.execute(query)).rows.map(stepOf);
  const firstRun = async (query: SQL): Promise<RecipeRunRecord | null> =>
    (await runRows(query))[0] ?? null;
  const firstStep = async (query: SQL): Promise<RecipeStepRecord | null> =>
    (await stepRows(query))[0] ?? null;

  return {
    async insertOrGetRun(run: NewRecipeRun) {
      const inserted = await firstRun(
        sql`INSERT INTO ${runs} ("workspace_id", "recipe", "status", "input", "dedupe_key", "started_by", "created_at", "updated_at") VALUES (${run.workspaceId}, ${run.recipe}, 'running', ${jsonParameter(run.input)}, ${run.dedupeKey}, ${run.startedBy}, ${instant(run.at)}, ${instant(run.at)}) ON CONFLICT ("workspace_id", "recipe", "dedupe_key") DO NOTHING RETURNING ${RUN_COLUMNS}`,
      );
      if (inserted !== null) return { run: inserted, created: true };
      const existing = await firstRun(
        sql`SELECT ${RUN_COLUMNS} FROM ${runs} WHERE "workspace_id" = ${run.workspaceId} AND "recipe" = ${run.recipe} AND "dedupe_key" = ${run.dedupeKey}`,
      );
      if (existing === null) throw new Error('the recipe run holding the dedupe key vanished');
      return { run: existing, created: false };
    },

    getRun: (workspaceId, id) =>
      firstRun(
        sql`SELECT ${RUN_COLUMNS} FROM ${runs} WHERE "workspace_id" = ${workspaceId} AND "id" = ${id}::uuid`,
      ),

    claimLease: (workspaceId, id, owner, now, until) =>
      firstRun(
        sql`UPDATE ${runs} SET "lease_owner" = ${owner}, "lease_expires_at" = ${instant(until)}, "updated_at" = ${instant(now)} WHERE "workspace_id" = ${workspaceId} AND "id" = ${id}::uuid AND "status" = 'running' AND ("lease_expires_at" IS NULL OR "lease_expires_at" < ${instant(now)}) RETURNING ${RUN_COLUMNS}`,
      ),

    async renewLease(id, owner, until) {
      const { rows } = await db.execute(
        sql`UPDATE ${runs} SET "lease_expires_at" = ${instant(until)} WHERE "id" = ${id}::uuid AND "lease_owner" = ${owner} AND "status" = 'running' RETURNING "id"`,
      );
      return rows.length === 1;
    },

    async releaseLease(id, owner) {
      await db.execute(
        sql`UPDATE ${runs} SET "lease_owner" = NULL, "lease_expires_at" = NULL WHERE "id" = ${id}::uuid AND "lease_owner" = ${owner}`,
      );
    },

    async setRunStatus(id, status, error, now) {
      const code = error === null ? null : publicCodeOf(error);
      await db.execute(
        sql`UPDATE ${runs} SET "status" = ${status}, "error" = ${code}, "lease_owner" = NULL, "lease_expires_at" = NULL, "updated_at" = ${instant(now)} WHERE "id" = ${id}::uuid`,
      );
    },

    listResumable: (workspaceId, now, limit) =>
      runRows(
        sql`SELECT ${RUN_COLUMNS} FROM ${runs} WHERE "workspace_id" = ${workspaceId} AND "status" = 'running' AND ("lease_expires_at" IS NULL OR "lease_expires_at" < ${instant(now)}) ORDER BY "created_at", "id" LIMIT ${limit}`,
      ),

    listWaiting: (workspaceId, limit) =>
      runRows(
        sql`SELECT ${RUN_COLUMNS} FROM ${runs} WHERE "workspace_id" = ${workspaceId} AND "status" = 'waiting' ORDER BY "created_at", "id" LIMIT ${limit}`,
      ),

    async listRuns(workspaceId, listOptions = {}): Promise<Page<RecipeRunRecord>> {
      const listKey = recipeRunsListKey(listOptions);
      const request = pageRequestOf(listOptions, listKey, workspaceId);
      const after =
        request.after === null
          ? sql`TRUE`
          : sql`("created_at", "id") < (${request.after.createdAt}::timestamptz, ${request.after.id}::uuid)`;
      const recipe =
        listOptions.recipe === undefined ? sql`TRUE` : sql`"recipe" = ${listOptions.recipe}`;
      const status =
        listOptions.status === undefined ? sql`TRUE` : sql`"status" = ${listOptions.status}`;
      const rows = await runRows(
        sql`SELECT ${RUN_COLUMNS} FROM ${runs} WHERE "workspace_id" = ${workspaceId} AND ${recipe} AND ${status} AND ${after} ORDER BY "created_at" DESC, "id" DESC LIMIT ${request.limit + 1}`,
      );
      return recipeRunsPage(rows, request, workspaceId, listKey);
    },

    async findRunsByPlatformRun(workspaceId, runId) {
      const { rows } = await db.execute(
        sql`SELECT DISTINCT "recipe_run_id" FROM ${steps} WHERE "workspace_id" = ${workspaceId} AND ("run_id" = ${runId} OR "continuation_run_id" = ${runId})`,
      );
      return rows.map((row) => String(row['recipe_run_id']));
    },

    getStep: (recipeRunId, key) =>
      firstStep(
        sql`SELECT ${STEP_COLUMNS} FROM ${steps} WHERE "recipe_run_id" = ${recipeRunId}::uuid AND "key" = ${key}`,
      ),

    listSteps: (recipeRunId) =>
      stepRows(
        sql`SELECT ${STEP_COLUMNS} FROM ${steps} WHERE "recipe_run_id" = ${recipeRunId}::uuid ORDER BY "started_at", "key"`,
      ),

    async upsertStepRunning(recipeRunId, key, now) {
      await db.execute(
        sql`INSERT INTO ${steps} ("workspace_id", "recipe_run_id", "key", "status", "started_at") SELECT "workspace_id", "id", ${key}, 'running', ${instant(now)} FROM ${runs} WHERE "id" = ${recipeRunId}::uuid ON CONFLICT ("recipe_run_id", "key") DO NOTHING`,
      );
      const step = await firstStep(
        sql`SELECT ${STEP_COLUMNS} FROM ${steps} WHERE "recipe_run_id" = ${recipeRunId}::uuid AND "key" = ${key}`,
      );
      if (step === null) throw new Error('the recipe run of the step does not exist');
      return step;
    },

    async recordStepRun(recipeRunId, key, runId) {
      await db.execute(
        sql`UPDATE ${steps} SET "run_id" = ${runId} WHERE "recipe_run_id" = ${recipeRunId}::uuid AND "key" = ${key}`,
      );
    },

    async suspendStep(recipeRunId, key) {
      await db.execute(
        sql`UPDATE ${steps} SET "status" = 'awaiting_approval' WHERE "recipe_run_id" = ${recipeRunId}::uuid AND "key" = ${key}`,
      );
    },

    async recordDecision(recipeRunId, key, decision, continuationRunId) {
      await db.execute(
        sql`UPDATE ${steps} SET "status" = 'running', "decision" = ${decision}, "continuation_run_id" = ${continuationRunId} WHERE "recipe_run_id" = ${recipeRunId}::uuid AND "key" = ${key}`,
      );
    },

    async completeStep(recipeRunId, key, output, now) {
      await db.execute(
        sql`UPDATE ${steps} SET "status" = 'completed', "output" = ${jsonParameter(output)}, "error" = NULL, "ended_at" = ${instant(now)} WHERE "recipe_run_id" = ${recipeRunId}::uuid AND "key" = ${key}`,
      );
    },

    async failStep(recipeRunId, key, code, now) {
      const error = publicCodeOf(code);
      await db.execute(
        sql`UPDATE ${steps} SET "status" = 'failed', "error" = ${error}, "ended_at" = ${instant(now)} WHERE "recipe_run_id" = ${recipeRunId}::uuid AND "key" = ${key}`,
      );
    },
  };
}
