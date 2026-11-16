/**
 * `recipeClient`: the browser's way to the app's recipe routes (issue #1514), so `RecipeGraph`
 * and `RecipeRunList` never call `fetch` themselves. Every answer is parsed with the wire's
 * schemas; a failure is one {@link ResourceProblemError}, its code the route's own.
 */
import { ApiProblemSchema } from '@indx-workspace/contracts';
import type { RunApprovalDecision } from '@indx-workspace/contracts/runs';
import type { z } from 'zod';

import type { RecipeRunStatus } from '../db/recipe-port.js';
import {
  RecipeRunDetailSchema,
  RecipeRunPageSchema,
  recipeRunsPath,
  type RecipeRunDetail,
  type RecipeRunPage,
} from '../recipe-wire.js';
import { ResourceProblemError } from './client.js';

/** Where the recipe routes are and how to reach them. */
export interface RecipeClientOptions {
  /** The app's origin and path prefix; `''` (the page's own origin) when not given. */
  readonly baseUrl?: string;
  /** Injected for tests; the global `fetch` when not given. */
  readonly fetch?: typeof fetch;
}

/** What a list of recipe runs asks for: one recipe, one status, the page after `cursor`. */
export interface RecipeRunQuery {
  readonly recipe?: string | undefined;
  readonly status?: RecipeRunStatus | undefined;
  readonly cursor?: string | null | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** The app's recipe routes. */
export interface RecipeClient {
  list(query?: RecipeRunQuery): Promise<RecipeRunPage>;
  get(recipeRunId: string, options?: { readonly signal?: AbortSignal }): Promise<RecipeRunDetail>;
  decide(
    recipeRunId: string,
    stepKey: string,
    decision: RunApprovalDecision,
    comment?: string,
  ): Promise<RecipeRunDetail>;
}

/** The failure of an answer that is not the one expected: the route's problem, or why not. */
export async function failureOf(response: Response): Promise<ResourceProblemError> {
  const parsed = ApiProblemSchema.safeParse(await response.json().catch(() => null));
  return new ResourceProblemError(
    parsed.success
      ? {
          code: parsed.data.error.code,
          status: response.status,
          message: parsed.data.error.message,
        }
      : {
          code: 'unrecognised_error_body',
          status: response.status,
          message: `the app answered ${String(response.status)} without the problem envelope`,
        },
  );
}

/** Builds the client of the recipe routes at `options.baseUrl`. */
export function recipeClient(options: RecipeClientOptions = {}): RecipeClient {
  const origin = (options.baseUrl ?? '').replace(/\/+$/u, '');
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function call<S extends z.ZodType>(
    path: string,
    schema: S,
    init: RequestInit,
  ): Promise<z.output<S>> {
    let response: Response;
    try {
      response = await send(`${origin}${path}`, { credentials: 'same-origin', ...init });
    } catch {
      throw new ResourceProblemError({
        code: 'transport_failed',
        status: 0,
        message: `${init.method ?? 'GET'} ${path} got no answer`,
      });
    }
    if (response.status !== 200) throw await failureOf(response);
    const parsed = schema.safeParse(await response.json().catch(() => undefined));
    if (parsed.success) return parsed.data;
    throw new ResourceProblemError({
      code: 'contract_violation',
      status: response.status,
      message: `${path} answered a body the recipe wire refuses`,
    });
  }

  const accept = { accept: 'application/json' };
  return {
    list(query = {}) {
      const search = new URLSearchParams();
      if (query.recipe !== undefined) search.set('recipe', query.recipe);
      if (query.status !== undefined) search.set('status', query.status);
      if (query.cursor != null) search.set('cursor', query.cursor);
      const suffix = search.size === 0 ? '' : `?${search.toString()}`;
      return call(`${recipeRunsPath()}${suffix}`, RecipeRunPageSchema, {
        headers: accept,
        ...(query.signal === undefined ? {} : { signal: query.signal }),
      });
    },
    get(recipeRunId, getOptions = {}) {
      return call(recipeRunsPath(recipeRunId), RecipeRunDetailSchema, {
        headers: accept,
        ...(getOptions.signal === undefined ? {} : { signal: getOptions.signal }),
      });
    },
    decide(recipeRunId, stepKey, decision, comment) {
      return call(recipeRunsPath(recipeRunId, stepKey), RecipeRunDetailSchema, {
        method: 'POST',
        headers: { ...accept, 'content-type': 'application/json' },
        body: JSON.stringify(comment === undefined ? { decision } : { decision, comment }),
      });
    },
  };
}
