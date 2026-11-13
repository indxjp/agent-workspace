import type { RecipeRunRecord } from '../db/recipe-port.js';
import type { DefinedRecipe } from '../recipe.js';
import {
  executeRecipeRun,
  type ExecutionContext,
  type ExecutionOutcome,
} from './recipe-runner-steps.js';

interface RecipeExecutionOptions extends Omit<ExecutionContext, 'signal'> {
  readonly workspaceId: string;
  readonly owner: string;
  readonly leaseMs: number;
  readonly stopping: AbortSignal;
  readonly recipes: ReadonlyMap<string, DefinedRecipe>;
  readonly log: (message: string, fields: Readonly<Record<string, string>>) => void;
}

export function recipeRunExecutor(options: RecipeExecutionOptions): (id: string) => Promise<void> {
  const { store, now, workspaceId, owner, leaseMs, stopping, recipes, log, client, records } =
    options;
  /**
   * Keeps the lease of `id` until `release` is called, and aborts the execution when it is lost.
   * shortcut: step writes are not fenced by the lease owner, so a holder that lost its lease may
   * still write until its abort lands; the step idempotency keys keep it from a second run, and a
   * fencing token on every step write is the upgrade if two holders ever race in practice.
   */
  const holdLease = (id: string): { readonly signal: AbortSignal; release(): void } => {
    const lost = new AbortController();
    const renew = setInterval(
      () => {
        const until = new Date(now().getTime() + leaseMs);
        void store
          .renewLease(id, owner, until)
          .then((held) => {
            if (!held) lost.abort();
          })
          .catch(() => undefined);
      },
      Math.max(1, Math.floor(leaseMs / 3)),
    );
    renew.unref();
    return {
      signal: AbortSignal.any([lost.signal, stopping]),
      release: () => clearInterval(renew),
    };
  };

  const report = (run: RecipeRunRecord, outcome: ExecutionOutcome): void => {
    if (outcome.kind === 'interrupted') {
      log('a recipe run was interrupted; resume() executes it again', {
        recipeRunId: run.id,
        recipe: run.recipe,
      });
    } else if (outcome.kind === 'failed') {
      log('a recipe run failed', { recipeRunId: run.id, recipe: run.recipe, code: outcome.code });
    }
  };

  /** Executes the recipe run `id` if its lease can be claimed; otherwise leaves it. */
  const execute = async (id: string): Promise<void> => {
    const at = now();
    const claimed = await store.claimLease(
      workspaceId,
      id,
      owner,
      at,
      new Date(at.getTime() + leaseMs),
    );
    if (claimed === null) return;
    const recipe = recipes.get(claimed.recipe);
    if (recipe === undefined) {
      await store.setRunStatus(id, 'failed', 'recipe_not_found', now());
      return;
    }
    const lease = holdLease(id);
    try {
      const outcome = await executeRecipeRun(
        {
          client: client,
          store,
          now,
          signal: lease.signal,
          ...(records === undefined ? {} : { records }),
        },
        recipe,
        claimed,
      );
      report(claimed, outcome);
      if (outcome.kind === 'interrupted') await store.releaseLease(id, owner);
    } catch {
      // Recording the outcome itself failed: the lease expires and resume() executes it again.
      log('a recipe run could not record its outcome', { recipeRunId: id, recipe: claimed.recipe });
    } finally {
      lease.release();
    }
  };

  return execute;
}
