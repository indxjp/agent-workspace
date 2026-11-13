/**
 * The `RecipeStore` port (issue #1513): the recipe runner's progress in the app's `recipe_runs`
 * and `recipe_steps` tables. `recipeStoreOf` (`./recipe-store.ts`) implements it over PostgreSQL
 * and `memoryRecipeStore` in `@indx-workspace/app/testing` in memory; both keep the same rules.
 *
 * Run and principal ids are platform ids kept as text, never foreign keys. An `error` column holds
 * a public code only (`^[a-z][a-z0-9_]{0,63}$`), never provider or SQL text.
 */
import type { Json } from '../recipe.js';
import { pageOf, type PageRequest } from './policy.js';
import type { Page } from './port.js';

export const RECIPE_RUN_STATUSES = [
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
] as const;
export type RecipeRunStatus = (typeof RECIPE_RUN_STATUSES)[number];

export const RECIPE_STEP_STATUSES = [
  'running',
  'awaiting_approval',
  'completed',
  'failed',
] as const;
export type RecipeStepStatus = (typeof RECIPE_STEP_STATUSES)[number];

export type ApprovalDecision = 'approve' | 'reject';

/** The only text an `error` column may hold: a public code. */
export const PUBLIC_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

/** One recipe run. Times are ISO-8601 instants. */
export interface RecipeRunRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly recipe: string;
  readonly status: RecipeRunStatus;
  readonly input: Json;
  readonly dedupeKey: string;
  /** The principal id of the person it runs for; `null` for a schedule. */
  readonly startedBy: string | null;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  /** A public code once `failed`, else `null`. */
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One step of a recipe run. */
export interface RecipeStepRecord {
  readonly recipeRunId: string;
  readonly key: string;
  readonly status: RecipeStepStatus;
  /** The platform run the step started, recorded before the step waits on it. */
  readonly runId: string | null;
  /** The run a decision on the step's approval started; set only with `decision`. */
  readonly continuationRunId: string | null;
  readonly decision: ApprovalDecision | null;
  readonly output: Json | null;
  readonly error: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

/** What starting a recipe run records. */
export interface NewRecipeRun {
  readonly workspaceId: string;
  readonly recipe: string;
  readonly input: Json;
  readonly dedupeKey: string;
  readonly startedBy: string | null;
  readonly at: Date;
}

/** What {@link RecipeStore.listRuns} may be asked: a page, of one recipe, in one status. */
export interface RecipeRunListOptions {
  readonly limit?: number;
  readonly cursor?: string;
  readonly recipe?: string;
  readonly status?: RecipeRunStatus;
}

/** The recipe runner's storage. Every method that is not keyed by a unique id is workspace-scoped. */
export interface RecipeStore {
  /** Inserts a `running` run, or returns the one already holding `(workspace, recipe, dedupeKey)`. */
  insertOrGetRun(
    run: NewRecipeRun,
  ): Promise<{ readonly run: RecipeRunRecord; readonly created: boolean }>;
  getRun(workspaceId: string, id: string): Promise<RecipeRunRecord | null>;
  /**
   * Takes the lease of a `running` run whose lease is free or expired at `at`, in one conditional
   * update: of two claimers, one wins. `null` when another holds it or the run is not `running`.
   */
  claimLease(
    workspaceId: string,
    id: string,
    owner: string,
    at: Date,
    until: Date,
  ): Promise<RecipeRunRecord | null>;
  /** Extends a lease `owner` still holds; `false` when it was lost. */
  renewLease(id: string, owner: string, until: Date): Promise<boolean>;
  /** Frees a lease `owner` holds, leaving the status; a crashed holder's lease simply expires. */
  releaseLease(id: string, owner: string): Promise<void>;
  /** Sets the status (and `error`, a public code, for `failed`) and frees the lease. */
  setRunStatus(id: string, status: RecipeRunStatus, error: string | null, at: Date): Promise<void>;
  /** `running` runs whose lease is free or expired at `at`, oldest first. */
  listResumable(workspaceId: string, at: Date, limit: number): Promise<readonly RecipeRunRecord[]>;
  /** `waiting` runs, oldest first. */
  listWaiting(workspaceId: string, limit: number): Promise<readonly RecipeRunRecord[]>;
  /**
   * The workspace's runs, newest first, cursor-paged, of one recipe and one status when asked. A
   * cursor is bound to its filters as well as its workspace (issue #1514).
   */
  listRuns(workspaceId: string, options?: RecipeRunListOptions): Promise<Page<RecipeRunRecord>>;
  /** The recipe runs one of whose steps started `runId` or continues in it. */
  findRunsByPlatformRun(workspaceId: string, runId: string): Promise<readonly string[]>;

  getStep(recipeRunId: string, key: string): Promise<RecipeStepRecord | null>;
  listSteps(recipeRunId: string): Promise<readonly RecipeStepRecord[]>;
  /** Inserts the step `running`, or leaves an existing row as it is; returns the row. */
  upsertStepRunning(recipeRunId: string, key: string, at: Date): Promise<RecipeStepRecord>;
  /** Records the run the step started, before the step waits on it. */
  recordStepRun(recipeRunId: string, key: string, runId: string): Promise<void>;
  /** The step's run stopped for approval. */
  suspendStep(recipeRunId: string, key: string): Promise<void>;
  /** The approval was decided in the app: the step runs again, waiting on `continuationRunId`. */
  recordDecision(
    recipeRunId: string,
    key: string,
    decision: ApprovalDecision,
    continuationRunId: string,
  ): Promise<void>;
  completeStep(recipeRunId: string, key: string, output: Json, at: Date): Promise<void>;
  /** Fails the step with a public code. @throws {RangeError} for anything else. */
  failStep(recipeRunId: string, key: string, code: string, at: Date): Promise<void>;
}

/** The workspace's recipe runs list, as its cursors name it. */
const RECIPE_RUNS_LIST = 'recipe_runs';

/**
 * The list a cursor of `options` names: `recipe_runs`, or `recipe_runs:<recipe>:<status>` (`*`
 * for a filter not asked), so a cursor minted under one filter is refused under another.
 */
export function recipeRunsListKey(
  options: Pick<RecipeRunListOptions, 'recipe' | 'status'>,
): string {
  if (options.recipe === undefined && options.status === undefined) return RECIPE_RUNS_LIST;
  return `${RECIPE_RUNS_LIST}:${options.recipe ?? '*'}:${options.status ?? '*'}`;
}

/** A page of recipe runs from `limit + 1` rows, newest first, with the cursor after its last. */
export function recipeRunsPage(
  rows: readonly RecipeRunRecord[],
  request: PageRequest,
  workspaceId: string,
  listKey: string = RECIPE_RUNS_LIST,
): Page<RecipeRunRecord> {
  const keyed = rows.map((run) => ({ id: run.id, created_at: run.createdAt, run }));
  const page = pageOf(keyed, request, listKey, workspaceId);
  return { items: page.items.map((item) => item.run), nextCursor: page.nextCursor };
}

/** `code`, if it is a public code. @throws {RangeError} otherwise: it must never be stored. */
export function publicCodeOf(code: string): string {
  if (!PUBLIC_CODE_PATTERN.test(code)) throw new RangeError('a recipe error must be a public code');
  return code;
}
