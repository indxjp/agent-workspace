/**
 * The recipe routes' wire (issue #1514): the paths, bodies and answers `recipeRoutes` in
 * `./server` serves and `RecipeGraph` / `RecipeRunList` in `./react` send and read. One module, so
 * the two halves cannot drift. Pure Zod, with no server or browser dependency; not a public entry
 * point.
 */
import { RunApprovalCallSchema, type RunApprovalCall } from '@indx-workspace/contracts/runs';
import { z } from 'zod';

import {
  RECIPE_RUN_STATUSES,
  RECIPE_STEP_STATUSES,
  type RecipeRunStatus,
  type RecipeStepStatus,
} from './db/recipe-port.js';

/** Where the recipe routes are: `app/api/recipes/…`. */
const RECIPE_ROUTES_BASE_PATH = '/api/recipes';

/** The path of the recipe runs list, of one run, or of the decision on one step of it. */
export function recipeRunsPath(recipeRunId?: string, stepKey?: string): string {
  const base = `${RECIPE_ROUTES_BASE_PATH}/runs`;
  if (recipeRunId === undefined) return base;
  const run = `${base}/${encodeURIComponent(recipeRunId)}`;
  return stepKey === undefined ? run : `${run}/steps/${encodeURIComponent(stepKey)}/decision`;
}

/** One recipe run as the routes show it: never its input, its lease or its dedupe key. */
export interface RecipeRunView {
  readonly id: string;
  readonly recipe: string;
  readonly status: RecipeRunStatus;
  /** A public code once `failed`, else `null`. */
  readonly error: string | null;
  /** The principal id of the person it runs for; `null` for a schedule. */
  readonly startedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What a step's platform run cost, as the platform accounts it: a decimal string and currency. */
export interface RecipeStepCost {
  readonly amount: string;
  readonly currency: string;
}

/** One step of a recipe run as the routes show it. */
export interface RecipeStepView {
  readonly key: string;
  readonly status: RecipeStepStatus;
  /** The platform run the step waits on or ended with: the continuation once decided. */
  readonly runId: string | null;
  /** That run's view in the Agent Workspace console; `null` while the step has no run. */
  readonly runUrl: string | null;
  readonly decision: 'approve' | 'reject' | null;
  /** A public code once `failed`, else `null`. */
  readonly error: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  /** The run's cost, read as the person; `null` when there is no run or it cannot be read. */
  readonly cost: RecipeStepCost | null;
  /** The call an `awaiting_approval` step's run waits on; `null` otherwise or when unreadable. */
  readonly pendingApproval: RunApprovalCall | null;
}

const RecipeRunViewSchema: z.ZodType<RecipeRunView> = z.strictObject({
  id: z.string().min(1),
  recipe: z.string().min(1),
  status: z.enum(RECIPE_RUN_STATUSES),
  error: z.string().nullable(),
  startedBy: z.string().nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

const RecipeStepViewSchema: z.ZodType<RecipeStepView> = z.strictObject({
  key: z.string().min(1),
  status: z.enum(RECIPE_STEP_STATUSES),
  runId: z.string().nullable(),
  runUrl: z.string().nullable(),
  decision: z.enum(['approve', 'reject']).nullable(),
  error: z.string().nullable(),
  startedAt: z.string().min(1),
  endedAt: z.string().nullable(),
  cost: z.strictObject({ amount: z.string().min(1), currency: z.string().min(1) }).nullable(),
  pendingApproval: RunApprovalCallSchema.nullable(),
});

/** `GET /api/recipes/runs`: a page of recipe runs, newest first (ADR-0079). */
export interface RecipeRunPage {
  readonly items: readonly RecipeRunView[];
  readonly nextCursor: string | null;
}

export const RecipeRunPageSchema: z.ZodType<RecipeRunPage> = z.strictObject({
  items: z.array(RecipeRunViewSchema),
  nextCursor: z.string().nullable(),
});

/** `GET /api/recipes/runs/:id`, and the answer of a decision: the run with its steps in order. */
export interface RecipeRunDetail {
  readonly run: RecipeRunView;
  readonly steps: readonly RecipeStepView[];
}

export const RecipeRunDetailSchema: z.ZodType<RecipeRunDetail> = z.strictObject({
  run: RecipeRunViewSchema,
  steps: z.array(RecipeStepViewSchema),
});

/** `POST /api/recipes/slots`'s `202` answer: the recipe run of the slot, new or the one it was. */
export interface RecipeSlotResponse {
  readonly run: RecipeRunView;
}

export const RecipeSlotResponseSchema: z.ZodType<RecipeSlotResponse> = z.strictObject({
  run: RecipeRunViewSchema,
});
