/**
 * `appRuntime`: what an app's route handlers run on (issue #1503), built once per process from the
 * app's environment: the Agent Workspace origin a request's person is resolved against, the app's
 * name key, the one workspace the deployment serves, and one PostgreSQL pool whose Drizzle database
 * every resource store shares.
 *
 * The agent tools (`mcpEndpoint`, issue #1504) also read the four
 * {@link AGENT_TOOL_ENVIRONMENT_VARIABLES}. Only they need the other three, so a resource route
 * works without them; the runtime's `agentTools` is then `undefined` and the agent endpoint answers
 * `500 app_misconfigured`.
 *
 * shortcut: one workspace per app deployment (`AW_WORKSPACE_ID`): `currentPerson` admits only a
 * member of it and the agent tools only an assertion for it; upgrade to a workspace→secret map
 * when an app serves several.
 *
 * This is the app's composition root: the one place its environment is read. A missing or invalid
 * variable is `AppServerError('app_misconfigured')`, whose fixed message names the variables and
 * never echoes a value (a `DATABASE_URL` carries a password).
 */
import { API_KEY_PREFIX } from '@indx-workspace/contracts/api-keys';
import { WebhookSecretSchema } from '@indx-workspace/contracts/webhooks';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { z } from 'zod';

import { agentPanelSessionsOf, type AgentPanelSessionStore } from '../db/agent-panel-sessions.js';
import { channelEventLogOf, type ChannelEventLog } from '../db/channel-events.js';
import { AppStoreError } from '../db/errors.js';
import { isPageStore } from '../db/page-policy.js';
import type { PageStore } from '../db/page-port.js';
import type { ResourceStore } from '../db/port.js';
import type { RecipeStore } from '../db/recipe-port.js';
import { recipeStoreOf } from '../db/recipe-store.js';
import { appSchemaName } from '../db/schema-name.js';
import type { DefinedPages } from '../pages/define-pages.js';
import type { DefinedResource, FieldMap } from '../resource.js';
import { appStoresOf } from './app-stores.js';
import { createChannelListener, type ChannelListener } from './channel-listener.js';
import { AppServerError } from './problem.js';
import { notifyRecipes } from './recipe-runner-runtime.js';

/** The agent tools' settings: what an assertion is checked against, and the role lookup key. */
export interface AgentToolsConfig {
  /** The platform's id of the app's `mcp` connector (`AW_APP_CONNECTOR_ID`): the `aud`. */
  readonly connectorId: string;
  /** The one workspace this deployment serves (`AW_WORKSPACE_ID`): the assertion's `workspace`. */
  readonly workspaceId: string;
  /**
   * The connector's signing secrets (`AW_APP_IDENTITY_SECRET`, comma-separated), the current one
   * and, while it rotates, the one before.
   */
  readonly identitySecrets: readonly string[];
  /**
   * The app's machine key (`AW_APP_API_KEY`), an Admin's: `GET /api/memberships` is granted from
   * Admin up, and the assertion carries no role.
   */
  readonly apiKey: string;
}

/** What the handlers of an app run on. */
export interface AppRuntime {
  /** The Agent Workspace origin (`AW_URL`), which says who a request's token belongs to. */
  readonly awUrl: string;
  /** The app's name key (`AW_APP_NAME`); its data lives in the schema `app_<name>`. */
  readonly appName: string;
  /**
   * The one workspace this deployment serves (`AW_WORKSPACE_ID`, lower-case): a person of any
   * other workspace is no person here.
   */
  readonly workspaceId: string;
  /** The `fetch` the platform is called with; the global one when not given. */
  readonly fetch?: typeof fetch;
  /** The agent tools' settings; `undefined` when any of their variables is missing or invalid. */
  readonly agentTools?: AgentToolsConfig;
  /**
   * The store of `resource`, the same one on every call. A `definePages` resource's is its page
   * store, so its generated routes and agent tools write revisions too.
   */
  storeOf<F extends FieldMap>(resource: DefinedResource<F>): ResourceStore<F>;
  /** The page store of a `definePages` resource: `storeOf`'s, with the tree and the revisions. */
  pageStoreOf<F extends FieldMap>(resource: DefinedPages<F>): PageStore<F>;
  /** The agent panel's sessions, one per record and agent (issue #1509). */
  readonly agentPanelSessions: AgentPanelSessionStore;
  /** The app's recipe runs and steps, which `recipeRoutes` reads (issue #1514). */
  readonly recipeStore: RecipeStore;
  /**
   * The `whsec_…` secret run-outcome webhooks to the app are signed with
   * (`AW_APP_WEBHOOK_SECRET`); `undefined` when unset, and `recipeRoutes`' webhook answers `503`.
   */
  readonly recipeWebhookSecret?: string;
  /** The durable events of the app's `channel()`s, which they store and read (issue #1518). */
  readonly channelLog: ChannelEventLog;
  /**
   * The process's one `LISTEN` connection, which wakes the app's channel streams: created on the
   * first call, from the runtime's own pool, and the same object on every call after.
   */
  channelListener(): ChannelListener;
}

function isAppName(name: string): boolean {
  try {
    appSchemaName(name);
    return true;
  } catch {
    return false;
  }
}

const AppEnvironmentSchema = z.strictObject({
  AW_URL: z.url({ protocol: /^https?$/u }),
  AW_APP_NAME: z.string().refine(isAppName),
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/u }),
  AW_WORKSPACE_ID: z.uuid(),
});

/**
 * The variables {@link appRuntime} needs. With {@link AGENT_TOOL_ENVIRONMENT_VARIABLES}, nothing
 * else of the environment is looked at.
 */
export const APP_ENVIRONMENT_VARIABLES = [
  'AW_URL',
  'AW_APP_NAME',
  'DATABASE_URL',
  'AW_WORKSPACE_ID',
] as const;

/** The variables the agent tools read: `AW_WORKSPACE_ID`, which every handler reads, and three more. */
export const AGENT_TOOL_ENVIRONMENT_VARIABLES = [
  'AW_APP_CONNECTOR_ID',
  'AW_WORKSPACE_ID',
  'AW_APP_IDENTITY_SECRET',
  'AW_APP_API_KEY',
] as const;

/** The most secrets `AW_APP_IDENTITY_SECRET` may list: the current one and older ones. */
const IDENTITY_SECRETS_MAX = 4;
const CONNECTOR_ID = /^[A-Za-z0-9_\-.:]{1,256}$/u;
const API_KEY = /^[A-Za-z0-9_\-.~]{1,512}$/u;

const AgentToolsEnvironmentSchema = z.strictObject({
  AW_APP_CONNECTOR_ID: z.string().regex(CONNECTOR_ID),
  AW_WORKSPACE_ID: z.uuid(),
  AW_APP_IDENTITY_SECRET: z
    .string()
    .transform((value) => value.split(',').map((secret) => secret.trim()))
    .pipe(z.array(z.string().min(1)).min(1).max(IDENTITY_SECRETS_MAX)),
  AW_APP_API_KEY: z.string().startsWith(API_KEY_PREFIX).regex(API_KEY),
});

/** The agent tools' settings in `environment`, or `undefined` when any is missing or invalid. */
export function agentToolsFromEnvironment(
  environment: NodeJS.ProcessEnv,
): AgentToolsConfig | undefined {
  const parsed = AgentToolsEnvironmentSchema.safeParse(
    Object.fromEntries(AGENT_TOOL_ENVIRONMENT_VARIABLES.map((name) => [name, environment[name]])),
  );
  if (!parsed.success) return undefined;
  return Object.freeze({
    connectorId: parsed.data.AW_APP_CONNECTOR_ID,
    workspaceId: parsed.data.AW_WORKSPACE_ID.toLowerCase(),
    identitySecrets: Object.freeze(parsed.data.AW_APP_IDENTITY_SECRET),
    apiKey: parsed.data.AW_APP_API_KEY,
  });
}

let current: AppRuntime | undefined;

/**
 * The page store lookup over a runtime's `storeOf`, which builds a page store for a `definePages`
 * resource.
 *
 * @throws {AppStoreError} `internal_error` when the store `storeOf` built is not a page store.
 */
export function pageStoresFrom(storeOf: AppRuntime['storeOf']): AppRuntime['pageStoreOf'] {
  return <F extends FieldMap>(resource: DefinedPages<F>): PageStore<F> => {
    const store = storeOf(resource) as unknown as ResourceStore;
    if (!isPageStore(store)) throw new AppStoreError('internal_error');
    return store as unknown as PageStore<F>;
  };
}

function fromEnvironment(environment: NodeJS.ProcessEnv): AppRuntime {
  const parsed = AppEnvironmentSchema.safeParse(
    Object.fromEntries(APP_ENVIRONMENT_VARIABLES.map((name) => [name, environment[name]])),
  );
  if (!parsed.success) throw new AppServerError('app_misconfigured');
  const {
    AW_URL: awUrl,
    AW_APP_NAME: appName,
    DATABASE_URL: url,
    AW_WORKSPACE_ID: workspaceId,
  } = parsed.data;
  const pool = new pg.Pool({ connectionString: url });
  // An idle client's failure (a restarted database) must not end the process; the next query
  // reconnects or fails into its own request's `internal_error`.
  pool.on('error', (error: Error) => {
    console.error(`[@indx-workspace/app] an idle database connection failed (${error.name})`);
  });
  const db = drizzle(pool);
  const agentTools = agentToolsFromEnvironment(environment);
  let listener: ChannelListener | undefined;
  const stores = appStoresOf({ db, appName, onCommitted: notifyRecipes });
  return {
    awUrl,
    appName,
    workspaceId: workspaceId.toLowerCase(),
    ...(agentTools === undefined ? {} : { agentTools }),
    // A write publishes on the channels bound to its resource, in its transaction (#1519); a
    // committed one starts the recipes on it, in the runner `serveRecipes` started (#1513).
    storeOf: stores,
    pageStoreOf: pageStoresFrom(stores),
    agentPanelSessions: agentPanelSessionsOf({ db, appName }),
    recipeStore: recipeStoreOf({ db, appName }),
    ...recipeWebhookSecretOf(environment),
    channelLog: channelEventLogOf({ db, appName }),
    channelListener: () => (listener ??= createChannelListener(pool)),
  };
}

/** The variable the run-outcome webhook secret is read from (issue #1514). */
const RECIPE_WEBHOOK_SECRET_VARIABLE = 'AW_APP_WEBHOOK_SECRET';

/** `{ recipeWebhookSecret }` when the variable is set to a `whsec_` secret, else nothing. */
function recipeWebhookSecretOf(environment: NodeJS.ProcessEnv): { recipeWebhookSecret?: string } {
  const secret = environment[RECIPE_WEBHOOK_SECRET_VARIABLE]?.trim();
  return secret === undefined || !WebhookSecretSchema.safeParse(secret).success
    ? {}
    : { recipeWebhookSecret: secret };
}

/**
 * The runtime of this process, built from `process.env` on the first call and the same object on
 * every call after.
 *
 * @throws {AppServerError} `app_misconfigured` when `AW_URL` (an `http(s)` origin), `AW_APP_NAME`
 *   (a lower-case kebab name key), `DATABASE_URL` (a `postgres://` URL) or `AW_WORKSPACE_ID` (a
 *   UUID) is missing or invalid.
 *   Nothing is memoised then, so a corrected environment is read on the next call.
 */
export function appRuntime(): AppRuntime {
  current ??= fromEnvironment(process.env);
  return current;
}

/**
 * Replaces the runtime {@link appRuntime} returns, or forgets it (`undefined`) so the next call
 * reads the environment again. Not exported from `./server`: `setAppRuntimeForTests` in
 * `./testing` is the public way in.
 */
export function replaceAppRuntime(runtime: AppRuntime | undefined): void {
  current = runtime;
}
