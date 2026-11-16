/**
 * `@indx-workspace/app/react`: the pages of a portal app, in the browser, reaching the app's
 * routes and Agent Workspace through the published SDK. Every part is accessible and speaks `ja`
 * and `en`.
 *
 * - {@link ResourceList}, {@link ResourceBoard}, {@link ResourceForm} and {@link ResourceDetail}
 *   are a resource's four pages, each driven by a `defineResource` result alone (issue #1508).
 * - {@link ResourceDetailLoader} is the detail page of a record by its id: it loads the record
 *   through the resource's client, then draws {@link ResourceDetail} (issue #1507);
 *   {@link ResourceFormLoader} is its edit page, drawing {@link ResourceForm} on the record.
 * - Every part speaks the language of the {@link AppTheme} around it unless given a `locale`.
 * - {@link resourceClient} reaches a resource's generated routes; a failure is one typed
 *   {@link ResourceProblemError}.
 * - {@link AppTheme} is the `.aw-app` root, themed by the hosted surface's own
 *   `surfaceThemeStyle`; import `@indx-workspace/app/react/styles.css` once.
 * - {@link AgentPanel} is an agent working on one record, for `ResourceDetail`'s `aside` slot
 *   (issue #1509): it reaches the app's `agentPanelRoutes` through {@link agentPanelClient}.
 * - {@link RecipeGraph} is one recipe run's steps, live until the run stops, with Approve and
 *   Reject on a step that waits; {@link RecipeRunList} is the page of the workspace's recipe runs
 *   (issue #1514). Both reach `recipeRoutes` through {@link recipeClient}.
 * - {@link useChannel} is the live events of one key of an app's `channel()` (issue #1518): it
 *   follows the channel's stream with {@link followChannel}, resuming with `Last-Event-ID`.
 * - {@link ChannelView} is one key of a resource bound to a channel (issue #1519): its live
 *   messages, a thread pane, a composer with `@` mentions and attachments, and who is here.
 * - {@link PageTree}, {@link RichText} and {@link PageView} are the wiki's parts over a
 *   `definePages` resource (issue #1521): the tree of pages, the block editor, and one page with
 *   Save, its revisions and Restore, and the agent actions "Rewrite with <agent>" and "Summarize
 *   into new page", whose change lands as a new revision. They reach the page routes through
 *   {@link pageClient}.
 * - {@link Dashboard} is J5's one page of four lists: running now, waiting for a decision, failed
 *   in the last 24 hours and spend today, each row a link to its run in the console (issue #1522).
 *   It reaches the app's `dashboardRoutes` through {@link dashboardClient}.
 */
export {
  AgentPanel,
  type AgentPanelAgent,
  type AgentPanelApprovalProps,
  type AgentPanelCompletion,
  type AgentPanelProps,
} from './agent-panel.js';
export type { AgentPanelRun, AgentPanelStartResponse } from '../agent-panel-wire.js';
export {
  agentPanelClient,
  type AgentPanelClient,
  type AgentPanelClientOptions,
  type FollowOptions,
} from './agent-panel-client.js';
export {
  channelReducer,
  followChannel,
  type ChannelAction,
  type ChannelEphemeral,
  type ChannelEvent,
  type ChannelFollowEnd,
  type ChannelFollowOptions,
  type ChannelState,
  type ChannelStatus,
} from './channel-follow.js';
export {
  ChannelComposer,
  ChannelMessage,
  ChannelMessageList,
  ChannelView,
  MentionSuggestions,
  PresenceRow,
  type ChannelAttachment,
  type ChannelViewProps,
} from './channel-view.js';
export {
  bodyTextOf,
  channelFieldsOf,
  mentionsOf,
  mergeChannelEvents,
  presentPrincipals,
  recordPresence,
  threadsOf,
  type ChannelFields,
  type ChannelMember,
  type ChannelRecord,
  type ChannelThread,
  type ChannelViewEvent,
  type PresenceState,
} from './channel-view-model.js';
export {
  dashboardClient,
  type DashboardClient,
  type DashboardClientOptions,
} from './dashboard-client.js';
export { Dashboard, type DashboardProps } from './dashboard.js';
export type {
  DashboardSnapshot,
  DashboardSpend,
  DashboardTruncated,
  RunSummary,
} from '../dashboard-wire.js';
export {
  resourceClient,
  ResourceProblemError,
  type ResourceClient,
  type ResourceClientCode,
  type ResourceClientOptions,
  type ResourceListQuery,
  type ResourcePage,
} from './client.js';
export {
  appStrings,
  problemMessage,
  type AgentPanelStrings,
  type AppLocale,
  type AppStrings,
  type ChannelStrings,
  type DashboardStrings,
  type PageStrings,
  type RecipeStrings,
} from './locale.js';
export {
  rewritePrompt,
  summarizePrompt,
  type PromptOptions,
  type PromptPage,
} from './page-actions.js';
export type { PageMove, PageRecord, PageRevision } from '../db/page-port.js';
export {
  pageClient,
  type PageClient,
  type PageCreateInput,
  type PageReadOptions,
  type PageRevisionsQuery,
  type PageUpdate,
} from './page-client.js';
export { PageTree, type PageTreeProps } from './page-tree.js';
export { PageView, type PageViewProps } from './page-view.js';
export type {
  RecipeRunDetail,
  RecipeRunPage,
  RecipeRunView,
  RecipeStepCost,
  RecipeStepView,
} from '../recipe-wire.js';
export {
  recipeClient,
  type RecipeClient,
  type RecipeClientOptions,
  type RecipeRunQuery,
} from './recipe-client.js';
export {
  RecipeGraph,
  RecipeRunList,
  type RecipeGraphProps,
  type RecipeRunListProps,
} from './recipe-graph.js';
export { ResourceBoard, type ResourceBoardProps } from './resource-board.js';
export type { ResourceDisplayProps } from './resource-cell.js';
export { ResourceDetail, type ResourceDetailProps } from './resource-detail.js';
export {
  ResourceDetailLoader,
  ResourceFormLoader,
  type ResourceDetailLoaderProps,
  type ResourceFormLoaderProps,
} from './resource-detail-loader.js';
export { ResourceForm, type ResourceFormProps } from './resource-form.js';
export { ResourceList, type ResourceListProps } from './resource-list.js';
export { RichText, type RichTextProps } from './rich-text.js';
export type { FieldLabels, ValueLabels } from './resource-view-model.js';
export { AppTheme, type AppThemeProps } from './theme.js';
export { channelEventsUrl, useChannel, type UseChannelOptions } from './use-channel.js';
export type { ResourcePagesSource } from './use-resource-pages.js';
