/**
 * `@indx-workspace/app/server`: the server half of a portal app, run in Next.js route handlers on
 * Web-standard `Request` and `Response` (issue #1503).
 *
 * - {@link resourceRoutes} and {@link resourceItemRoutes}: the generated routes of a resource
 *   (with `{ publish }`, bound to a channel, issue #1519),
 *   `GET`/`POST /api/<plural>` and `GET`/`PATCH`/`DELETE /api/<plural>/:id`, each run as the
 *   person asking, so the resource's access rules decide.
 * - {@link currentPerson}: who a request is from, asked of Agent Workspace with the person's own
 *   token; {@link personAuthOf} is that token as the SDK's auth, so a page or a route calls Agent
 *   Workspace as the person (the portal template's pages, issue #1510).
 * - {@link appRuntime}: the store of each resource and the platform origin, built once from
 *   `AW_URL`, `AW_APP_NAME`, `DATABASE_URL` and `AW_WORKSPACE_ID`; `setAppRuntimeForTests` in `./testing` replaces it.
 * - {@link problem}: the one error envelope (ADR-0075), `{ error: { code, message, details? } }`.
 *
 * - {@link mcpEndpoint}: the app's one MCP endpoint (issue #1504), its generated agent tools behind
 *   the platform's identity assertion (ADR-0142), each call run as the person who asked, through
 *   an agent, within their access and `agents.write`; {@link appRuntime} reads its settings from
 *   `AW_APP_CONNECTOR_ID`, `AW_WORKSPACE_ID`, `AW_APP_IDENTITY_SECRET` and `AW_APP_API_KEY`.
 *
 * - {@link agentPanelRoutes}: the agent panel's routes (issue #1509), one catch-all
 *   `app/api/agent-panel/[...path]/route.ts`, starting and following a run about one record as
 *   the person, and deciding the approval it waits on.
 *
 * - {@link recipeRunner}: executes the app's recipes (issue #1513), one idempotent platform run per
 *   step, suspended on an approval and resumed by `decide`; {@link serveRecipes} starts it from
 *   the environment in the template's `instrumentation.ts`. A recipe's `store` writes the app's
 *   records as the person's agent in its step's run (ADR-0164); {@link cachedMemberDirectory} is
 *   the role lookup it and the MCP endpoint share. `fireSlot` starts one slot of a schedule, and
 *   a test may give the runner a clock; production refuses both (ADR-0164 T1–T3).
 *
 * - {@link recipeRoutes}: the recipe routes (issue #1514), the workspace's recipe runs and their
 *   steps for `RecipeGraph` and `RecipeRunList`, a decision on a paused step as the person, and
 *   the signed run-outcome webhook (`AW_APP_WEBHOOK_SECRET`) that wakes a waiting step, and the
 *   development-only slot trigger `POST /api/recipes/slots` (`404` in production).
 *
 * - {@link channel}: an app's realtime channel (issue #1518) over PostgreSQL `LISTEN/NOTIFY`, with
 *   `publish` in the write's transaction, `publishEphemeral` for presence, and `routes()`, the
 *   `GET /api/channels/<name>/events?key=` stream that resumes from `Last-Event-ID`.
 *
 * - {@link pageRoutes}: a `definePages` resource's revisions, restore and move routes (issue
 *   #1520), beside its `resourceRoutes`; its agent tools add `<name>_children` and `<name>_create`.
 *
 * - {@link dashboardRoutes}: J5's dashboard (issue #1522), `GET /api/dashboard`, the runs running
 *   now, waiting for a decision and failed in the last 24 hours, and today's spend, read from Agent
 *   Workspace's run list as the person.
 *
 * - {@link signInRoutes}: the portal's sign-in (issue #1510), an OpenID Connect code flow at
 *   `AW_OIDC_ISSUER_URL` and ADR-0161's token exchange, keeping the person's `awo_live_` token in
 *   the cookie {@link currentPerson} reads; {@link signInHref} is the page a signed-out request is
 *   sent to.
 *
 * @packageDocumentation
 */
export {
  agentPanelRoutes,
  type AgentPanelHandler,
  type AgentPanelOptions,
  type AgentPanelRouteContext,
  type AgentPanelRoutes,
} from './agent-panel.js';
export {
  channel,
  type Channel,
  type ChannelDelivery,
  type ChannelHandler,
  type ChannelOptions,
  type ChannelPublish,
  type ChannelSubscribeOptions,
} from './channel.js';
export type { ChannelListener, ChannelSubscriber } from './channel-listener.js';
export {
  DASHBOARD_CACHE_MS,
  DASHBOARD_SPEND_REFRESH_MS,
  dashboardRoutes,
  loadDashboard,
  type DashboardRoutes,
  type DashboardRoutesOptions,
  type DashboardRunsClient,
} from './dashboard.js';
export {
  AGENT_TOOL_FAILURE_MESSAGE,
  mcpEndpoint,
  type McpEndpoint,
  type McpHandler,
} from './mcp.js';
export { pageRoutes, type PageRoutes } from './page-routes.js';
export { currentPerson, PERSON_TOKEN_COOKIE, personAuthOf } from './person.js';
export {
  APP_SERVER_ERROR_STATUS,
  AppServerError,
  fromStoreError,
  problem,
  type AppServerErrorCode,
} from './problem.js';
export {
  cachedMemberDirectory,
  type MemberDirectory,
  type MemberDirectoryOptions,
  type MemberRole,
} from './mcp-person.js';
export { RECIPE_ERROR_CODES, RecipeError, type RecipeErrorCode } from './recipe-errors.js';
export {
  consoleRunUrl,
  recipeRoutes,
  type RecipeRoutes,
  type RecipeRoutesOptions,
  type RecipeRunRouteContext,
  type RecipeStepRouteContext,
} from './recipe-routes.js';
export {
  recipeRunner,
  type PersonRunsClient,
  type RecipeApp,
  type RecipeClock,
  type RecipeDecision,
  type RecipeRunner,
  type RecipeRunnerOptions,
  type RecipeStartOptions,
} from './recipe-runner.js';
export {
  RECIPE_ENVIRONMENT_VARIABLES,
  serveRecipes,
  servedRecipeRunner,
  type ServeRecipesOptions,
} from './recipe-runner-runtime.js';
export {
  SIGN_IN_CALLBACK_PATH,
  SIGN_IN_ENVIRONMENT_VARIABLES,
  SIGN_IN_PATH,
  SIGN_IN_PROBLEM_STATUS,
  signInHref,
  signInRoutes,
  type SignInHandler,
  type SignInRoutes,
  type SignInRoutesOptions,
} from './sign-in.js';
export {
  MAX_BODY_BYTES,
  resourceItemRoutes,
  resourceRoutes,
  type CollectionHandler,
  type ItemHandler,
  type ItemRouteContext,
  type ResourceItemRoutes,
  type ResourceRouteOptions,
  type ResourceRoutes,
} from './routes.js';
export {
  AGENT_TOOL_ENVIRONMENT_VARIABLES,
  APP_ENVIRONMENT_VARIABLES,
  appRuntime,
  type AgentToolsConfig,
  type AppRuntime,
} from './runtime.js';
