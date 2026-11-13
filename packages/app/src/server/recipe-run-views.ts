/**
 * The recipe routes' reads: the person's scope once Agent Workspace said who they are, the run
 * views with their steps' cost and pending call, and the list query.
 */
import type { RunResource } from '@indx-workspace/contracts/runs';
import { AgentWorkspaceError, createClient, type AgentWorkspaceClient } from '@indx-workspace/sdk';
import { z } from 'zod';

import {
  RECIPE_RUN_STATUSES,
  type RecipeRunListOptions,
  type RecipeRunRecord,
  type RecipeStepRecord,
  type RecipeStore,
} from '../db/recipe-port.js';
import { RECIPE_NAME_PATTERN } from '../recipe.js';
import type { RecipeRunDetail, RecipeStepView } from '../recipe-wire.js';
import { currentPerson, personAuthOf } from './person.js';
import { issuePaths, MESSAGES, notFound, runView, UUID } from './recipe-routes-support.js';
import { RequestRefusal } from './routes.js';
import { appRuntime, type AppRuntime } from './runtime.js';

const ListQuerySchema = z.strictObject({
  recipe: z.string().regex(RECIPE_NAME_PATTERN).optional(),
  status: z.enum(RECIPE_RUN_STATUSES).optional(),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z
    .string()
    .regex(/^[0-9]{1,3}$/u)
    .transform(Number)
    .optional(),
});

/** The console's view of one run: the run history with its detail panel open. */
export function consoleRunUrl(awUrl: string, runId: string): string {
  return `${awUrl.replace(/\/+$/u, '')}/runs?run=${encodeURIComponent(runId)}`;
}

/** Everything a person's request runs with once Agent Workspace said who they are. */
export interface PersonScope {
  readonly runtime: AppRuntime;
  readonly store: RecipeStore;
  readonly workspaceId: string;
  readonly client: AgentWorkspaceClient;
}

export async function personScopeOf(
  request: Request,
  store: RecipeStore | undefined,
): Promise<PersonScope> {
  const runtime = appRuntime();
  const person = await currentPerson(request);
  const auth = personAuthOf(request);
  if (person === null || auth === undefined) {
    throw new RequestRefusal('unauthenticated', 401, MESSAGES.unauthenticated);
  }
  return {
    runtime,
    store: store ?? runtime.recipeStore,
    workspaceId: person.workspaceId.toLowerCase(),
    client: createClient({
      baseUrl: runtime.awUrl,
      auth,
      ...(runtime.fetch === undefined ? {} : { fetch: runtime.fetch }),
    }),
  };
}

/** The platform run `runId` read as the person, or `null` when they may not read it or it fails. */
async function platformRunOf(scope: PersonScope, runId: string): Promise<RunResource | null> {
  try {
    return await scope.client.runs.get(runId);
  } catch (error) {
    if (error instanceof AgentWorkspaceError) return null;
    throw error;
  }
}

async function stepView(scope: PersonScope, step: RecipeStepRecord): Promise<RecipeStepView> {
  const runId = step.continuationRunId ?? step.runId;
  const platform = runId === null ? null : await platformRunOf(scope, runId);
  return {
    key: step.key,
    status: step.status,
    runId,
    runUrl: runId === null ? null : consoleRunUrl(scope.runtime.awUrl, runId),
    decision: step.decision,
    error: step.error,
    startedAt: step.startedAt,
    endedAt: step.endedAt,
    cost:
      platform === null ? null : { amount: platform.cost.amount, currency: platform.cost.currency },
    pendingApproval:
      step.status === 'awaiting_approval' && platform?.status === 'awaiting_approval'
        ? platform.pendingApproval
        : null,
  };
}

/**
 * The run with its steps. shortcut: one `GET /api/runs/:id` per step on every read, as the person;
 * upgrade to one `runs.list` filtered by id when a recipe has more than a handful of steps.
 */
export async function detailOf(scope: PersonScope, run: RecipeRunRecord): Promise<RecipeRunDetail> {
  const steps = await scope.store.listSteps(run.id);
  return {
    run: runView(run),
    steps: await Promise.all(steps.map((step) => stepView(scope, step))),
  };
}

/** The recipe run `id` of the person's workspace; `404` for any other id. */
export async function runOf(scope: PersonScope, id: unknown): Promise<RecipeRunRecord> {
  if (typeof id !== 'string' || !UUID.test(id)) throw notFound();
  const run = await scope.store.getRun(scope.workspaceId, id.toLowerCase());
  if (run === null) throw notFound();
  return run;
}

export function listQueryOf(url: URL): RecipeRunListOptions {
  const keys = [...url.searchParams.keys()];
  const repeated = [...new Set(keys)].filter((key) => url.searchParams.getAll(key).length > 1);
  if (repeated.length > 0) {
    throw new RequestRefusal('invalid_query', 400, MESSAGES.invalid_query, repeated);
  }
  const parsed = ListQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    throw new RequestRefusal(
      'invalid_query',
      400,
      MESSAGES.invalid_query,
      issuePaths(parsed.error),
    );
  }
  // Only the keys asked for: a filter left out is no filter, not an `undefined` one.
  return Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined));
}
