/**
 * `POST …/steps/:key/decision`: the person's approval or rejection of the call a step waits on,
 * made with their own token, and the recipe resumed in the background.
 */
import { RunApprovalRequestSchema, type RunApprovalDecision } from '@indx-workspace/contracts/runs';
import { ApiProblemError, type AgentWorkspaceClient } from '@indx-workspace/sdk';

import { STEP_KEY_PATTERN } from '../recipe.js';
import { RecipeError } from './recipe-errors.js';
import {
  DECISION_RECORD_POLL_MS,
  DECISION_RECORD_WAIT_MS,
  issuePaths,
  json,
  logBackground,
  MESSAGES,
  notAwaiting,
  notFound,
  runnerOf,
  upstreamRefusal,
  type RecipeRoutesOptions,
  type RecipeStepRouteContext,
} from './recipe-routes-support.js';
import { detailOf, personScopeOf, runOf } from './recipe-run-views.js';
import type { PersonRunsClient } from './recipe-runner.js';
import { jsonBodyOf, RequestRefusal } from './routes.js';

/** Resolves once `predicate` holds, or after {@link DECISION_RECORD_WAIT_MS} regardless. */
async function settledWithin(predicate: () => Promise<boolean>): Promise<void> {
  const until = Date.now() + DECISION_RECORD_WAIT_MS;
  while (Date.now() < until && !(await predicate())) {
    await new Promise((resolve) => setTimeout(resolve, DECISION_RECORD_POLL_MS));
  }
}

/**
 * The person's client, with a signal of the moment the platform accepted their decision: the
 * runner then resumes the recipe in the background, and the route answers without waiting for it.
 */
function decidingClient(client: AgentWorkspaceClient): {
  readonly client: PersonRunsClient;
  readonly accepted: Promise<void>;
} {
  let accept: () => void = () => undefined;
  const accepted = new Promise<void>((resolve) => {
    accept = resolve;
  });
  const decide =
    (decision: RunApprovalDecision) =>
    async (runId: string, body: { readonly comment?: string }) => {
      const answer =
        decision === 'approve'
          ? await client.runs.approve(runId, body)
          : await client.runs.reject(runId, body);
      accept();
      return answer;
    };
  const runs = { ...client.runs, approve: decide('approve'), reject: decide('reject') };
  return { client: { runs } as PersonRunsClient, accepted };
}

/** The refusal of a runner's `decide`: the platform's own code when it refused. */
function decisionRefusal(error: unknown): unknown {
  if (error instanceof RecipeError) {
    if (error.code === 'recipe_run_not_found') return notFound();
    if (error.code === 'recipe_step_not_waiting') {
      return error.cause instanceof ApiProblemError ? upstreamRefusal(error.cause) : notAwaiting();
    }
  }
  return error;
}

export async function decide(
  options: RecipeRoutesOptions,
  request: Request,
  context: RecipeStepRouteContext,
): Promise<Response> {
  const scope = await personScopeOf(request, options.store);
  const { id, key } = await context.params;
  const run = await runOf(scope, id);
  // Parsed after the run is known to be the person's workspace's, so nothing leaks before it.
  const body = RunApprovalRequestSchema.safeParse(await jsonBodyOf(request));
  if (!body.success) {
    throw new RequestRefusal('invalid_body', 400, MESSAGES.invalid_body, issuePaths(body.error));
  }
  const step = STEP_KEY_PATTERN.test(key) ? await scope.store.getStep(run.id, key) : null;
  if (run.status !== 'waiting' || step?.status !== 'awaiting_approval') throw notAwaiting();
  const runner = runnerOf(options);
  const deciding = decidingClient(scope.client);
  const { decision, comment } = body.data;
  const outcome = runner.decide(
    { recipeRunId: run.id, stepKey: key, decision, ...(comment === undefined ? {} : { comment }) },
    deciding.client,
  );
  const accepted = deciding.accepted.then(() => 'accepted' as const);
  const first = await Promise.race([outcome.then(() => 'done' as const), accepted]).catch(
    (error: unknown) => {
      throw decisionRefusal(error);
    },
  );
  if (first === 'accepted') {
    outcome.catch((error: unknown) => {
      logBackground('resuming a decided recipe', error);
    });
    await settledWithin(async () => (await scope.store.getStep(run.id, key))?.decision != null);
  }
  const after = await scope.store.getStep(run.id, key);
  if (after?.status === 'failed' && after.error === 'approval_expired') {
    throw new RequestRefusal('approval_expired', 409, MESSAGES.refused);
  }
  return json(
    200,
    await detailOf(scope, (await scope.store.getRun(run.workspaceId, run.id)) ?? run),
  );
}
