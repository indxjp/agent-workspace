/**
 * `@indx-workspace/app/testing`: the doubles a portal app's own tests use, never production code.
 *
 * - {@link memoryStoreOf}: the in-memory twin of `storeOf`, with the same `ResourceStore` port,
 *   validation, access checks and errors, plus a call counter and the audit rows written.
 * - {@link memoryPageStoreOf}: the in-memory twin of `pageStoreOf`, a `definePages` resource's
 *   tree, revisions and search, plus the audit rows and every revision kept.
 * - {@link memoryAgentPanelSessions}: the in-memory twin of `agentPanelSessionsOf`, the agent
 *   panel's one session per record and agent.
 * - {@link memoryChannelHub}: the in-memory twin of a `channel()`'s events and of the process's
 *   `LISTEN` connection (issue #1518), with the same publish, resume and reset semantics.
 * - {@link fakePerson}: a `Person` without a session or an identity assertion.
 * - {@link setAppRuntimeForTests}: the route handlers of `./server` on in-memory stores and a
 *   test's `fetch`, without a database or a platform.
 * - {@link recipeHarness}: a recipe run end to end (issue #1513) on {@link memoryRecipeStore} and a
 *   scripted platform that honours `Idempotency-Key`, with a crash and a restart in between.
 * - {@link testClock}: a clock a test moves by hand (`set`, `advance`), for `recipeRunner`,
 *   `serveRecipes` and `recipeHarness` (ADR-0164); with `fireSlot`, a test starts a schedule's
 *   slot at a chosen instant. Production refuses a clock.
 *
 * @packageDocumentation
 */
export { FAKE_WORKSPACE_ID, fakePerson, type FakePersonOptions } from './fake-person.js';
export {
  memoryAgentPanelSessions,
  type MemoryAgentPanelSessions,
} from './memory-agent-panel-sessions.js';
export {
  memoryChannelHub,
  type MemoryChannelHub,
  type MemoryChannelHubOptions,
} from './memory-channel.js';
export { memoryPageStoreOf, type MemoryPageStore } from './memory-page-store.js';
export { memoryRecipeStore, type MemoryRecipeStore } from './memory-recipe-store.js';
export {
  awaitingApproval,
  completed,
  failed,
  PROVIDER_TEXT,
  recipeHarness,
  type CrashPoint,
  type RecipeHarness,
  type RecipeHarnessOptions,
  type Script,
  type ScriptedOutcome,
} from './recipe-harness.js';
export {
  memoryStoreOf,
  type MemoryResourceStore,
  type MemoryStoreOptions,
  type StoreOperation,
} from './memory-store.js';
export { testClock, type TestClock } from './test-clock.js';
export {
  resetAppRuntimeForTests,
  setAppRuntimeForTests,
  type TestAppRuntime,
  type TestAppRuntimeOptions,
} from './runtime.js';
