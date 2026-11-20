/** Helpers of {@link recipeRunner}: settings, the idempotency probe, tracking and event starts. */
import { createClient } from '@indx-workspace/sdk';
import { Cron } from 'croner';

import type { RecipeRunRecord } from '../db/recipe-port.js';
import type { DefinedRecipe, Json, ResourceEventName } from '../recipe.js';
import { RecipeError } from './recipe-errors.js';
import type { RecipeRunnerOptions } from './recipe-runner.js';

export type RunnerLog = (message: string, fields: Readonly<Record<string, string>>) => void;

const DEFAULT_LEASE_MS = 60_000;

/** The clock, lease length, owner name and log the runner works with, defaults filled in. */
export function runnerSettings(options: RecipeRunnerOptions): {
  readonly now: () => Date;
  readonly leaseMs: number;
  readonly owner: string;
  readonly log: RunnerLog;
} {
  const { clock } = options;
  return {
    now: clock === undefined ? (options.now ?? (() => new Date())) : () => clock.now(),
    leaseMs: options.leaseMs ?? DEFAULT_LEASE_MS,
    owner: options.owner ?? `recipe-runner:${crypto.randomUUID()}`,
    log:
      options.log ??
      ((message, fields) => {
        console.error(`[recipes] ${message}`, fields);
      }),
  };
}

function errorCode(error: unknown): string {
  return error instanceof RecipeError ? error.code : 'internal_error';
}

/**
 * Whether `create` builds a client whose `runs.start` sends `Idempotency-Key` (S-6, ADR-0151): the
 * runner asks it to start a run against a `fetch` that records the request and answers 404.
 */
async function sendsIdempotencyKey(create: typeof createClient): Promise<boolean> {
  let sent = false;
  const client = create({
    baseUrl: 'http://recipe-runner.invalid',
    auth: { kind: 'api-key', apiKey: 'probe' },
    fetch: (_input, init) => {
      sent = new Headers(init?.headers).get('idempotency-key') === 'probe';
      return Promise.resolve(
        new Response(JSON.stringify({ error: { code: 'not_found', message: 'probe' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  });
  await client.runs
    .start('probe', { prompt: 'probe', idempotencyKey: 'probe' })
    .catch(() => undefined);
  return sent;
}

export function jsonOf(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}

/** A gate that probes the SDK once and rejects every call when it does not send the key. */
export function idempotencyGate(options: RecipeRunnerOptions): () => Promise<void> {
  let probe: Promise<void> | undefined;
  return () => {
    probe ??= sendsIdempotencyKey(options.sdk?.createClient ?? createClient).then((sends) => {
      if (!sends) {
        throw new RecipeError(
          'platform_lacks_idempotent_start',
          'the SDK does not send Idempotency-Key on run start, so a recipe step could run twice',
        );
      }
    });
    return probe;
  };
}

/** Keeps the promises started in the background so `drain` can wait for them. */
export function flightTracker(): {
  readonly track: <T>(promise: Promise<T>) => Promise<T>;
  readonly drain: () => Promise<void>;
} {
  const inFlight = new Set<Promise<unknown>>();
  return {
    track: (promise) => {
      inFlight.add(promise);
      void promise.finally(() => inFlight.delete(promise)).catch(() => undefined);
      return promise;
    },
    drain: async () => {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    },
  };
}

/** Finds the app's recipe by name or value; a value that is not the app's own is unknown. */
export function recipeLookup(
  recipes: ReadonlyMap<string, DefinedRecipe>,
): (recipe: DefinedRecipe | string) => DefinedRecipe {
  return (recipe) => {
    const name = typeof recipe === 'string' ? recipe : recipe.name;
    const found = recipes.get(name);
    if (found === undefined || (typeof recipe !== 'string' && found !== recipe)) {
      throw new RecipeError('recipe_not_found', `the app has no recipe named "${name}"`);
    }
    return found;
  };
}

/** The next resume time of each schedule recipe, starting at `now`. */
export function initialScheduleFrom(
  recipes: readonly DefinedRecipe[],
  now: () => Date,
): Map<string, Date> {
  return new Map(
    recipes.filter((recipe) => recipe.on.kind === 'schedule').map((recipe) => [recipe.name, now()]),
  );
}

/** Start the first missed slot of each schedule, preserving replica deduplication. */
export async function fireSchedules({
  now,
  recipes,
  scheduleFrom,
  recordSlot,
  execute,
}: {
  readonly now: () => Date;
  readonly recipes: ReadonlyMap<string, DefinedRecipe>;
  readonly scheduleFrom: Map<string, Date>;
  readonly recordSlot: (recipe: DefinedRecipe, slot: Date) => Promise<RecipeRunRecord>;
  readonly execute: (id: string) => Promise<void>;
}): Promise<void> {
  const at = now();
  for (const recipe of recipes.values()) {
    if (recipe.on.kind !== 'schedule') continue;
    const from = scheduleFrom.get(recipe.name) ?? at;
    const slot = new Cron(recipe.on.cron, { timezone: recipe.on.timezone, paused: true }).nextRun(
      from,
    );
    if (slot === null || slot.getTime() > at.getTime()) continue;
    // A runner that missed several slots owes one run (the first it missed), as platform triggers
    // do; each slot is its own dedupe key, so replicas that looked at other times never repeat one.
    scheduleFrom.set(recipe.name, at);
    const run = await recordSlot(recipe, slot);
    if (run.status === 'running') await execute(run.id);
  }
}

/** The dedupe key of a resource event; an update carries its stamp so two updates differ. */
function resourceEventKey(
  resource: string,
  id: string,
  event: ResourceEventName,
  row: Readonly<Record<string, unknown>>,
): string {
  const stamp =
    event === 'updated' && typeof row['updated_at'] === 'string' ? `:${row['updated_at']}` : '';
  return `resource:${resource}:${id}:${event}${stamp}`;
}

/** The `onResourceEvent` method: starts each recipe on a resource event, once per row and event. */
export function resourceEventStarter({
  recipes,
  ready,
  record,
  track,
  execute,
  log,
}: {
  readonly recipes: ReadonlyMap<string, DefinedRecipe>;
  readonly ready: () => Promise<void>;
  readonly record: (
    recipe: DefinedRecipe,
    input: unknown,
    start: { readonly dedupeKey: string; readonly person: { readonly principalId: string } | null },
  ) => Promise<RecipeRunRecord>;
  readonly track: <T>(promise: Promise<T>) => Promise<T>;
  readonly execute: (id: string) => Promise<void>;
  readonly log: RunnerLog;
}): (
  resource: string,
  event: ResourceEventName,
  row: Readonly<Record<string, unknown>>,
  person?: { readonly principalId: string } | null,
) => Promise<readonly string[]> {
  return async (resource, event, row, person) => {
    const id = row['id'];
    if (typeof id !== 'string') return [];
    const matching = [...recipes.values()].filter(
      (recipe) =>
        recipe.on.kind === 'resourceEvent' &&
        recipe.on.resource === resource &&
        recipe.on.event === event,
    );
    if (matching.length === 0) return [];
    const dedupeKey = resourceEventKey(resource, id, event, row);
    const started: string[] = [];
    try {
      await ready();
      for (const recipe of matching) {
        const run = await record(
          recipe,
          { resource, event, record: jsonOf(row) },
          { dedupeKey, person: person ?? null },
        );
        started.push(run.id);
        if (run.status === 'running') void track(execute(run.id));
      }
    } catch (error) {
      log('a resource event could not start its recipes', {
        resource,
        event,
        code: errorCode(error),
      });
    }
    return started;
  };
}

/** Calls `resume` on a timer; `start` is idempotent and `clear` stops the timer. */
export function backgroundTimer({
  resume,
  track,
  log,
}: {
  readonly resume: () => Promise<void>;
  readonly track: <T>(promise: Promise<T>) => Promise<T>;
  readonly log: RunnerLog;
}): { readonly start: (intervalMs: number) => void; readonly clear: () => void } {
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    start: (intervalMs) => {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        void track(resume()).catch((error: unknown) => {
          log('resume() failed', { code: errorCode(error) });
        });
      }, intervalMs);
      timer.unref();
    },
    clear: () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
