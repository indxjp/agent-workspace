/**
 * What the recipe routes share: their options and route contexts, the fixed words of their
 * refusals, the refusals themselves, and the runner a request finds.
 */
import { AgentWorkspaceError, ApiProblemError } from '@indx-workspace/sdk';
import type { z } from 'zod';

import type { RecipeStore, RecipeRunRecord } from '../db/recipe-port.js';
import type { RecipeRunView } from '../recipe-wire.js';
import { NO_STORE } from './problem.js';
import { RecipeError } from './recipe-errors.js';
import { servedRecipeRunner } from './recipe-runner-runtime.js';
import type { RecipeRunner } from './recipe-runner.js';
import { refusalOf, RequestRefusal } from './routes.js';

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

/** The fixed words of each refusal the recipe routes make themselves. */
export const MESSAGES = {
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
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** How long a decision waits for the runner to record it before answering. */
export const DECISION_RECORD_WAIT_MS = 2000;
export const DECISION_RECORD_POLL_MS = 20;

/** The runner of a request: the one given, the one the given function finds, or the served one. */
export function runnerOf(options: RecipeRoutesOptions): RecipeRunner {
  const given = options.runner;
  const runner = typeof given === 'function' ? given() : (given ?? servedRecipeRunner());
  if (runner === undefined) throw unavailable(MESSAGES.runner_unavailable);
  return runner;
}

export function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { 'cache-control': NO_STORE } });
}

export function notFound(): RequestRefusal {
  return new RequestRefusal('recipe_run_not_found', 404, MESSAGES.not_found);
}

export function notAwaiting(): RequestRefusal {
  return new RequestRefusal('recipe_step_not_awaiting_approval', 409, MESSAGES.not_awaiting);
}

export function unavailable(message: string): RequestRefusal {
  return new RequestRefusal('recipes_unavailable', 503, message);
}

export function issuePaths(error: z.ZodError): string[] {
  return error.issues.map((issue) => issue.path.map(String).join('.') || '$');
}

/** A failure of Agent Workspace's: a refusal (`4xx`) by its code and status, else `502`. */
export function upstreamRefusal(error: AgentWorkspaceError): RequestRefusal {
  if (error instanceof ApiProblemError && error.status >= 400 && error.status < 500) {
    const code = PROBLEM_CODE.test(error.code) ? error.code : 'upstream_refused';
    return new RequestRefusal(code, error.status, MESSAGES.refused);
  }
  // The person is told only that Agent Workspace did not answer; the operator needs the cause.
  console.error(
    `[recipes] Agent Workspace did not answer as expected (${error.name}${
      error instanceof ApiProblemError ? ` ${String(error.status)} ${error.code}` : ''
    })`,
  );
  return new RequestRefusal('upstream_failure', 502, MESSAGES.upstream);
}

export function failureOf(error: unknown): Response {
  if (error instanceof AgentWorkspaceError) return refusalOf(upstreamRefusal(error));
  return refusalOf(error);
}

export function runView(run: RecipeRunRecord): RecipeRunView {
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

export function logBackground(what: string, error: unknown): void {
  const code = error instanceof RecipeError ? error.code : 'internal_error';
  console.error(`[recipes] ${what} failed in the background (${code})`);
}
