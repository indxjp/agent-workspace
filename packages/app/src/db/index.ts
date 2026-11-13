/**
 * `@indx-workspace/app/db`: a portal app's own data, in the schema `app_<name>`, on Node (issue
 * #1502). A reference to a platform row is its id, never a foreign key.
 *
 * - {@link storeOf} is the `ResourceStore` every page, route and agent tool reads and writes a
 *   resource through: workspace-scoped, cursor-paged and access-checked per operation. Its
 *   in-memory twin is `memoryStoreOf` in `@indx-workspace/app/testing`.
 * - {@link tablesOf} and {@link appAuditTable} are the Drizzle tables, for an app's own queries.
 * - {@link createTableSql}, {@link createAuditTableSql} and {@link createAgentPanelSessionsSql}
 *   render the tables as deterministic SQL, which the generator writes as migrations;
 *   {@link migrateApp} applies them.
 * - {@link recipeTables} and {@link recipeStoreOf} are a recipe's progress (issue #1513), the
 *   `recipe_runs` and `recipe_steps` tables {@link createRecipeTablesSql} renders as the template's
 *   second migration; their in-memory twin is `memoryRecipeStore` in `@indx-workspace/app/testing`.
 *   A store's `onCommitted` hook is where the recipe runner hears of a committed write.
 * - {@link channelEventLogOf} is a `channel()`'s durable events (issue #1518), the
 *   `app_channel_events` table {@link createChannelEventsSql} renders as the template's third
 *   migration; its in-memory twin is `memoryChannelHub` in `@indx-workspace/app/testing`.
 * - {@link pageStoreOf} is the `PageStore` of a `definePages` resource (issue #1520): the tree, a
 *   revision per save in `<name>_revisions` ({@link pageRevisionsTable}), and search over the terms
 *   of {@link searchTerms}; `createTableSql` of the resource also creates its revisions table. Its
 *   in-memory twin is `memoryPageStoreOf` in `@indx-workspace/app/testing`.
 * - {@link agentPanelSessionsOf} keeps the agent panel's one platform session per record and agent
 *   (issue #1509); its in-memory twin is `memoryAgentPanelSessions` in `@indx-workspace/app/testing`.
 *
 * @packageDocumentation
 */
export {
  AGENT_PANEL_SESSIONS_TABLE,
  agentPanelSessionsOf,
  createAgentPanelSessionsSql,
  type AgentPanelKey,
  type AgentPanelSessionsOptions,
  type AgentPanelSessionStore,
} from './agent-panel-sessions.js';
export { AUDIT_TABLE, appAuditTable, createAuditTableSql } from './audit.js';
export {
  CHANNEL_EVENTS_TABLE,
  CHANNEL_NOTIFY,
  channelEventLogOf,
  createChannelEventsSql,
  type ChannelBounds,
  type ChannelEventLog,
  type ChannelEventLogOptions,
  type ChannelEventRecord,
  type ChannelScope,
  type EphemeralChannelEvent,
  type NewChannelEvent,
} from './channel-events.js';
export { createTableSql } from './create-table-sql.js';
export { APP_STORE_ERROR_STATUS, AppStoreError, type AppStoreErrorCode } from './errors.js';
export {
  APP_MIGRATIONS_TABLE,
  migrateApp,
  type AppMigrationOutcome,
  type MigrateAppOptions,
} from './migrate.js';
export {
  createPageRevisionsSql,
  pageRevisionsTable,
  pageRevisionsTableName,
} from './page-revisions.js';
export type {
  PageDeleteOptions,
  PageMove,
  PageRecord,
  PageRestoreOptions,
  PageRevision,
  PageStore,
} from './page-port.js';
export { pageStoreOf } from './page-store.js';
export { searchQuery, searchTerms } from './search-terms.js';
export type {
  AfterWrite,
  AuditAction,
  AuditEvent,
  CommittedEvent,
  ListOptions,
  OnCommitted,
  Page,
  ResourceStore,
  SearchOptions,
  StoreClock,
  StoreHooks,
  WriteChange,
} from './port.js';
export {
  PUBLIC_CODE_PATTERN,
  RECIPE_RUN_STATUSES,
  RECIPE_STEP_STATUSES,
  type ApprovalDecision,
  type NewRecipeRun,
  type RecipeRunRecord,
  type RecipeRunStatus,
  type RecipeStepRecord,
  type RecipeStepStatus,
  type RecipeStore,
} from './recipe-port.js';
export { recipeStoreOf, type RecipeStoreOptions } from './recipe-store.js';
export {
  createRecipeTablesSql,
  RECIPE_RUNS_TABLE,
  RECIPE_STEPS_TABLE,
  recipeTables,
} from './recipe-tables.js';
export { appSchemaName } from './schema-name.js';
export { storeOf, type AppDatabase, type AppSqlRunner, type StoreOptions } from './store.js';
export { tablesOf } from './tables.js';
