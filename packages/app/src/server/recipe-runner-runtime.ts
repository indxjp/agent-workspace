/**
 * `serveRecipes`: the app's recipes running in its server process (issue #1513), started once by
 * the template's `instrumentation.ts` after the migration, from the same environment as
 * `appRuntime`, plus the app's machine key `AW_APP_API_KEY`, which starts every step's run and
 * reads the member roles a recipe's `store` acts with (ADR-0164).
 *
 * The runner is kept under a global registry key, so the stores `appRuntime` builds (in the route
 * handlers' module graph) reach the runner `instrumentation.ts` started (in its own): a committed
 * write calls {@link notifyRecipes}, which starts the recipes on it.
 */
import { API_KEY_PREFIX } from '@indx-workspace/contracts/api-keys';
import { createClient } from '@indx-workspace/sdk';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { z } from 'zod';

import type { OnCommitted } from '../db/port.js';
import { recipeStoreOf } from '../db/recipe-store.js';
import { appSchemaName } from '../db/schema-name.js';
import { appStoresOf } from './app-stores.js';
import { cachedMemberDirectory } from './mcp-person.js';
import { RecipeError } from './recipe-errors.js';
import {
  recipeRunner,
  type RecipeApp,
  type RecipeClock,
  type RecipeRunner,
} from './recipe-runner.js';

const RUNNER_KEY = Symbol.for('agentworkspace.dev/app/recipe-runner');

type Registry = Record<symbol, RecipeRunner | undefined>;

/** The runner {@link serveRecipes} started in this process, if any. */
export function servedRecipeRunner(): RecipeRunner | undefined {
  return (globalThis as unknown as Registry)[RUNNER_KEY];
}

/** The `onCommitted` hook of the runtime's stores: the served runner's `onResourceEvent`. */
export const notifyRecipes: OnCommitted = async (resource, event, row, person) => {
  await servedRecipeRunner()?.onResourceEvent(resource, event, row, {
    principalId: person.principalId,
  });
};

function isAppName(name: string): boolean {
  try {
    appSchemaName(name);
    return true;
  } catch {
    return false;
  }
}

const RecipesEnvironmentSchema = z.strictObject({
  AW_URL: z.url({ protocol: /^https?$/u }),
  AW_APP_NAME: z.string().refine(isAppName),
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/u }),
  AW_WORKSPACE_ID: z.uuid(),
  AW_APP_API_KEY: z.string().startsWith(API_KEY_PREFIX),
});

/** The variables {@link serveRecipes} reads. */
export const RECIPE_ENVIRONMENT_VARIABLES = Object.keys(RecipesEnvironmentSchema.shape);

/** What {@link serveRecipes} takes besides the app and its environment. */
export interface ServeRecipesOptions {
  /**
   * The clock the runner reads (ADR-0164 T1), for a test that moves time; the wall clock when not
   * given. Refused in production.
   */
  readonly clock?: RecipeClock;
}

/** Whether `environment` or this process runs as production (`next start`, the image). */
function isProduction(environment: NodeJS.ProcessEnv): boolean {
  return environment['NODE_ENV'] === 'production' || process.env['NODE_ENV'] === 'production';
}

/**
 * Starts `app`'s recipes in this process: resumes what an earlier process left (`resume`), then
 * evaluates schedules and expired leases every 30 seconds (`startBackground`). A second call
 * returns the runner the first started.
 *
 * @throws {RecipeError} `platform_lacks_idempotent_start` when the SDK cannot send the step keys;
 *   `clock_override_refused` when given a clock while `NODE_ENV` is `production`.
 *
 * @returns the runner, or `null` when the app has no recipes, or when a variable of
 *   {@link RECIPE_ENVIRONMENT_VARIABLES} is missing or invalid (reported once, by name only).
 */
export async function serveRecipes(
  app: RecipeApp,
  environment: NodeJS.ProcessEnv = process.env,
  options: ServeRecipesOptions = {},
): Promise<RecipeRunner | null> {
  if (options.clock !== undefined && isProduction(environment)) {
    throw new RecipeError(
      'clock_override_refused',
      'serveRecipes takes no clock in production: schedules run on the wall clock',
    );
  }
  const served = servedRecipeRunner();
  if (served !== undefined) return served;
  if (app.recipes.length === 0) return null;
  const parsed = RecipesEnvironmentSchema.safeParse(
    Object.fromEntries(RECIPE_ENVIRONMENT_VARIABLES.map((name) => [name, environment[name]])),
  );
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    console.error(`[recipes] not started: ${names.join(', ')} missing or invalid`);
    return null;
  }
  const env = parsed.data;
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 4 });
  pool.on('error', (error: Error) => {
    console.error(`[recipes] an idle database connection failed (${error.name})`);
  });
  const client = createClient({
    baseUrl: env.AW_URL,
    auth: { kind: 'api-key', apiKey: env.AW_APP_API_KEY },
  });
  const db = drizzle(pool);
  const runner = recipeRunner(app, {
    client,
    store: recipeStoreOf({ db, appName: env.AW_APP_NAME }),
    workspaceId: env.AW_WORKSPACE_ID.toLowerCase(),
    // A recipe's writes are committed writes like any other: they publish on bound channels and
    // start the recipes on them. A recipe that writes the resource it starts on must tell its own
    // writes apart (an agent reply carries `run_id`), or it starts itself again.
    stores: appStoresOf({ db, appName: env.AW_APP_NAME, onCommitted: notifyRecipes }),
    members: cachedMemberDirectory(() => client.team.members.list()),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  (globalThis as unknown as Registry)[RUNNER_KEY] = runner;
  try {
    await runner.resume();
  } catch (error) {
    if (error instanceof RecipeError) throw error;
    // The app serves anyway; the background timer resumes once the platform answers.
    console.error(
      `[recipes] the first resume failed (${error instanceof Error ? error.name : 'unknown'})`,
    );
  }
  runner.startBackground();
  return runner;
}
