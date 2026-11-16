/**
 * The errors of the recipe runner (issue #1513): {@link RecipeError} with a closed set of codes,
 * and the internal unwind a step uses when its run stops for approval.
 */

/** Why the runner refused or failed a recipe. Each code is public: it is what `error` stores. */
export const RECIPE_ERROR_CODES = [
  /** A step key that does not match `^[a-z0-9][a-z0-9._-]{0,63}$`. */
  'step_key_invalid',
  /** Two steps of one recipe run used the same key. */
  'step_key_reused',
  /** A step resolved to a value that is not JSON. */
  'step_output_not_json',
  /** A step called `aw.runs.start` twice; a step is at most one run. */
  'step_starts_two_runs',
  /** `aw.runs.start` was called outside a step, where it would have no idempotency key. */
  'run_started_outside_step',
  /** The SDK does not send `Idempotency-Key` on run start, so a recipe could run a step twice. */
  'platform_lacks_idempotent_start',
  /** A step's run was started again with another input under its key (`409 run_idempotency_conflict`). */
  'recipe_step_input_changed',
  /** The approval a step waited on was decided outside the app, which cannot find its continuation. */
  'approval_decided_outside_recipe',
  /** The approval a step waited on expired (ADR-0145 D2.4). */
  'approval_expired',
  /** The recipe's input does not match its `input` schema. */
  'recipe_input_invalid',
  /** The recipe run, or its step, is not one this runner can act on. */
  'recipe_run_not_found',
  /** `decide` was called on a step that does not wait for an approval. */
  'recipe_step_not_waiting',
  /** The app has no recipe of that name. */
  'recipe_not_found',
  /** `fireSlot` named a recipe that does not run on a schedule. */
  'recipe_not_schedule',
  /** `serveRecipes` was given a clock in production, where only the wall clock runs (ADR-0164). */
  'clock_override_refused',
  /** `store` wrote outside a step that started a run, so the write would carry no `run_id`. */
  'recipe_write_needs_run',
  /** `store` was used with no person to act for: a schedule outside a step with `actingFor`. */
  'recipe_store_needs_person',
  /** `actingFor` was given in a recipe run that has a person, or names no member. */
  'recipe_acting_for_refused',
  /** `store` was used in a runner given no resource stores or member directory. */
  'recipe_store_unavailable',
] as const;

export type RecipeErrorCode = (typeof RECIPE_ERROR_CODES)[number];

/** A refusal or failure of the recipe runner, with a closed, public code. */
export class RecipeError extends Error {
  override readonly name = 'RecipeError';
  readonly code: RecipeErrorCode;

  constructor(code: RecipeErrorCode, message: string = code, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

/**
 * Thrown inside a step whose run stopped in `awaiting_approval`, after the step and the recipe
 * were marked waiting. It unwinds `run()` to the runner, which never reports it: the recipe
 * resumes after the decision. Not exported from the package.
 */
export class RecipeSuspended extends Error {
  override readonly name = 'RecipeSuspended';
}

/**
 * Thrown inside a step that failed (its run failed or was cancelled, or its function threw),
 * carrying the public code the step and the recipe store. Not exported from the package.
 */
export class RecipeStepFailed extends Error {
  override readonly name = 'RecipeStepFailed';
  readonly code: string;

  constructor(code: string, options?: { cause?: unknown }) {
    super(`the step ended with ${code}`, options);
    this.code = code;
  }
}
