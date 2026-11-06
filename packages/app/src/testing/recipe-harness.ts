/**
 * `recipeHarness`: a recipe run end to end in a test (issue #1513), on an in-memory recipe store
 * and a scripted platform, with a crash and a restart in between.
 *
 * - `crashAfter(stepKey)` makes the app "die" right after the step completed (or, with
 *   `'run-started'`, right after the platform answered the step's run start and before the app
 *   recorded the run): from then on every write of that runner fails, as if the process were gone.
 * - `restart()` starts a new runner on the same store and platform, past the dead one's lease, and
 *   calls `resume()`, as the app's `instrumentation.ts` does at start.
 * - `approve` / `reject` decide the approval a step waits on through the runner, as the person;
 *   `decideOutside` and `expireApproval` do what the console and the platform's 24-hour expiry do.
 * - The recipe's `store` (ADR-0164) writes to in-memory stores (`memoryStoreOf`) that outlive a
 *   crash and a restart; `storeOf(resource)` reads them back, audit rows included. Roles come from
 *   `members`, which holds the harness person as a `builder` unless told otherwise.
 * - `clock` (a {@link testClock}) is the time the runner and the stores read; `advance` moves it,
 *   and `fireSlot(at?)` starts the schedule recipe's slot at `at` (ADR-0164 T4).
 */
import type { MembershipRoleName } from '@indx-workspace/contracts/team';
import type { RunResource } from '@indx-workspace/contracts/runs';
import { createClient } from '@indx-workspace/sdk';
import type { RecordedRequest } from '@indx-workspace/sdk/testing';

import type { RecipeRunRecord, RecipeStepRecord, RecipeStore } from '../db/recipe-port.js';
import { isPageResource } from '../pages/define-pages.js';
import type { DefinedRecipe } from '../recipe.js';
import type { DefinedResource, FieldMap } from '../resource.js';
import { storesBuiltBy } from '../server/app-stores.js';
import type { MemberDirectory } from '../server/mcp-person.js';
import {
  recipeRunner,
  type RecipeRunner,
  type RecipeStartOptions,
} from '../server/recipe-runner.js';
import { FAKE_WORKSPACE_ID } from './fake-person.js';
import { memoryPageStoreOf } from './memory-page-store.js';
import { memoryRecipeStore, type MemoryRecipeStore } from './memory-recipe-store.js';
import { memoryStoreOf, type MemoryResourceStore } from './memory-store.js';
import { scriptedPlatform, type Script } from './recipe-harness-platform.js';
import { testClock, type TestClock } from './test-clock.js';

export {
  awaitingApproval,
  completed,
  failed,
  PROVIDER_TEXT,
  type Script,
  type ScriptedOutcome,
} from './recipe-harness-platform.js';

/** What {@link recipeHarness} takes besides the recipe. */
export interface RecipeHarnessOptions {
  /** Each agent's scripted runs, by the agent id a step starts. */
  readonly agents: Readonly<Record<string, Script>>;
  /** Other recipes of the same app, for a runner that serves several. */
  readonly recipes?: readonly DefinedRecipe[];
  readonly leaseMs?: number;
  /** The harness clock's start; 2026-01-01T00:00:00Z when not given. Ignored with {@link clock}. */
  readonly startAt?: Date;
  /** The clock the runner and the stores read; a {@link testClock} at {@link startAt} when not given. */
  readonly clock?: TestClock;
  /**
   * Each workspace member's role, by principal id, as the recipe's `store` reads it; anyone else
   * is no member. `{ [harness.personId]: 'builder' }` when not given.
   */
  readonly members?: Readonly<Record<string, MembershipRoleName>>;
}

/** Where a crash happens: after the step completed, or after its run started and before it was recorded. */
export type CrashPoint = 'completed' | 'run-started';

export interface RecipeHarness {
  /** Starts the recipe; the answer is the recipe run once it completed, waits, failed or crashed. */
  start(input?: unknown, options?: RecipeStartOptions): Promise<RecipeRunRecord>;
  crashAfter(stepKey: string, at?: CrashPoint): void;
  restart(): Promise<void>;
  approve(stepKey: string, comment?: string): Promise<RecipeRunRecord>;
  reject(stepKey: string, comment?: string): Promise<RecipeRunRecord>;
  /** Decides the step's paused run on the platform directly, as the console would. */
  decideOutside(stepKey: string): void;
  /** Lets the step's paused run expire, as the platform does after 24 hours. */
  expireApproval(stepKey: string): void;
  /** Moves the harness clock forward. */
  advance(ms: number): void;
  /**
   * Starts the slot of the harness's schedule recipe at `at` (the clock's time when not given), as
   * the schedule would, and answers the recipe run once it completed, waits or failed.
   */
  fireSlot(at?: Date): Promise<RecipeRunRecord>;
  /** Every `POST /api/agents/:id/runs` the platform received, replays included. */
  runsStarted(): readonly RecordedRequest[];
  /** Every run the platform created. */
  platformRuns(): readonly RunResource[];
  state(): {
    readonly runs: readonly RecipeRunRecord[];
    readonly steps: readonly RecipeStepRecord[];
  };
  /** The live runner, for `resume`, `onResourceEvent` and `onRunOutcome`. */
  runner(): RecipeRunner;
  /** Another replica of the app: a runner on the same store, platform and clock. */
  replica(): RecipeRunner;
  readonly store: MemoryRecipeStore;
  /** The in-memory store of `resource` the recipe's `store` writes to; one per resource. */
  storeOf<F extends FieldMap>(resource: DefinedResource<F>): MemoryResourceStore<F>;
  /** The principal id of the person `start` runs the recipe for unless told otherwise. */
  readonly personId: string;
}

/** Raised by a dead runner's store: the process it belonged to is gone. */
class SimulatedCrash extends Error {
  override readonly name = 'SimulatedCrash';
}

/** `store`, made to die at `crash` and stay dead; `crashed()` says whether it died. */
function crashableStore(
  store: RecipeStore,
  crash: () => { readonly key: string; readonly at: CrashPoint } | null,
): { readonly store: RecipeStore; crashed(): boolean } {
  let dead = false;
  const proxy = new Proxy(store, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        if (dead) throw new SimulatedCrash('the app crashed');
        const planned = crash();
        if (
          property === 'recordStepRun' &&
          planned?.at === 'run-started' &&
          args[1] === planned.key
        ) {
          dead = true;
          throw new SimulatedCrash('the app crashed before it recorded the run');
        }
        const result: unknown = await (value as (...input: unknown[]) => unknown).apply(
          target,
          args,
        );
        if (property === 'completeStep' && planned?.at === 'completed' && args[1] === planned.key) {
          dead = true;
        }
        return result;
      };
    },
  });
  return { store: proxy, crashed: () => dead };
}

const PERSON_PRINCIPAL = '00000000-0000-4000-8000-0000000000aa';

/** A harness running `recipe` against `options.agents`' scripts. */
export function recipeHarness(recipe: DefinedRecipe, options: RecipeHarnessOptions): RecipeHarness {
  const store = memoryRecipeStore();
  const platform = scriptedPlatform(FAKE_WORKSPACE_ID, options.agents);
  const leaseMs = options.leaseMs ?? 60_000;
  const clock = options.clock ?? testClock(options.startAt);
  const now = (): Date => clock.now();
  const app = { recipes: [recipe, ...(options.recipes ?? [])] };
  const storeOptions = { now };
  const stores = storesBuiltBy((resource) =>
    isPageResource(resource)
      ? memoryPageStoreOf(resource, storeOptions)
      : memoryStoreOf(resource, storeOptions),
  );
  const memberRoles: Readonly<Record<string, MembershipRoleName>> = options.members ?? {
    [PERSON_PRINCIPAL]: 'builder',
  };
  const roles = new Map(
    Object.entries(memberRoles).map(
      ([principalId, role]) => [principalId.toLowerCase(), role] as const,
    ),
  );
  const members: MemberDirectory = {
    roleOf: (principalId: string) => Promise.resolve(roles.get(principalId.toLowerCase()) ?? null),
  };
  const client = (token: string) =>
    createClient({
      baseUrl: 'https://aw.test',
      auth: { kind: 'api-key', apiKey: token },
      fetch: platform.double.fetch,
    });
  let crash: { key: string; at: CrashPoint } | null = null;
  const runnerOn = (target: RecipeStore): RecipeRunner =>
    recipeRunner(app, {
      client: client('app'),
      store: target,
      workspaceId: FAKE_WORKSPACE_ID,
      leaseMs,
      clock,
      log: () => undefined,
      stores,
      members,
    });
  const first = crashableStore(store, () => crash);
  let live = runnerOn(first.store);
  let lastRunId: string | null = null;

  const pausedStep = (stepKey: string): RecipeStepRecord => {
    const step = store.steps().find((row) => row.recipeRunId === lastRunId && row.key === stepKey);
    if (step?.runId == null) throw new Error(`step "${stepKey}" has no run`);
    return step;
  };
  const pausedRunOf = (stepKey: string): string => {
    const step = pausedStep(stepKey);
    return step.continuationRunId ?? step.runId ?? '';
  };
  const decide = (stepKey: string, decision: 'approve' | 'reject', comment?: string) => {
    if (lastRunId === null) throw new Error('no recipe run was started');
    return live.decide(
      { recipeRunId: lastRunId, stepKey, decision, ...(comment === undefined ? {} : { comment }) },
      client('person'),
    );
  };

  return {
    store,
    async start(input = {}, startOptions = { person: { principalId: PERSON_PRINCIPAL } }) {
      try {
        const run = await live.start(recipe, input, startOptions);
        lastRunId = run.id;
        return run;
      } catch (error) {
        // The app died mid-recipe: the answer is the recipe run as the crash left it.
        const left = store.runs().at(-1);
        if (!first.crashed() || left === undefined) throw error;
        lastRunId = left.id;
        return left;
      }
    },
    crashAfter(stepKey, at = 'completed') {
      crash = { key: stepKey, at };
    },
    async restart() {
      await live.stop();
      crash = null;
      clock.advance(leaseMs + 1);
      live = runnerOn(store);
      await live.resume();
    },
    approve: (stepKey, comment) => decide(stepKey, 'approve', comment),
    reject: (stepKey, comment) => decide(stepKey, 'reject', comment),
    decideOutside(stepKey) {
      platform.decideOutside(pausedRunOf(stepKey));
    },
    expireApproval(stepKey) {
      platform.expire(pausedRunOf(stepKey));
    },
    advance(ms) {
      clock.advance(ms);
    },
    async fireSlot(at = now()) {
      const run = await live.fireSlot(recipe.name, at);
      lastRunId = run.id;
      await live.drain();
      return (await store.getRun(FAKE_WORKSPACE_ID, run.id)) ?? run;
    },
    runsStarted: () => platform.runsStarted(),
    platformRuns: () => platform.runs(),
    state: () => ({ runs: store.runs(), steps: store.steps() }),
    runner: () => live,
    replica: () => runnerOn(store),
    storeOf: stores as RecipeHarness['storeOf'],
    personId: PERSON_PRINCIPAL,
  };
}
