/**
 * `setAppRuntimeForTests`: runs an app's route handlers without a database or a platform (issue
 * #1503). Every resource gets an in-memory store (a `definePages` one its in-memory page store), and `currentPerson` calls the `fetch` the test
 * gives, such as a `fetchDouble` from `@indx-workspace/sdk/testing` answering `GET /api/me` (and,
 * for `mcpEndpoint`, `GET /api/memberships`).
 */
import { isPageResource, type DefinedPages } from '../pages/define-pages.js';
import type { DefinedResource, FieldMap } from '../resource.js';
import { FAKE_WORKSPACE_ID } from './fake-person.js';
import { publishBoundWrite } from '../server/channel-bindings.js';
import { memoryChannelHub, type MemoryChannelHub } from './memory-channel.js';
import { storesBuiltBy } from '../server/app-stores.js';
import {
  pageStoresFrom,
  replaceAppRuntime,
  type AgentToolsConfig,
  type AppRuntime,
} from '../server/runtime.js';
import {
  memoryAgentPanelSessions,
  type MemoryAgentPanelSessions,
} from './memory-agent-panel-sessions.js';
import { memoryPageStoreOf, type MemoryPageStore } from './memory-page-store.js';
import { memoryRecipeStore, type MemoryRecipeStore } from './memory-recipe-store.js';
import {
  memoryStoreOf,
  type MemoryResourceStore,
  type MemoryStoreOptions,
} from './memory-store.js';

/** What {@link setAppRuntimeForTests} may be told; everything has a default. */
export interface TestAppRuntimeOptions extends Pick<MemoryStoreOptions, 'now'> {
  /** The `fetch` `currentPerson` calls the platform with; one that fails every call by default. */
  readonly fetch?: typeof fetch;
  /** `https://aw.test` when not given. */
  readonly awUrl?: string;
  /** `app` when not given. */
  readonly appName?: string;
  /** The workspace the app serves; `FAKE_WORKSPACE_ID` when not given. */
  readonly workspaceId?: string;
  /** What `mcpEndpoint` checks an identity assertion against; none (`500`) when not given. */
  readonly agentTools?: AgentToolsConfig;
  /** The secret `recipeRoutes`' webhook verifies with; none (`503`) when not given. */
  readonly recipeWebhookSecret?: string;
}

/** The runtime a test installed, whose stores are the in-memory ones the handlers use. */
export interface TestAppRuntime extends AppRuntime {
  storeOf<F extends FieldMap>(resource: DefinedResource<F>): MemoryResourceStore<F>;
  pageStoreOf<F extends FieldMap>(resource: DefinedPages<F>): MemoryPageStore<F>;
  readonly agentPanelSessions: MemoryAgentPanelSessions;
  readonly recipeStore: MemoryRecipeStore;
  /** The channels' events and listener, in memory (issue #1518). */
  readonly channelLog: MemoryChannelHub;
}

const refuseEveryCall: typeof fetch = () =>
  Promise.reject(new TypeError('setAppRuntimeForTests was given no fetch'));

/**
 * Installs a runtime of in-memory stores, agent panel sessions, recipe runs and channel events
 * for every handler of this process (test file) and returns it. A resource's store is the same on every `storeOf` call, so a
 * test can seed records and read them back. Call {@link resetAppRuntimeForTests} after the test.
 */
export function setAppRuntimeForTests(options: TestAppRuntimeOptions = {}): TestAppRuntime {
  const appName = options.appName ?? 'app';
  const storeOptions = { appName, ...(options.now === undefined ? {} : { now: options.now }) };
  const channels = memoryChannelHub(storeOptions);
  // A write of a resource bound to a channel (`resourceRoutes(r, { publish })`) publishes on it.
  const stores = storesBuiltBy((resource) =>
    isPageResource(resource)
      ? memoryPageStoreOf(resource, storeOptions)
      : memoryStoreOf(resource, { ...storeOptions, afterWrite: publishBoundWrite }),
  );
  const runtime: TestAppRuntime = {
    awUrl: options.awUrl ?? 'https://aw.test',
    appName,
    workspaceId: (options.workspaceId ?? FAKE_WORKSPACE_ID).toLowerCase(),
    fetch: options.fetch ?? refuseEveryCall,
    ...(options.agentTools === undefined ? {} : { agentTools: options.agentTools }),
    storeOf: stores as TestAppRuntime['storeOf'],
    pageStoreOf: pageStoresFrom(stores) as TestAppRuntime['pageStoreOf'],
    agentPanelSessions: memoryAgentPanelSessions(),
    recipeStore: memoryRecipeStore(),
    channelLog: channels,
    channelListener: () => channels,
    ...(options.recipeWebhookSecret === undefined
      ? {}
      : { recipeWebhookSecret: options.recipeWebhookSecret }),
  };
  replaceAppRuntime(runtime);
  return runtime;
}

/** Forgets the installed runtime, so `appRuntime()` reads the environment again. */
export function resetAppRuntimeForTests(): void {
  replaceAppRuntime(undefined);
}
