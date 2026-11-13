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
import { verifyWebhookSignature, WebhookVerificationError } from '@indx-workspace/sdk';
import { z } from 'zod';

import type { RecipeRunRecord } from '../db/recipe-port.js';
import { allows } from '../person.js';
import { RECIPE_NAME_PATTERN } from '../recipe.js';
import type { RecipeRunPage, RecipeSlotResponse } from '../recipe-wire.js';
import { currentPerson } from './person.js';
import { NO_STORE } from './problem.js';
import { decide } from './recipe-decision-route.js';
import { RecipeError } from './recipe-errors.js';
import {
  failureOf,
  issuePaths,
  json,
  logBackground,
  MESSAGES,
  runnerOf,
  runView,
  unavailable,
  type RecipeRoutesOptions,
  type RecipeRunRouteContext,
  type RecipeStepRouteContext,
} from './recipe-routes-support.js';
import { detailOf, listQueryOf, personScopeOf, runOf } from './recipe-run-views.js';
import type { RecipeApp } from './recipe-runner.js';
import { boundedText, jsonBodyOf, RequestRefusal } from './routes.js';
import { appRuntime } from './runtime.js';

export type {
  RecipeRoutesOptions,
  RecipeRunRouteContext,
  RecipeStepRouteContext,
} from './recipe-routes-support.js';
export { consoleRunUrl } from './recipe-run-views.js';

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

/** `POST /api/recipes/slots`'s body: a schedule recipe's name and the slot's instant. */
const SlotRequestSchema = z.strictObject({
  recipe: z.string().regex(RECIPE_NAME_PATTERN),
  at: z.iso.datetime({ offset: true }),
});

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
