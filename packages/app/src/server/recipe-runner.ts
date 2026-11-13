/**
 * `recipeRunner`: executes an app's recipes in the app process, over the SDK (F-2, issue #1513).
 * The platform never executes a recipe (O-2); each step is one ordinary platform run.
 *
 * - `start` records a recipe run, or finds the one holding its dedupe key, and executes it.
 *   Dedupe keys: `resource:<resource>:<rowId>:<event>` and `schedule:<recipe>:<slotIso>`, so two
 *   replicas firing one schedule slot start one recipe run.
 * - Execution holds a lease on the recipe run, claimed with one conditional update and renewed
 *   every `leaseMs / 3`. shortcut: per-recipe-run lease in the app, becomes an RF-303 worker job if
 *   O-2 ever moves recipes into the platform.
 * - A step waits with `waitForOutcome` (`follow`); a verified run-outcome webhook (N-3) passed to
 *   `onRunOutcome` wakes a step whose execution was interrupted, without waiting for `resume`.
 * - A run that stops for approval suspends the recipe; `decide` approves or rejects it with the
 *   person's own client and resumes it on the continuation run.
 * - `resume` (at app start and on `startBackground`'s timer) evaluates the schedules, executes
 *   `running` recipe runs whose lease expired, and re-checks `waiting` ones.
 * - `fireSlot` starts one slot of a schedule at a chosen instant, as the evaluation would
 *   (ADR-0164, 2026-11-01 amendment); a `clock` moves every time the runner reads.
 * - Given `stores` and `members`, a recipe's `store` reads and writes the app's records as the
 *   person's agent, a write carrying its step's run id (ADR-0164).
 */
import { WebhookEventSchema, type WebhookEvent } from '@indx-workspace/contracts/webhooks';
import { createClient, type AgentWorkspaceClient } from '@indx-workspace/sdk';
import { Cron } from 'croner';

import type { ResourceStore } from '../db/port.js';
import type { RecipeRunRecord, RecipeStore } from '../db/recipe-port.js';
import type { DefinedRecipe, Json, ResourceEventName } from '../recipe.js';
import type { DefinedResource, FieldMap } from '../resource.js';
import type { MemberDirectory } from './mcp-person.js';
import { recipeApprovals } from './recipe-runner-approvals.js';
import { recipeRunExecutor } from './recipe-runner-execution.js';
import { RecipeError } from './recipe-errors.js';
import { interruptibleStore } from './recipe-runner-steps.js';

/** What the runner needs of the app: its recipes. A `defineApp()` value is one. */
export interface RecipeApp {
  readonly recipes: readonly DefinedRecipe[];
}

/** The SDK client a person decides an approval with: their own token (ADR-0145 D2.2). */
export type PersonRunsClient = Pick<AgentWorkspaceClient, 'runs'>;

/** Where the runner reads the time: the wall clock unless a test gives another (ADR-0164 T1). */
export interface RecipeClock {
  /** The current time, as this clock tells it. */
  now(): Date;
}

/** What {@link recipeRunner} takes besides the app. */
export interface RecipeRunnerOptions {
  /** The app's own client (its API key), which starts every step's run. */
  readonly client: AgentWorkspaceClient;
  readonly store: RecipeStore;
  /** The workspace the app serves; every recipe run belongs to it. */
  readonly workspaceId: string;
  /**
   * The app's resource stores, which a recipe's `store` reads and writes through (ADR-0164); with
   * {@link members}. Without both, `store` refuses with `recipe_store_unavailable`.
   */
  readonly stores?: <F extends FieldMap>(resource: DefinedResource<F>) => ResourceStore<F>;
  /** Where the role of the person a recipe's `store` acts for is read (the app key, cached). */
  readonly members?: MemberDirectory;
  /** How long a lease lasts; renewed every third of it. 60 s when not given. */
  readonly leaseMs?: number;
  readonly now?: () => Date;
  /** The clock every time is read from; wins over {@link now}. The wall clock when neither is given. */
  readonly clock?: RecipeClock;
  /** This replica's lease owner name; a random one when not given. */
  readonly owner?: string;
  /**
   * The SDK whose `runs.start` the runner checks sends `Idempotency-Key`; this app kit's
   * `createClient` when not given.
   */
  readonly sdk?: { readonly createClient: typeof createClient };
  /** Where the runner reports what it could not do; one line, never a value of the app's data. */
  readonly log?: (message: string, fields: Readonly<Record<string, string>>) => void;
}

/** A decision on the approval a step waits on. */
export interface RecipeDecision {
  readonly recipeRunId: string;
  readonly stepKey: string;
  readonly decision: 'approve' | 'reject';
  readonly comment?: string;
}

/** What {@link RecipeRunner.start} takes besides the recipe and its input. */
export interface RecipeStartOptions {
  /** Starts with a key already taken return the recipe run holding it. A fresh one when absent. */
  readonly dedupeKey?: string;
  readonly person?: { readonly principalId: string } | null;
}

export interface RecipeRunner {
  start(
    recipe: DefinedRecipe | string,
    input: unknown,
    options?: RecipeStartOptions,
  ): Promise<RecipeRunRecord>;
  resume(): Promise<void>;
  /**
   * Starts the slot of the schedule recipe `recipe` at `at`, as the evaluation loop starts a due
   * slot: input `{ slot }`, no person, dedupe key `schedule:<recipe>:<slotIso>`, so one slot runs
   * once however often it is fired. Answers once the recipe run is recorded; it executes in the
   * background ({@link drain} waits for it).
   *
   * @throws {RecipeError} `recipe_not_found` for an unknown name; `recipe_not_schedule` for a
   *   recipe that does not run on a schedule.
   */
  fireSlot(recipe: string, at: Date): Promise<RecipeRunRecord>;
  decide(decision: RecipeDecision, personClient: PersonRunsClient): Promise<RecipeRunRecord>;
  /**
   * The `onCommitted` hook of `storeOf`: starts each recipe on this write, once per row and event.
   * shortcut: the event reaches the runner in-process after the commit, so a crash between the
   * commit and the recipe run insert loses it; upgrade to an outbox row written in the write's own
   * transaction when an app needs every event delivered.
   */
  onResourceEvent(
    resource: string,
    event: ResourceEventName,
    row: Readonly<Record<string, unknown>>,
    person?: { readonly principalId: string } | null,
  ): Promise<readonly string[]>;
  /** A verified run-outcome webhook (N-3): wakes the steps waiting on the run. */
  onRunOutcome(event: WebhookEvent): Promise<void>;
  /** Calls `resume` every `intervalMs` (30 s when not given) until {@link stop}. */
  startBackground(intervalMs?: number): void;
  /** Stops the timer, aborts what is in flight and waits for it. */
  stop(): Promise<void>;
  /** Waits for every execution started in the background so far. */
  drain(): Promise<void>;
}

const RESUME_BATCH = 100;

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

function jsonOf(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}

/** Start the first missed slot of each schedule, preserving replica deduplication. */
async function fireSchedules({
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

/**
 * The runner of `app`'s recipes. Nothing runs until a method is called: `resume` at app start (the
 * template's `instrumentation.ts` calls it), then `startBackground`.
 *
 * @throws {RecipeError} `platform_lacks_idempotent_start`, from the first method called, when the
 *   SDK does not send `Idempotency-Key` on run start: a recipe could then run a step twice.
 */
export function recipeRunner(app: RecipeApp, options: RecipeRunnerOptions): RecipeRunner {
  const store = interruptibleStore(options.store);
  const { clock } = options;
  const now = clock === undefined ? (options.now ?? (() => new Date())) : () => clock.now();
  const leaseMs = options.leaseMs ?? 60_000;
  const owner = options.owner ?? `recipe-runner:${crypto.randomUUID()}`;
  const workspaceId = options.workspaceId;
  const log =
    options.log ??
    ((message: string, fields: Readonly<Record<string, string>>) => {
      console.error(`[recipes] ${message}`, fields);
    });
  const recipes = new Map(app.recipes.map((recipe) => [recipe.name, recipe]));
  const stopping = new AbortController();
  const inFlight = new Set<Promise<unknown>>();
  const scheduleFrom = new Map<string, Date>(
    app.recipes
      .filter((recipe) => recipe.on.kind === 'schedule')
      .map((recipe) => [recipe.name, now()]),
  );
  let timer: ReturnType<typeof setInterval> | undefined;
  let probe: Promise<void> | undefined;
  const records =
    options.stores === undefined || options.members === undefined
      ? undefined
      : { storeOf: options.stores, members: options.members, workspaceId };

  const ready = (): Promise<void> => {
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

  const track = <T>(promise: Promise<T>): Promise<T> => {
    inFlight.add(promise);
    void promise.finally(() => inFlight.delete(promise)).catch(() => undefined);
    return promise;
  };

  const execute = recipeRunExecutor({
    store,
    now,
    workspaceId,
    owner,
    leaseMs,
    stopping: stopping.signal,
    recipes,
    log,
    client: options.client,
    ...(records === undefined ? {} : { records }),
  });

  const recipeOf = (recipe: DefinedRecipe | string): DefinedRecipe => {
    const name = typeof recipe === 'string' ? recipe : recipe.name;
    const found = recipes.get(name);
    if (found === undefined || (typeof recipe !== 'string' && found !== recipe)) {
      throw new RecipeError('recipe_not_found', `the app has no recipe named "${name}"`);
    }
    return found;
  };

  /** Records a recipe run (or finds the one holding its dedupe key) without executing it. */
  const record = async (
    recipe: DefinedRecipe,
    input: unknown,
    start: RecipeStartOptions,
  ): Promise<RecipeRunRecord> => {
    if (recipe.input !== null && !recipe.input.safeParse(input).success) {
      throw new RecipeError('recipe_input_invalid', `the input of "${recipe.name}" is not valid`);
    }
    const { run } = await store.insertOrGetRun({
      workspaceId,
      recipe: recipe.name,
      input: jsonOf(input),
      dedupeKey: start.dedupeKey ?? `manual:${crypto.randomUUID()}`,
      startedBy: start.person?.principalId ?? null,
      at: now(),
    });
    return run;
  };

  const { current, recheckWaiting, decide } = recipeApprovals({
    store,
    workspaceId,
    now,
    client: options.client,
    ready,
    execute,
    track,
    log,
  });

  /** Records the recipe run of `recipe`'s slot at `slot`; one per slot, whoever fires it. */
  const recordSlot = (recipe: DefinedRecipe, slot: Date): Promise<RecipeRunRecord> => {
    const iso = slot.toISOString();
    return record(
      recipe,
      { slot: iso },
      { dedupeKey: `schedule:${recipe.name}:${iso}`, person: null },
    );
  };

  const runner: RecipeRunner = {
    async start(recipe, input, start = {}) {
      await ready();
      const run = await record(recipeOf(recipe), input, start);
      if (run.status === 'running') await track(execute(run.id));
      return current(run.id);
    },

    async resume() {
      await ready();
      await fireSchedules({ now, recipes, scheduleFrom, recordSlot, execute });
      const resumable = await store.listResumable(workspaceId, now(), RESUME_BATCH);
      await Promise.all(resumable.map((run) => track(execute(run.id))));
      for (const run of await store.listWaiting(workspaceId, RESUME_BATCH)) {
        await recheckWaiting(run);
      }
    },

    async fireSlot(name, at) {
      const recipe = recipeOf(name);
      if (recipe.on.kind !== 'schedule') {
        throw new RecipeError('recipe_not_schedule', `the recipe "${name}" is not a schedule`);
      }
      if (Number.isNaN(at.getTime())) throw new TypeError('fireSlot takes a valid date');
      await ready();
      const run = await recordSlot(recipe, at);
      if (run.status === 'running') void track(execute(run.id));
      return run;
    },

    decide,

    async onResourceEvent(resource, event, row, person) {
      const id = row['id'];
      if (typeof id !== 'string') return [];
      const matching = [...recipes.values()].filter(
        (recipe) =>
          recipe.on.kind === 'resourceEvent' &&
          recipe.on.resource === resource &&
          recipe.on.event === event,
      );
      if (matching.length === 0) return [];
      // An update is its own event each time: its stamp tells two updates of one row apart.
      const stamp =
        event === 'updated' && typeof row['updated_at'] === 'string' ? `:${row['updated_at']}` : '';
      const started: string[] = [];
      try {
        await ready();
        for (const recipe of matching) {
          const run = await record(
            recipe,
            { resource, event, record: jsonOf(row) },
            { dedupeKey: `resource:${resource}:${id}:${event}${stamp}`, person: person ?? null },
          );
          started.push(run.id);
          if (run.status === 'running') void track(execute(run.id));
        }
      } catch (error) {
        log('a resource event could not start its recipes', {
          resource,
          event,
          code: error instanceof RecipeError ? error.code : 'internal_error',
        });
      }
      return started;
    },

    async onRunOutcome(event) {
      await ready();
      const parsed = WebhookEventSchema.safeParse(event);
      if (!parsed.success) throw new TypeError('onRunOutcome takes a verified run-outcome event');
      if (parsed.data.workspaceId !== workspaceId) return;
      const ids = await store.findRunsByPlatformRun(workspaceId, parsed.data.data.run.id);
      for (const id of ids) {
        const run = await store.getRun(workspaceId, id);
        if (run?.status === 'running') await track(execute(run.id));
        else if (run?.status === 'waiting') await recheckWaiting(run);
      }
    },

    startBackground(intervalMs = 30_000) {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        void track(runner.resume()).catch((error: unknown) => {
          log('resume() failed', {
            code: error instanceof RecipeError ? error.code : 'internal_error',
          });
        });
      }, intervalMs);
      timer.unref();
    },

    async stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      stopping.abort();
      await runner.drain();
    },

    async drain() {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    },
  };
  return runner;
}
