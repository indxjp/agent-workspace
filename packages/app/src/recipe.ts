/**
 * `defineRecipe`: a workflow written as TypeScript in the app, run over the SDK (F-2, issue #1513).
 *
 * A recipe is not a platform workflow engine: the app runs it (`recipeRunner` in
 * `@indx-workspace/app/server`), each `step` is at most one ordinary platform run, and its progress
 * lives in the app's own `recipe_runs` and `recipe_steps` tables. A step's key becomes the run's
 * idempotency key, so a recipe executed again after a crash resumes where it stopped and never
 * starts a second run for a step.
 *
 * This module only defines and validates; it imports neither Drizzle, Next.js nor Node built-ins.
 */
import type { RunResource } from '@indx-workspace/contracts/runs';
import type {
  AgentWorkspaceClient,
  RunResult,
  RunsClient,
  StartRunInput,
} from '@indx-workspace/sdk';
import { DefinitionError, issuesFromZod, type DefinitionIssue } from '@indx-workspace/sdk/define';
import { Cron } from 'croner';
import { z } from 'zod';

import { brand, hasBrand, type AppBranded } from './brand.js';
import type { ListOptions, Page, SearchOptions } from './db/port.js';
import type { DefinedResource, FieldMap } from './resource.js';
import type { RecordOf } from './schemas.js';

/** A recipe's name: lower-case kebab starting with a letter, at most 63 characters. */
export const RECIPE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;

/** A step's key: unique within one recipe run, and part of its run's idempotency key. */
export const STEP_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

/** What a step stores and returns: a JSON value. */
export type Json =
  null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/** The committed writes a recipe can start on. */
export const RESOURCE_EVENTS = ['created', 'updated', 'deleted'] as const;
export type ResourceEventName = (typeof RESOURCE_EVENTS)[number];

/** Start on a committed write to one of the app's resources. */
export interface ResourceEventOn {
  readonly kind: 'resourceEvent';
  /** The resource's `name` (`ticket`). */
  readonly resource: string;
  readonly event: ResourceEventName;
}

/** Start on a cron slot, evaluated by the app (five fields, in an IANA time zone). */
export interface ScheduleOn {
  readonly kind: 'schedule';
  readonly cron: string;
  readonly timezone: string;
}

/** What starts a recipe. `trigger(name)` (ADR-0144) is not available: it needs an entry agent. */
export type RecipeOn = ResourceEventOn | ScheduleOn;

/** The input of a recipe started by a {@link resourceEvent}. */
export interface ResourceEventInput {
  readonly resource: string;
  readonly event: ResourceEventName;
  /** The record as the store returned it; for `deleted`, as it was before the delete. */
  readonly record: Readonly<Record<string, Json>>;
}

/** The input of a recipe started by a {@link schedule}: the slot it fired for. */
export interface ScheduleInput {
  /** The slot as an ISO-8601 instant (`2026-11-01T09:00:00.000Z`). */
  readonly slot: string;
}

/** A recipe that starts on a committed `event` of `resource`. Validated by `defineRecipe`. */
export function resourceEvent(resource: string, event: ResourceEventName): ResourceEventOn {
  return Object.freeze({ kind: 'resourceEvent', resource, event });
}

/** A recipe that starts on each slot of `cron` in `timezone` (`UTC` when omitted). */
export function schedule(cron: string, timezone = 'UTC'): ScheduleOn {
  return Object.freeze({ kind: 'schedule', cron, timezone });
}

/** What a step's `aw.runs.start` takes: the SDK's input without the key and subject it adds. */
export type RecipeStartInput = Omit<StartRunInput, 'idempotencyKey' | 'subject'>;

/** What a step's `aw.runs.start` answers: the run, and its settled result once awaited. */
export interface RecipeRunStart<Output = unknown> {
  readonly run: RunResource;
  /**
   * The run's answer, as `runs.result` reads it. Awaiting it is where a step waits; a run that
   * stops for approval suspends the recipe there, and one that fails fails the step.
   */
  readonly result: PromiseLike<RunResult<Output>>;
}

/** The SDK's runs client, whose `start` is bound to the step it is called in. */
export interface RecipeRunsClient extends Omit<RunsClient, 'start'> {
  start<Schema extends z.ZodType>(
    agentId: string,
    input: RecipeStartInput & { readonly outputSchema: Schema },
  ): Promise<RecipeRunStart<z.output<Schema>>>;
  start(agentId: string, input: RecipeStartInput): Promise<RecipeRunStart>;
}

/**
 * The SDK client a recipe works with. It is the app's own client, except that `runs.start` may
 * be called only inside a step, at most once per step, and sends the step's idempotency key and
 * the person the recipe runs for.
 */
export type RecipeClient = Omit<AgentWorkspaceClient, 'runs'> & {
  readonly runs: RecipeRunsClient;
};

/** What a step may be told besides its key and function (ADR-0164). */
export interface StepOptions {
  /**
   * For a recipe with no person (a schedule): the principal id of the workspace member the step
   * acts for. Its run asserts them as `subject` and `store` writes as their agent. Refused in a
   * recipe run that has a person, and for a principal who is not a member.
   */
  readonly actingFor?: string;
}

/**
 * One idempotent unit of a recipe. A completed step returns its stored value without calling `fn`
 * again. When `fn` resolves to `undefined` and started a run, the value is the run's structured
 * output, or its text when it has none.
 */
export type StepFn = <T extends Json | undefined>(
  key: string,
  fn: () => Promise<T>,
  options?: StepOptions,
) => Promise<T extends undefined ? Json : T>;

/**
 * A resource's records as a recipe reads and writes them (ADR-0164): the `ResourceStore`
 * port with its person filled in, the recipe's person acting through an agent (`via: 'agent'`).
 * Reads need a person; a write needs a step that started a run, whose id it carries (`run_id`).
 * The person's `access` and the resource's `agents` both apply, exactly as for an agent tool call.
 */
export interface RecipeResourceStore<F extends FieldMap = FieldMap> {
  list(options?: ListOptions): Promise<Page<RecordOf<F>>>;
  get(id: string): Promise<RecordOf<F>>;
  search(query: string, options?: SearchOptions): Promise<Page<RecordOf<F>>>;
  create(input: unknown): Promise<RecordOf<F>>;
  update(id: string, patch: unknown): Promise<RecordOf<F>>;
  delete(id: string): Promise<void>;
}

/** The store of one of the app's resources, bound to the recipe's person and current step. */
export type RecipeStoreOf = <F extends FieldMap>(
  resource: DefinedResource<F>,
) => RecipeResourceStore<F>;

/** What a recipe's `run` receives. */
export interface RecipeContext<I> {
  readonly aw: RecipeClient;
  readonly input: I;
  readonly step: StepFn;
  /** The person the recipe runs for; `null` for a schedule. */
  readonly person: { readonly principalId: string } | null;
  readonly recipeRunId: string;
  /**
   * The app's records, as the person's agent (ADR-0164): `store(message).create({ … })` inside
   * the step whose run produced it. A schedule has a person only in a step with `actingFor`.
   */
  readonly store: RecipeStoreOf;
}

/** What {@link defineRecipe} accepts. */
export interface RecipeInput<I> {
  readonly name: string;
  readonly on: RecipeOn;
  /** Validates the input a recipe run starts with; it is stored as JSON. */
  readonly input?: z.ZodType<I>;
  run(context: RecipeContext<I>): Promise<void>;
}

/** A defined recipe's settings. */
export interface RecipeDefinition<I = unknown> {
  readonly name: string;
  readonly on: RecipeOn;
  readonly input: z.ZodType<I> | null;
  run(context: RecipeContext<I>): Promise<void>;
}

/** What {@link defineRecipe} returns: the recipe, frozen and branded. */
export type DefinedRecipe<I = unknown> = RecipeDefinition<I> & AppBranded<'recipe'>;

/** Why `cron` cannot schedule a recipe, or `null`. Five fields only, as platform triggers take. */
function cronIssue(cron: string): string | null {
  if (cron.trim().split(/\s+/u).length !== 5) {
    return 'must have exactly five fields: minute hour day-of-month month day-of-week';
  }
  try {
    return new Cron(cron, { timezone: 'UTC', paused: true }).nextRun(new Date(0)) === null
      ? 'never matches a date'
      : null;
  } catch {
    return 'is not a cron expression croner accepts';
  }
}

function isTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

const OnSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('resourceEvent'),
    resource: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u, 'must be a resource name'),
    event: z.enum(RESOURCE_EVENTS),
  }),
  z
    .strictObject({ kind: z.literal('schedule'), cron: z.string(), timezone: z.string() })
    .superRefine((on, context) => {
      const issue = cronIssue(on.cron);
      if (issue !== null) context.addIssue({ code: 'custom', path: ['cron'], message: issue });
      if (!isTimeZone(on.timezone)) {
        context.addIssue({
          code: 'custom',
          path: ['timezone'],
          message: 'must be an IANA time zone such as Asia/Tokyo',
        });
      }
    }),
]);

const RecipeInputSchema = z.strictObject({
  name: z.string().regex(RECIPE_NAME_PATTERN, 'must be lower-case kebab, 1-63 characters'),
  on: OnSchema,
  input: z
    .custom<z.ZodType>((value) => value instanceof z.ZodType, { message: 'must be a Zod schema' })
    .optional(),
  run: z.custom<(context: unknown) => Promise<void>>((value) => typeof value === 'function', {
    message: 'must be a function',
  }),
});

const KNOWN_KEYS = Object.keys(RecipeInputSchema.shape);

/**
 * Defines a recipe: its name, what starts it, its input and its `run`. Every mistake is reported
 * at once (the name, the trigger, a cron or time zone croner refuses, a `run` that is not a
 * function).
 *
 * @throws {DefinitionError} with every reason the input was refused.
 */
export function defineRecipe<I = unknown>(input: RecipeInput<I>): DefinedRecipe<I> {
  const result = RecipeInputSchema.safeParse(input);
  if (!result.success) {
    throw new DefinitionError('defineRecipe()', issuesFromZod(result.error, undefined, KNOWN_KEYS));
  }
  const definition: RecipeDefinition<I> = {
    name: result.data.name,
    on: Object.freeze({ ...result.data.on }),
    input: input.input ?? null,
    run: input.run.bind(input),
  };
  return brand(definition, 'recipe');
}

/** Whether `value` was made by {@link defineRecipe}, in this copy of the app kit or another. */
export function isDefinedRecipe(value: unknown): value is DefinedRecipe {
  return hasBrand(value, 'recipe');
}

/** The issues of an app's recipes: two with one name, or an event on a resource it lacks. */
export function recipeIssues(
  recipes: readonly DefinedRecipe[],
  resourceNames: readonly string[],
): DefinitionIssue[] {
  const names = recipes.map((recipe) => recipe.name);
  return recipes.flatMap((recipe, index): DefinitionIssue[] => {
    const issues: DefinitionIssue[] = [];
    if (names.indexOf(recipe.name) !== index) {
      issues.push({
        path: `recipes.${String(index)}.name`,
        message: `the recipe name ${JSON.stringify(recipe.name)} appears more than once`,
      });
    }
    if (recipe.on.kind === 'resourceEvent' && !resourceNames.includes(recipe.on.resource)) {
      issues.push({
        path: `recipes.${String(index)}.on.resource`,
        message: `resourceEvent(${JSON.stringify(recipe.on.resource)}) names no resource of this app`,
      });
    }
    return issues;
  });
}
