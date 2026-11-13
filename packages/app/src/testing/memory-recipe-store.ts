/**
 * `memoryRecipeStore`: the in-memory twin of `recipeStoreOf` (issue #1513), the same
 * `RecipeStore` port with the same rules (the dedupe key, the lease, the continuation check, public
 * codes only), for the recipe harness and an app's own tests. Each call returns copies.
 */
import { pageRequestOf } from '../db/policy.js';
import {
  publicCodeOf,
  recipeRunsListKey,
  recipeRunsPage,
  type RecipeRunRecord,
  type RecipeStepRecord,
  type RecipeStore,
} from '../db/recipe-port.js';

/** The in-memory recipe store: the port, plus a look at every row a test inspects. */
export interface MemoryRecipeStore extends RecipeStore {
  runs(): readonly RecipeRunRecord[];
  steps(): readonly RecipeStepRecord[];
}

type MutableRun = { -readonly [K in keyof RecipeRunRecord]: RecipeRunRecord[K] };
type MutableStep = { -readonly [K in keyof RecipeStepRecord]: RecipeStepRecord[K] } & {
  workspaceId: string;
};

const copy = <T>(value: T): T => structuredClone(value);

function stepRecord(step: MutableStep): RecipeStepRecord {
  return copy({
    recipeRunId: step.recipeRunId,
    key: step.key,
    status: step.status,
    runId: step.runId,
    continuationRunId: step.continuationRunId,
    decision: step.decision,
    output: step.output,
    error: step.error,
    startedAt: step.startedAt,
    endedAt: step.endedAt,
  });
}

const leaseFree = (run: MutableRun, at: Date): boolean =>
  run.leaseExpiresAt === null || Date.parse(run.leaseExpiresAt) < at.getTime();

/** Newest first; equal times by id, descending, as PostgreSQL orders `uuid`. */
function newestFirst(a: MutableRun, b: MutableRun): number {
  const byTime = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (byTime !== 0) return byTime;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

const oldestFirst = (a: MutableRun, b: MutableRun): number => newestFirst(b, a);

/** A recipe store in memory, behaving as `recipeStoreOf` does. */
export function memoryRecipeStore(): MemoryRecipeStore {
  const runs = new Map<string, MutableRun>();
  const steps = new Map<string, MutableStep>();
  const stepId = (recipeRunId: string, key: string): string => `${recipeRunId}\u0000${key}`;

  const step = (recipeRunId: string, key: string): MutableStep | undefined =>
    steps.get(stepId(recipeRunId, key));
  const update = (recipeRunId: string, key: string, change: (row: MutableStep) => void): void => {
    const row = step(recipeRunId, key);
    if (row !== undefined) change(row);
  };
  const ofRun = (id: string): MutableStep[] =>
    [...steps.values()].filter((row) => row.recipeRunId === id);

  return {
    runs: () => [...runs.values()].map(copy),
    steps: () => [...steps.values()].map(stepRecord),

    insertOrGetRun(run) {
      const existing = [...runs.values()].find(
        (row) =>
          row.workspaceId === run.workspaceId &&
          row.recipe === run.recipe &&
          row.dedupeKey === run.dedupeKey,
      );
      if (existing !== undefined) return Promise.resolve({ run: copy(existing), created: false });
      const iso = run.at.toISOString();
      const created: MutableRun = {
        id: crypto.randomUUID(),
        workspaceId: run.workspaceId,
        recipe: run.recipe,
        status: 'running',
        input: copy(run.input),
        dedupeKey: run.dedupeKey,
        startedBy: run.startedBy,
        leaseOwner: null,
        leaseExpiresAt: null,
        error: null,
        createdAt: iso,
        updatedAt: iso,
      };
      runs.set(created.id, created);
      return Promise.resolve({ run: copy(created), created: true });
    },

    getRun(workspaceId, id) {
      const run = runs.get(id);
      return Promise.resolve(run?.workspaceId === workspaceId ? copy(run) : null);
    },

    claimLease(workspaceId, id, owner, at, until) {
      const run = runs.get(id);
      if (run?.workspaceId !== workspaceId || run.status !== 'running' || !leaseFree(run, at)) {
        return Promise.resolve(null);
      }
      run.leaseOwner = owner;
      run.leaseExpiresAt = until.toISOString();
      run.updatedAt = at.toISOString();
      return Promise.resolve(copy(run));
    },

    renewLease(id, owner, until) {
      const run = runs.get(id);
      if (run?.leaseOwner !== owner || run.status !== 'running') return Promise.resolve(false);
      run.leaseExpiresAt = until.toISOString();
      return Promise.resolve(true);
    },

    releaseLease(id, owner) {
      const run = runs.get(id);
      if (run?.leaseOwner === owner) {
        run.leaseOwner = null;
        run.leaseExpiresAt = null;
      }
      return Promise.resolve();
    },

    setRunStatus(id, status, error, at) {
      return Promise.resolve().then(() => {
        const code = error === null ? null : publicCodeOf(error);
        const run = runs.get(id);
        if (run === undefined) return;
        Object.assign(run, {
          status,
          error: code,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: at.toISOString(),
        });
      });
    },

    listResumable(workspaceId, at, limit) {
      return Promise.resolve(
        [...runs.values()]
          .filter((run) => run.workspaceId === workspaceId && run.status === 'running')
          .filter((run) => leaseFree(run, at))
          .sort(oldestFirst)
          .slice(0, limit)
          .map(copy),
      );
    },

    listWaiting(workspaceId, limit) {
      return Promise.resolve(
        [...runs.values()]
          .filter((run) => run.workspaceId === workspaceId && run.status === 'waiting')
          .sort(oldestFirst)
          .slice(0, limit)
          .map(copy),
      );
    },

    listRuns(workspaceId, options = {}) {
      return Promise.resolve().then(() => {
        const listKey = recipeRunsListKey(options);
        const request = pageRequestOf(options, listKey, workspaceId);
        const after = request.after;
        const rows = [...runs.values()]
          .filter((run) => run.workspaceId === workspaceId)
          .filter((run) => options.recipe === undefined || run.recipe === options.recipe)
          .filter((run) => options.status === undefined || run.status === options.status)
          .filter(
            (run) =>
              after === null ||
              Date.parse(run.createdAt) < Date.parse(after.createdAt) ||
              (Date.parse(run.createdAt) === Date.parse(after.createdAt) && run.id < after.id),
          )
          .sort(newestFirst)
          .slice(0, request.limit + 1)
          .map(copy);
        return recipeRunsPage(rows, request, workspaceId, listKey);
      });
    },

    findRunsByPlatformRun(workspaceId, runId) {
      const ids = [...steps.values()]
        .filter(
          (row) =>
            row.workspaceId === workspaceId &&
            (row.runId === runId || row.continuationRunId === runId),
        )
        .map((row) => row.recipeRunId);
      return Promise.resolve([...new Set(ids)]);
    },

    getStep(recipeRunId, key) {
      const row = step(recipeRunId, key);
      return Promise.resolve(row === undefined ? null : stepRecord(row));
    },

    listSteps(recipeRunId) {
      return Promise.resolve(ofRun(recipeRunId).map(stepRecord));
    },

    upsertStepRunning(recipeRunId, key, at) {
      const run = runs.get(recipeRunId);
      if (run === undefined) {
        return Promise.reject(new Error('the recipe run of the step does not exist'));
      }
      const existing = step(recipeRunId, key);
      if (existing !== undefined) return Promise.resolve(stepRecord(existing));
      const created: MutableStep = {
        workspaceId: run.workspaceId,
        recipeRunId,
        key,
        status: 'running',
        runId: null,
        continuationRunId: null,
        decision: null,
        output: null,
        error: null,
        startedAt: at.toISOString(),
        endedAt: null,
      };
      steps.set(stepId(recipeRunId, key), created);
      return Promise.resolve(stepRecord(created));
    },

    recordStepRun(recipeRunId, key, runId) {
      update(recipeRunId, key, (row) => {
        row.runId = runId;
      });
      return Promise.resolve();
    },

    suspendStep(recipeRunId, key) {
      update(recipeRunId, key, (row) => {
        row.status = 'awaiting_approval';
      });
      return Promise.resolve();
    },

    recordDecision(recipeRunId, key, decision, continuationRunId) {
      const row = step(recipeRunId, key);
      // The table's continuation check: a decision only on a step that has a run of its own.
      if (row !== undefined && row.runId === null) {
        return Promise.reject(new Error('recipe_steps_continuation_check'));
      }
      update(recipeRunId, key, (target) => {
        Object.assign(target, { status: 'running', decision, continuationRunId });
      });
      return Promise.resolve();
    },

    completeStep(recipeRunId, key, output, at) {
      update(recipeRunId, key, (row) => {
        Object.assign(row, {
          status: 'completed',
          output: copy(output),
          error: null,
          endedAt: at.toISOString(),
        });
      });
      return Promise.resolve();
    },

    failStep(recipeRunId, key, code, at) {
      return Promise.resolve().then(() => {
        const error = publicCodeOf(code);
        update(recipeRunId, key, (row) => {
          Object.assign(row, { status: 'failed', error, endedAt: at.toISOString() });
        });
      });
    },
  };
}
