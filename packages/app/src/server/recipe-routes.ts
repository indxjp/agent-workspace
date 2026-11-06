/**
 * `recipeRoutes`: the browser half of an app's recipes (F-2, issue #1514), as the Next.js handlers
 * of five route files, each one line more than its imports:
 *
 * ```ts
 * // app/api/recipes/runs/route.ts
 * export const { GET } = recipeRoutes(app).list;
 * // app/api/recipes/runs/[id]/route.ts
 * export const { GET } = recipeRoutes(app).item;
 * // app/api/recipes/runs/[id]/steps/[key]/decision/route.ts
 * export const { POST } = recipeRoutes(app).decision;
 * // app/api/recipes/webhook/route.ts
 * export const { POST } = recipeRoutes(app).webhook;
 * // app/api/recipes/slots/route.ts
 * export const { POST } = recipeRoutes(app).slots;
 * ```
 *
 * | Route                                               | Does                                          |
 * | --------------------------------------------------- | --------------------------------------------- |
 * | `GET /api/recipes/runs?recipe=&status=&cursor=`     | the workspace's recipe runs, newest first     |
 * | `GET /api/recipes/runs/:id`                         | one run with its steps, in order              |
 * | `POST /api/recipes/runs/:id/steps/:key/decision`    | approves or rejects the call a step waits on  |
 * | `POST /api/recipes/webhook`                         | a signed run-outcome webhook (N-3)            |
 * | `POST /api/recipes/slots`                           | starts a schedule's slot; never in production |
 *
 * The first three are the signed-in person's: Agent Workspace says who they are, any member may
 * read the recipe runs of their workspace, and a decision is made with the person's own token, so
 * the platform's own rule on who may decide (ADR-0145 D2.2) answers, and its refusal is passed on
 * by its code and status. A step's cost and pending call are read from the platform as the person
 * too, so a person never sees more of a run than the console would show them.
 *
 * The webhook is the platform's: it is verified with the app's `whsec_` secret
 * (`AW_APP_WEBHOOK_SECRET`) and wakes the steps waiting on the run, so a recipe advances on an
 * event; `follow` stays the fallback, and `resume()` the net under both.
 *
 * The slot trigger (ADR-0164 T3) lets a development app's Owner or Admin start one slot of a
 * schedule at a chosen instant, so a journey can move a record past a deadline. Under
 * `NODE_ENV=production` it answers `404` to everyone, before it reads the request.
 *
 * Every failure is the one problem envelope (ADR-0075); every answer carries `no-store`.
 */
import {
  RunApprovalRequestSchema,
  type RunApprovalDecision,
  type RunResource,
} from '@indx-workspace/contracts/runs';
import {
  AgentWorkspaceError,
  ApiProblemError,
  createClient,
  verifyWebhookSignature,
  WebhookVerificationError,
  type AgentWorkspaceClient,
} from '@indx-workspace/sdk';
import { z } from 'zod';

import {
  RECIPE_RUN_STATUSES,
  type RecipeRunListOptions,
  type RecipeRunRecord,
  type RecipeStepRecord,
  type RecipeStore,
} from '../db/recipe-port.js';
import { allows } from '../person.js';
import { RECIPE_NAME_PATTERN, STEP_KEY_PATTERN } from '../recipe.js';
import type {
  RecipeRunDetail,
  RecipeRunPage,
  RecipeRunView,
  RecipeSlotResponse,
  RecipeStepView,
} from '../recipe-wire.js';
import { currentPerson, personAuthOf } from './person.js';
import { NO_STORE } from './problem.js';
import { RecipeError } from './recipe-errors.js';
import { servedRecipeRunner } from './recipe-runner-runtime.js';
import type { PersonRunsClient, RecipeApp, RecipeRunner } from './recipe-runner.js';
import { boundedText, jsonBodyOf, refusalOf, RequestRefusal } from './routes.js';
import { appRuntime, type AppRuntime } from './runtime.js';

/** What {@link recipeRoutes} may be given besides the app; each has a default. */
export interface RecipeRoutesOptions {
  /**
   * The runner a decision resumes and a webhook wakes, or a function that finds it when a request
   * comes; the one `serveRecipes` started by default.
   */
  readonly runner?: RecipeRunner | (() => RecipeRunner | undefined);
  /** The recipe runs read; the runtime's `recipeStore` by default. */
  readonly store?: RecipeStore;
  /** The clock the webhook's timestamp is checked against; the current time by default. */
  readonly now?: () => Date;
}

/** What Next.js 16 passes `app/api/recipes/runs/[id]/route.ts`'s handler. */
export interface RecipeRunRouteContext {
  readonly params: Promise<{ readonly id: string }>;
}

/** What Next.js 16 passes `app/api/recipes/runs/[id]/steps/[key]/decision/route.ts`'s handler. */
export interface RecipeStepRouteContext {
  readonly params: Promise<{ readonly id: string; readonly key: string }>;
}

/** The handlers of the five recipe route files. */
export interface RecipeRoutes {
  readonly list: { readonly GET: (request: Request) => Promise<Response> };
  readonly item: {
    readonly GET: (request: Request, context: RecipeRunRouteContext) => Promise<Response>;
  };
  readonly decision: {
    readonly POST: (request: Request, context: RecipeStepRouteContext) => Promise<Response>;
  };
  readonly webhook: { readonly POST: (request: Request) => Promise<Response> };
  /** The development-only slot trigger; `404` in production (ADR-0164 T3). */
  readonly slots: { readonly POST: (request: Request) => Promise<Response> };
}

/** The fixed words of each refusal the recipe routes make themselves. */
const MESSAGES = {
  unauthenticated: 'Sign in to Agent Workspace to use this app.',
  not_found: 'No such recipe run, or it is not of your workspace.',
  not_awaiting: 'This step is not waiting for a decision.',
  invalid_query: 'The query is not valid.',
  invalid_body: 'The request body is not valid.',
  runner_unavailable:
    'The recipes are not running in this app: serveRecipes needs AW_APP_API_KEY besides the app settings.',
  webhook_unavailable:
    'The app has no webhook secret: set AW_APP_WEBHOOK_SECRET to the secret Agent Workspace returned.',
  webhook_unverified: 'The webhook delivery could not be verified.',
  slots_not_found: 'Not found.',
  slots_forbidden: 'Only an Owner or an Admin may start a schedule slot.',
  recipe_not_found: 'The app has no recipe of that name.',
  recipe_not_schedule: 'That recipe does not run on a schedule.',
  refused: 'Agent Workspace refused the request.',
  upstream: 'Agent Workspace did not answer as expected. Try again later.',
} as const;

/** A code Agent Workspace answered with, safe to pass on: snake_case, bounded. */
const PROBLEM_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** How long a decision waits for the runner to record it before answering. */
const DECISION_RECORD_WAIT_MS = 2000;
const DECISION_RECORD_POLL_MS = 20;

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

/** `POST /api/recipes/slots`'s body: a schedule recipe's name and the slot's instant. */
const SlotRequestSchema = z.strictObject({
  recipe: z.string().regex(RECIPE_NAME_PATTERN),
  at: z.iso.datetime({ offset: true }),
});

/** The console's view of one run: the run history with its detail panel open. */
export function consoleRunUrl(awUrl: string, runId: string): string {
  return `${awUrl.replace(/\/+$/u, '')}/runs?run=${encodeURIComponent(runId)}`;
}

/** The runner of a request: the one given, the one the given function finds, or the served one. */
function runnerOf(options: RecipeRoutesOptions): RecipeRunner {
  const given = options.runner;
  const runner = typeof given === 'function' ? given() : (given ?? servedRecipeRunner());
  if (runner === undefined) throw unavailable(MESSAGES.runner_unavailable);
  return runner;
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { 'cache-control': NO_STORE } });
}

function notFound(): RequestRefusal {
  return new RequestRefusal('recipe_run_not_found', 404, MESSAGES.not_found);
}

function notAwaiting(): RequestRefusal {
  return new RequestRefusal('recipe_step_not_awaiting_approval', 409, MESSAGES.not_awaiting);
}

function unavailable(message: string): RequestRefusal {
  return new RequestRefusal('recipes_unavailable', 503, message);
}

function issuePaths(error: z.ZodError): string[] {
  return error.issues.map((issue) => issue.path.map(String).join('.') || '$');
}

/** A failure of Agent Workspace's: a refusal (`4xx`) by its code and status, else `502`. */
function upstreamRefusal(error: AgentWorkspaceError): RequestRefusal {
  if (error instanceof ApiProblemError && error.status >= 400 && error.status < 500) {
    const code = PROBLEM_CODE.test(error.code) ? error.code : 'upstream_refused';
    return new RequestRefusal(code, error.status, MESSAGES.refused);
  }
  return new RequestRefusal('upstream_failure', 502, MESSAGES.upstream);
}

function failureOf(error: unknown): Response {
  if (error instanceof AgentWorkspaceError) return refusalOf(upstreamRefusal(error));
  return refusalOf(error);
}

function runView(run: RecipeRunRecord): RecipeRunView {
  return {
    id: run.id,
    recipe: run.recipe,
    status: run.status,
    error: run.error,
    startedBy: run.startedBy,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

/** Everything a person's request runs with once Agent Workspace said who they are. */
interface PersonScope {
  readonly runtime: AppRuntime;
  readonly store: RecipeStore;
  readonly workspaceId: string;
  readonly client: AgentWorkspaceClient;
}

async function personScopeOf(
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
async function detailOf(scope: PersonScope, run: RecipeRunRecord): Promise<RecipeRunDetail> {
  const steps = await scope.store.listSteps(run.id);
  return {
    run: runView(run),
    steps: await Promise.all(steps.map((step) => stepView(scope, step))),
  };
}

/** The recipe run `id` of the person's workspace; `404` for any other id. */
async function runOf(scope: PersonScope, id: unknown): Promise<RecipeRunRecord> {
  if (typeof id !== 'string' || !UUID.test(id)) throw notFound();
  const run = await scope.store.getRun(scope.workspaceId, id.toLowerCase());
  if (run === null) throw notFound();
  return run;
}

function listQueryOf(url: URL): RecipeRunListOptions {
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

function logBackground(what: string, error: unknown): void {
  const code = error instanceof RecipeError ? error.code : 'internal_error';
  console.error(`[recipes] ${what} failed in the background (${code})`);
}

async function decide(
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

async function receiveWebhook(options: RecipeRoutesOptions, request: Request): Promise<Response> {
  const runtime = appRuntime();
  const secret = runtime.recipeWebhookSecret;
  if (secret === undefined) throw unavailable(MESSAGES.webhook_unavailable);
  const runner = runnerOf(options);
  const body = await boundedText(request).catch((error: unknown) => {
    if (error instanceof RequestRefusal) throw error;
    throw new RequestRefusal('malformed_body', 400, 'The request body is not UTF-8 text.');
  });
  let event;
  try {
    event = await verifyWebhookSignature({
      secret,
      headers: request.headers,
      body,
      ...(options.now === undefined ? {} : { now: options.now() }),
    });
  } catch (error) {
    if (!(error instanceof WebhookVerificationError)) throw error;
    throw new RequestRefusal('webhook_unverified', 401, MESSAGES.webhook_unverified, [error.code]);
  }
  // Answered at once: waking a step may wait on its next run, longer than a delivery may take.
  runner.onRunOutcome(event).catch((error: unknown) => {
    logBackground('a run-outcome webhook', error);
  });
  return new Response(null, { status: 202, headers: { 'cache-control': NO_STORE } });
}

/**
 * Starts the slot `{ recipe, at }` as a development app's Owner or Admin (ADR-0164 T3). The slot's
 * recipe run has no person, like any scheduled one, so its `actingFor` steps act as they would.
 */
async function fireSlot(options: RecipeRoutesOptions, request: Request): Promise<Response> {
  if (process.env['NODE_ENV'] === 'production') {
    throw new RequestRefusal('not_found', 404, MESSAGES.slots_not_found);
  }
  const person = await currentPerson(request);
  if (person === null) throw new RequestRefusal('unauthenticated', 401, MESSAGES.unauthenticated);
  if (!allows('role:admin', person)) {
    throw new RequestRefusal('forbidden', 403, MESSAGES.slots_forbidden);
  }
  const body = SlotRequestSchema.safeParse(await jsonBodyOf(request));
  if (!body.success) {
    throw new RequestRefusal('invalid_body', 400, MESSAGES.invalid_body, issuePaths(body.error));
  }
  const runner = runnerOf(options);
  let run: RecipeRunRecord;
  try {
    run = await runner.fireSlot(body.data.recipe, new Date(body.data.at));
  } catch (error) {
    if (
      error instanceof RecipeError &&
      (error.code === 'recipe_not_found' || error.code === 'recipe_not_schedule')
    ) {
      throw new RequestRefusal(error.code, 400, MESSAGES[error.code]);
    }
    throw error;
  }
  const answer: RecipeSlotResponse = { run: runView(run) };
  return json(202, answer);
}

/**
 * The recipe routes of `app`.
 *
 * | Status | Code                                                                                  |
 * | ------ | ------------------------------------------------------------------------------------- |
 * | 200    | a page `{ items, nextCursor }`, or a run with its steps `{ run, steps }`              |
 * | 202    | the webhook was verified and its run's steps are being woken; a slot's run `{ run }`  |
 * | 400    | `invalid_query`, `invalid_cursor`, `invalid_limit`, `invalid_body`, `malformed_body`; `recipe_not_found`, `recipe_not_schedule` (slots) |
 * | 401    | `unauthenticated`; `webhook_unverified` (unsigned, stale or forged delivery)          |
 * | 403    | Agent Workspace's own refusal of the person's decision, unchanged; `forbidden` (slots, not an Owner or Admin) |
 * | 404    | `recipe_run_not_found` (no such run, or another workspace's); `not_found` (slots in production) |
 * | 409    | `recipe_step_not_awaiting_approval`; `approval_already_decided`, `approval_expired`, `run_not_awaiting_approval` |
 * | 413    | `request_body_too_large`                                                              |
 * | 415    | `unsupported_media_type`                                                              |
 * | 500    | `app_misconfigured`, `internal_error`                                                 |
 * | 502    | `upstream_failure`                                                                    |
 * | 503    | `recipes_unavailable` (no runner in this process, or no webhook secret)               |
 *
 * @throws {TypeError} when two of `app`'s recipes share a name.
 */
export function recipeRoutes(app: RecipeApp, options: RecipeRoutesOptions = {}): RecipeRoutes {
  const names = app.recipes.map((recipe) => recipe.name);
  if (new Set(names).size !== names.length) {
    throw new TypeError('recipeRoutes: two recipes share a name.');
  }
  const guarded =
    <A extends unknown[]>(handler: (...args: A) => Promise<Response>) =>
    async (...args: A): Promise<Response> => {
      try {
        return await handler(...args);
      } catch (error) {
        return failureOf(error);
      }
    };

  return {
    list: {
      GET: guarded(async (request: Request) => {
        const scope = await personScopeOf(request, options.store);
        const query = listQueryOf(new URL(request.url));
        const page = await scope.store.listRuns(scope.workspaceId, query);
        const answer: RecipeRunPage = {
          items: page.items.map(runView),
          nextCursor: page.nextCursor,
        };
        return json(200, answer);
      }),
    },
    item: {
      GET: guarded(async (request: Request, context: RecipeRunRouteContext) => {
        const scope = await personScopeOf(request, options.store);
        const { id } = await context.params;
        return json(200, await detailOf(scope, await runOf(scope, id)));
      }),
    },
    decision: {
      POST: guarded((request: Request, context: RecipeStepRouteContext) =>
        decide(options, request, context),
      ),
    },
    webhook: { POST: guarded((request: Request) => receiveWebhook(options, request)) },
    slots: { POST: guarded((request: Request) => fireSlot(options, request)) },
  };
}
