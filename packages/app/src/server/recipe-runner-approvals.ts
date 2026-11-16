import { ApiProblemError } from '@indx-workspace/sdk';
import type { RecipeRunRecord, RecipeStore } from '../db/recipe-port.js';
import type { PersonRunsClient, RecipeDecision } from './recipe-runner.js';
import { RecipeError } from './recipe-errors.js';
import { approvalExpired } from './recipe-runner-steps.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

interface RecipeApprovalOptions {
  readonly store: RecipeStore;
  readonly workspaceId: string;
  readonly now: () => Date;
  readonly client: PersonRunsClient;
  readonly ready: () => Promise<void>;
  readonly execute: (id: string) => Promise<void>;
  readonly track: <T>(promise: Promise<T>) => Promise<T>;
  readonly log: (message: string, fields: Readonly<Record<string, string>>) => void;
}

export function recipeApprovals(options: RecipeApprovalOptions) {
  const { store, workspaceId, now, client, ready, execute, track, log } = options;
  const current = async (id: string): Promise<RecipeRunRecord> => {
    const run = await store.getRun(workspaceId, id);
    if (run === null) throw new RecipeError('recipe_run_not_found');
    return run;
  };

  /** Fails the waiting step of `run` with `code`, and the recipe run with it. */
  const failWaiting = async (run: RecipeRunRecord, key: string, code: string): Promise<void> => {
    await store.failStep(run.id, key, code, now());
    await store.setRunStatus(run.id, 'failed', code, now());
    log('a recipe approval could not be resumed', {
      recipeRunId: run.id,
      recipe: run.recipe,
      code,
    });
  };

  /**
   * Re-checks a `waiting` run's paused platform run. shortcut: continuation known only when the
   * app decides, upgrade when #1440 exposes RunResource.continuesRunId; until then a paused run
   * decided anywhere else (the console) fails the step with `approval_decided_outside_recipe`.
   */
  const recheckWaiting = async (run: RecipeRunRecord): Promise<void> => {
    const steps = await store.listSteps(run.id);
    const paused = steps.find((step) => step.status === 'awaiting_approval');
    if (paused?.runId == null) {
      // A decision was recorded and the recipe run not yet set back to running: finish that.
      await store.setRunStatus(run.id, 'running', null, now());
      await execute(run.id);
      return;
    }
    const platformRun = await client.runs.get(paused.continuationRunId ?? paused.runId);
    if (platformRun.status === 'awaiting_approval') return;
    await failWaiting(
      run,
      paused.key,
      approvalExpired(platformRun) ? 'approval_expired' : 'approval_decided_outside_recipe',
    );
  };

  const decide = async (
    decision: RecipeDecision,
    personClient: PersonRunsClient,
  ): Promise<RecipeRunRecord> => {
    await ready();
    if (!UUID.test(decision.recipeRunId)) throw new RecipeError('recipe_run_not_found');
    const run = await current(decision.recipeRunId);
    const step = await store.getStep(run.id, decision.stepKey);
    if (run.status !== 'waiting' || step?.status !== 'awaiting_approval' || step.runId === null) {
      throw new RecipeError('recipe_step_not_waiting');
    }
    const paused = step.continuationRunId ?? step.runId;
    const body = decision.comment === undefined ? {} : { comment: decision.comment };
    let continuationId: string;
    try {
      const response =
        decision.decision === 'approve'
          ? await personClient.runs.approve(paused, body)
          : await personClient.runs.reject(paused, body);
      continuationId = response.run.id;
    } catch (error) {
      if (error instanceof ApiProblemError && error.code === 'approval_expired') {
        await failWaiting(run, step.key, 'approval_expired');
        return current(run.id);
      }
      // Decided by someone else meanwhile: resume() finds out which, and fails or resumes.
      if (
        error instanceof ApiProblemError &&
        (error.code === 'approval_already_decided' || error.code === 'run_not_awaiting_approval')
      ) {
        throw new RecipeError('recipe_step_not_waiting', 'the approval was already decided', {
          cause: error,
        });
      }
      throw error;
    }
    await store.recordDecision(run.id, step.key, decision.decision, continuationId);
    await store.setRunStatus(run.id, 'running', null, now());
    await track(execute(run.id));
    return current(run.id);
  };

  return { current, recheckWaiting, decide };
}
