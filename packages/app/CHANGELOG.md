# Changelog — `@indx-workspace/app`

## 0.6.13 — unreleased

### Added

- The agent panel bound to a record. `agentPanelRoutes({ resources, agents })` from
  `@indx-workspace/app/server` serves `app/api/agent-panel/[...path]/route.ts`: it starts a run
  about the record as the signed-in person (after the resource's own read check), streams the run's
  events with `Last-Event-ID` resumption, reads the run with the call it waits on, and approves or
  rejects that call. `409 session_busy` is passed on as "the agent is still working"; every other
  refusal of Agent Workspace's is passed on by its code and status only.
- `AgentPanel` from `@indx-workspace/app/react` draws it, for `ResourceDetail`'s `aside` slot: an
  agent picker, the conversation, the tool steps and the run's status in `ja` and `en`, and a
  `renderApproval` slot for the approval prompt (a notice to decide in Agent Workspace when none is
  given). `agentPanelClient` is its transport, reconnecting a dropped stream up to five times.
- `agent_panel_sessions` keeps the platform sessions of each record, agent and person in the app's
  own schema (`createAgentPanelSessionsSql`, `agentPanelSessionsOf`, and `memoryAgentPanelSessions`
  in `./testing`); the app template's first migration creates it. Each person continues only their
  own conversation, and a session is never overwritten, so a run of an older one stays the
  record's.
- The `aw-app` bin: `aw-app sql --app <name> <resource-spec-json>` prints the migration SQL
  (`createTableSql`) of one resource that `aw generate resource` parsed, built with the same field
  builders the generated resource file uses. A refused spec or app name goes to stderr with exit
  code 1, a misused command line with 2. `aw` spawns it from the project's own install and never
  imports the app kit.
- The audit table refuses an agent row without a run id (`app_audit_events_agent_run_check`), so
  every agent write carries the run it was made in at the database too. The app template's first
  migration now matches `createAuditTableSql` exactly, which a parity test holds.
- `aw-app migrate --app <name> --dir <migrations-folder>` applies the app's migrations to its schema
  `app_<name>` with `migrateApp`, reading the connection string from `DATABASE_URL` only (never
  the command line). A refused app name, a missing `DATABASE_URL` or a failed migration goes to
  stderr with exit code 1, a misused command line with 2. `aw dev` runs it before it starts the
  app.
- `migrateApp` runs `CREATE SCHEMA` only when the app's schema is missing, so the schema's owner
  needs no `CREATE` privilege on the database. It applies the journal itself, in Drizzle's ledger
  layout, instead of calling Drizzle's `migrate()`, which always runs `CREATE SCHEMA IF NOT EXISTS`.
- `defineResource` and `defineApp`, with `isDefinedResource` and `isDefinedApp`: a portal app's
  resources and the app itself, validated when the file loads. A refused definition throws the
  SDK's `DefinitionError` listing every reason at once; an accepted one is frozen and branded.
- The field builders `text`, `richText`, `number`, `money`, `bool`, `date`, `dateTime`, `enumOf`,
  `person`, `ref`, `files` and `tags`. Each carries its column, value schema, form control, list
  cell and agent-tool schema as plain data. This `files()` is a record attachment field, not
  `@indx-workspace/sdk/define`'s agent file grant.
- `createInputSchema`, `updateInputSchema` and `recordSchema`: the Zod schemas of a resource's
  create body, update body and record, built from its fields.
- `ResourceFormLoader` (#1531): a resource's edit page by record id. It loads the record through
  the resource's client, then draws `ResourceForm` on it, as `ResourceDetailLoader` does for the
  detail.
- Every part speaks the language of the `AppTheme` around it when it is given no `locale` of its
  own (#1531), so a portal names its language once, in `app/theme.ts`. A part's own `locale` still
  wins, and a part outside any `AppTheme` stays `en`. `AppTheme` is now a client component.
- `ChannelView({ channel, resource, keyValue, threadField? })` in `./react` (F-11, issue #1519):
  the channel screen of a team chat, one key of a resource bound to a `channel()`. Its message list
  is live from the channel's stream with `aria-live="polite"` (an update replaces a message, a
  delete removes it, an event delivered twice is applied once); a thread pane opens on the
  resource's `ref()` to itself; the composer creates through `resourceClient`, with `@` mentions
  picked from `members` by named buttons and, given `uploadFile`, `files()` attachments; a
  presence row names who is here. Bodies render as Markdown without raw HTML. In `ja` and `en`.
  Its pure rules are exported too: `mergeChannelEvents`, `threadsOf`, `recordPresence`,
  `presentPrincipals`, `mentionsOf`, `channelFieldsOf`, `bodyTextOf`.
- `resourceRoutes(resource, { publish })` and `resourceItemRoutes(resource, { publish })` bind the
  resource to a channel: every write of it, through these routes or an agent tool
  (`mcpEndpoint`), publishes `{ type: 'created' | 'updated' | 'deleted', data: <record> }` on the
  key its `keyField` names, in the write's transaction. A `definePages` resource cannot be bound.
- `storeOf` and `memoryStoreOf` take an `afterWrite(tx, change)` hook, called inside the write's
  transaction after its audit row; unlike `onCommitted`, a hook that throws rolls the write back.
  The conformance suite holds both stores to it. `AfterWrite` and `WriteChange` are exported from
  `./db`.
- A channel's open stream announces its person on the key every 15 seconds with an ephemeral
  `presence` event (`{ principalId }`), first as it opens; `ChannelView` forgets a person 45
  seconds after their last one. The browser sends nothing for it, so there is no new route.
- Realtime channels (F-11): `channel(name, { resource, key?, retain? })` from
  `@indx-workspace/app/server`, over PostgreSQL `LISTEN/NOTIFY` and one SSE endpoint per channel.
  `publish(tx, { key, type, data })` stores an event in `app_channel_events` and notifies it in the
  same statement, so a rolled-back write is never delivered; `publishEphemeral` only notifies;
  `routes()` is `{ GET }` for `GET /api/channels/<name>/events?key=`, checked against the bound
  resource's `read` access (a refusal is `404` before the stream). The stream resumes from
  `Last-Event-ID` or `?after=`; a stale or future cursor gets `stream-reset`, a malformed one
  `400 invalid_cursor`. One `LISTEN` connection per process reconnects with backoff, and a 1000 ms
  poll covers a missed notification.
- `useChannel(name, key)` and `followChannel` in `./react`: reconnect with `Last-Event-ID`, five
  reconnects in a row without progress, exponential backoff on `retry:` capped at 30 s,
  `Retry-After` honoured, events cleared on `stream-reset`.
- `app_channel_events` (`channelEventLogOf`, `createChannelEventsSql` in `./db`) is created by the
  app template's new third migration `0002_app_kit_channels`; a generated resource's migration is
  now `0003_…` in a new app. `memoryChannelHub` in `./testing` is its in-memory twin.
- The agent panel's stream and the channel streams share one SSE writer.
- `dashboardRoutes()` from `@indx-workspace/app/server`: `GET /api/dashboard`, J5's four lists read
  from Agent Workspace's run list with the signed-in person's own token, so a person never sees a
  run they could not open in the console. `running` is the `queued` and `running` runs,
  `waiting` the `awaiting_approval` runs with the tool each waits on, `failed` the failures created
  in the last 24 hours, and `spendToday` today's cost by currency (from midnight in the route's
  `timeZone`, UTC by default), summed exactly on decimal strings with the runs whose accounting has
  not settled counted as `unsettled`. Each run carries only its id, agent, status, times, error,
  pending call, cost and lead run (`parentRunId`), never its prompt or output. A list that stops at
  a page says so in `truncated`. Each person's answer is kept for 900 ms and the spend walk for
  10 s; a refusal of Agent Workspace's comes back by its code and status. `loadDashboard` is the
  same read without the route.
- `Dashboard({ platformUrl })` from `@indx-workspace/app/react`: the four lists as `<section>`s,
  each with an `h2`, a table and an empty line, every row a link named "Open run <id>" to
  `${platformUrl}/runs?run=<id>`. It polls every second while the page is visible, never two
  requests at once, and pauses while it is hidden. The spend list says that no spend ceiling is
  configured. It speaks `ja` and `en`, and adds no charts dependency. `dashboardClient()` is its way
  to the route.
- `PageTree`, `RichText` and `PageView` (`./react`): the wiki's parts over a `definePages`
  resource. `PageTree` is a WAI-ARIA tree whose levels load as they open, with the APG keyboard
  map, "New page", and a "Move to…" dialog that offers only the places a page may go (no drag and
  drop). `RichText` is a block editor without an editor dependency: a row per block with a type
  select and a labelled `<textarea>`; Enter at the end splits, Backspace at the start merges,
  Alt+Up / Alt+Down reorders, and `readOnly` draws the body through `AssistantProse`. `PageView`
  saves with `expectedRevisionId`, offers "Load latest" or "Keep mine" on `409 page_conflict` and
  never merges, and has a revisions drawer with an agent badge and run link on an agent's
  revision, a preview, and Restore.
- "Rewrite with <agent>" and "Summarize into new page": `PageView` opens the `AgentPanel` with a
  prompt from `rewritePrompt` / `summarizePrompt` naming the page, the tool and
  `expectedRevisionId`; the agent's change lands as a new revision with its run, and the view
  loads it when the run completes.
- `AgentPanel` takes `initialPrompt` and `initialAgent`, and its `onCompleted` is told the run and
  its agent; both are backwards compatible.
- `pageClient(resource)`: the page routes from the browser (`get`, `children`, `create`,
  `update`, `move`, `revisions`, `restore`), each answer parsed and each failure one
  `ResourceProblemError`. `pageRoutes(resource).children` (`./server`) serves
  `GET /api/<plural>/children?parent=<id>` (the top without `parent`) for the tree.
- `definePages({ name?, space?, access, agents })`: the page resource kind, a preset over
  `defineResource` with the fields `title`, `parent`, `position`, `blocks` (and `space`), search
  over the title and the blocks' text, and a `<name>_revisions` table that `createTableSql`
  creates with the pages. The block model (`PAGE_BLOCK_TYPES`) and its one markdown conversion,
  `blocksToMarkdown`, `markdownToBlocks` and `blocksPlainText`, replace the agent tools' earlier
  paragraphs-and-headings conversion.
- `pageStoreOf` (`./db`) and `memoryPageStoreOf` (`./testing`): the tree (`children`, `move`
  refusing `page_cycle` and `page_space_mismatch`, a delete refused `page_has_children` unless
  `cascade`), one revision per save of the title or body with its author and the agent's run,
  `revisions` newest first, `restore`, and `expectedRevisionId` refused `409 page_conflict` when
  stale. Revisions outlive their page. Search splits Japanese into character pairs
  (`searchTerms`, `searchQuery`), so it needs no database extension.
- `pageRoutes(resource)` (`./server`): `GET /api/<plural>/:id/revisions`, `POST …/restore` and
  `POST …/move`. A page resource's agent tools add `<name>_children` and
  `<name>_create(parent, title, markdown)`, the only create tool, and its `<name>_update` takes
  `markdown` and `expectedRevisionId`.
- The package: `@indx-workspace/app`, the app kit portal apps import, with the subpaths `.`,
  `./server`, `./db`, `./react` and `./testing`. Each is empty in this release; later releases
  fill them. Released in lock-step with `@indx-workspace/contracts`, `@indx-workspace/sdk` and
  `@indx-workspace/react`, with the same version.
- `personAuthOf(request)` from `@indx-workspace/app/server`: the signed-in person's token in the
  request as the SDK's auth (`access-token` or `user-token`), so a page or route calls Agent
  Workspace as that person, as the portal template's pages do.
- Every server handler reads `AW_WORKSPACE_ID`, the one workspace the deployment serves, and
  `currentPerson` answers no person (`401 unauthenticated`) for a member of any other workspace, so
  the app's tables never hold rows of a tenant it was not installed for.
- `recipeRoutes(app)` from `@indx-workspace/app/server`: the recipe routes of four one-line route
  files. `GET /api/recipes/runs?recipe=&status=&cursor=` pages the workspace's recipe runs (ADR-0079
  shape), `GET /api/recipes/runs/:id` answers a run with its steps (each step's console run link,
  cost and pending call read from Agent Workspace as the person), and
  `POST /api/recipes/runs/:id/steps/:key/decision` approves or rejects a waiting step with the
  person's own token, so the platform's refusal (`403`, `approval_already_decided`,
  `approval_expired`, `run_not_awaiting_approval`) comes back by its code. Another workspace's run
  is `404 recipe_run_not_found`, and a step that does not wait is `409` with the code
  `recipe_step_not_awaiting_approval`.
- `POST /api/recipes/webhook` verifies a run-outcome webhook (N-3) with `AW_APP_WEBHOOK_SECRET`,
  refuses an unsigned, forged or stale delivery with `401 webhook_unverified`, and wakes the steps
  waiting on the run; polling with `follow` stays the fallback.
- `RecipeGraph` and `RecipeRunList` from `@indx-workspace/app/react`: a run's steps as a vertical
  list with connectors (key, status, duration, cost, run link; Approve and Reject on a waiting
  step), polled every 2 s until the run stops and announced in a polite live region, in `ja` and
  `en`; and the page of recipe runs. `recipeClient()` is their way to the routes.
- `aw-app recipe-on '<cron>' [--tz <iana>]` checks a recipe's schedule as `defineRecipe` does, for
  `aw generate recipe`.
- `RecipeStore.listRuns` takes `recipe` and `status` filters; a cursor is bound to them.
- Recipes (F-2): `defineRecipe({ name, on, input?, run })` with `resourceEvent(resource, event)` and
  `schedule(cron, timezone)` from `@indx-workspace/app`, listed in `defineApp({ recipes })`. A
  recipe is TypeScript the app runs over the SDK; each `step(key, fn)` starts at most one platform
  run with the `Idempotency-Key` `recipe:<recipeRunId>:<stepKey>`, so a recipe executed again after
  a crash never starts a second run for a step.
- `recipeRunner(app, { client, store, workspaceId })` from `@indx-workspace/app/server` executes
  them under a per-recipe-run lease: it memoizes completed steps, records a step's run before it
  waits, suspends on `awaiting_approval` and resumes after `decide()` (the person's own client),
  fails a step with its run's public code only, and dedupes resource events and schedule slots, so
  two replicas firing one slot start one recipe run. `onRunOutcome` takes a verified run-outcome
  webhook and wakes the step waiting on it. `serveRecipes(app)` starts it in the template's
  `instrumentation.ts`; a resource store's new `onCommitted` hook is how it hears of a write.
- `recipe_runs` and `recipe_steps` live in the app's own schema (`recipeTables`, `recipeStoreOf`,
  `createRecipeTablesSql` in `./db`), created by the app template's new second migration
  `0001_app_kit_recipes`; a generated resource's migration is now `0002_…` in a new app.
- `recipeHarness(recipe, { agents })` in `./testing` runs a recipe on `memoryRecipeStore` and a
  scripted platform that honours `Idempotency-Key`, with `crashAfter(stepKey)` and `restart()`.
- `@indx-workspace/app/react`: `ResourceDetailLoader`, the detail page of a record by its id. It
  loads the record through the resource's client and draws `ResourceDetail`; until then it
  announces the loading record, and when the record cannot be had it says why in `ja` or `en` with
  a button to try again.
- `@indx-workspace/app/react`: `ResourceList`, `ResourceBoard`, `ResourceForm` and
  `ResourceDetail`, a resource's four pages, each driven by its `defineResource` result alone. The
  list is a table with one column per field, filters from its `enumOf()`, `person()` and `date()`
  fields and cursor paging; the board has one column per value of an `enumOf()` field, each card a
  link to the detail; the form has one labelled control per field, checks the draft with the
  resource's create or update schema, and puts a server problem on the fields its `details` name
  or in an alert with a way to try again; the detail shows every field, `ref()` links, `files()`
  as read-only attachment chips, and a history and an `aside` slot. Every string is in `ja` and
  `en` (`appStrings`).
- `resourceClient(resource, { baseUrl, fetch })` with `list`, `get`, `create` and `update` against
  the resource's routes, parsing every answer with the record schema; a failure is one typed
  `ResourceProblemError { code, status, fieldErrors, formErrors }`.
- `AppTheme`, the `.aw-app` root themed by `surfaceThemeStyle` from `@indx-workspace/react/theme`,
  and `@indx-workspace/app/react/styles.css`, which reuses the surface's custom properties.
- The package now depends on `@indx-workspace/react` and takes `react` (`^18.3.0 || ^19`) as a
  peer.
- `resourceRoutes(resource)` and `resourceItemRoutes(resource)` from `@indx-workspace/app/server`:
  a resource's list and create, and get, update and delete, as Web `Request`/`Response` handlers,
  so a generated route file is two lines (`export const { GET, POST } = resourceRoutes(ticket)`).
  Every operation runs for `currentPerson(request)` through the resource store, list answers are
  `{ items, nextCursor }` cursor pages, a body is a bounded `application/json` read checked with
  the resource's schema, and every refusal is the one problem envelope with `no-store`; a record
  in another workspace answers `404 resource_not_found`.
- `currentPerson(request)`: the signed-in person behind the app's `aw_user_token` cookie or bearer,
  read from Agent Workspace's `GET /api/me`. An `awo_live_` token from `aw.auth.exchange` is sent
  as an access token and an `awu_live_` token as a user token; an API key, or no token, is no
  person (`401 unauthenticated`).
- `mcpEndpoint(app)`: one MCP endpoint per app with `<resource>_list`, `_get`, `_search` and
  `_update` tools for each resource its `agents` settings offer. It verifies Agent Workspace's
  identity assertion (`verifyIdentity`) with the connector's secrets before any store call, acts
  for the asserted person, writes only the fields `agents.write` lists and never more than that
  person may, and carries the run id into every agent write's audit row. A failed tool answers one
  fixed message (`AGENT_TOOL_FAILURE_MESSAGE`).
- `appRuntime()` reads the app's settings once (`APP_ENVIRONMENT_VARIABLES`,
  `AGENT_TOOL_ENVIRONMENT_VARIABLES`); a missing or malformed one answers `500 app_misconfigured`.
- `Person` and `allows`: who an operation runs for, in person or through an agent, and the one
  access check (`'member'`, `'role:<x>'` meaning that role or higher, a `person()` field, or any
  of a list).
- `@indx-workspace/app/db`: `storeOf(resource, { db, appName })`, the resource store every page,
  route and agent tool goes through. Each operation is scoped to the person's workspace,
  cursor-paged (50 by default, at most 200), validated and access-checked; an agent writes only
  the fields `agents.write` lists and never more than the person may. Audited resources write one
  `app_audit_events` row per write in the same transaction, naming fields and the agent's run but
  never values. Refusals are `AppStoreError`s with a fixed message per code.
- `tablesOf` and `appAuditTable`, the Drizzle tables in the app's schema `app_<name>`;
  `createTableSql` and `createAuditTableSql`, the same tables as deterministic SQL;
  `migrateApp`, which applies an app's migrations to its schema under an advisory lock and checks
  the ledger; `appSchemaName`.
- `@indx-workspace/app/testing`: `memoryStoreOf`, the in-memory twin of `storeOf` with the same
  behaviour, a call counter and the audit rows written, and `fakePerson`.
- The package now has `drizzle-orm` (0.45.4) and `pg` (^8) as peer dependencies, for
  `@indx-workspace/app/db`.
- A test clock and a schedule-slot trigger (issue #2077, ADR-0164 amendment). `testClock()` from
  `@indx-workspace/app/testing` is a clock a test moves by hand; `recipeRunner({ clock })`,
  `serveRecipes(app, env, { clock })` and `recipeHarness(recipe, { clock })` read it, and
  `runner.fireSlot(recipe, at)` / `harness.fireSlot(at?)` start one slot of a schedule at a chosen
  instant with the schedule's own dedupe key. Generated apps gain
  `app/api/recipes/slots/route.ts` (`recipeRoutes(app).slots`): a signed-in Owner or Admin of a
  development app starts a slot with `POST /api/recipes/slots` `{ recipe, at }`. Under
  `NODE_ENV=production` the route answers `404` and `serveRecipes` refuses a clock with
  `clock_override_refused`; production schedules are unchanged.
- The portal template signs a person in (issue #1510): `/sign-in`, `GET /api/sign-in`,
  `GET /api/sign-in/callback` and `POST /api/sign-out`, each route one line over the app kit's new
  `signInRoutes()` (`@indx-workspace/app/server`). It runs an OpenID Connect code flow at
  `AW_OIDC_ISSUER_URL` with S256 PKCE, a `state` and a `nonce` in a signed 10-minute cookie, then
  `aw.auth.exchange` with the app's `app-backend` client (ADR-0161), and keeps the `awo_live_`
  token in the `aw_user_token` cookie `currentPerson` reads. Refusals keep the platform's codes
  (`subject_not_member`, …); a missing variable is `503 sign_in_not_configured`. The sign-in
  notice links to `/sign-in?next=`, the navigation has Sign in and Sign out, and every string is
  in English and Japanese. Under `aw dev` it signs in at the development issuer with nothing to
  set. File reads stay outside the routes ADR-0161 admits for that token, so the Dashboard's file
  count and `/files` keep their localized notice after sign-in.
- A recipe reads and writes the app's records with `store(resource)` on its context (ADR-0164).
  It acts as the person's agent, so the person's `access` and the resource's `agents` rule both
  apply, exactly as for an agent tool call; the role comes from the members lookup, with
  `AW_APP_API_KEY` and a 60 s cache. A write is allowed only in the step whose run produced it,
  carries that run's id into the audit row, and is otherwise refused with
  `recipe_write_needs_run`. A schedule acts only in a step given `{ actingFor: <member> }`, whose
  run also asserts that member as `subject`; elsewhere its `store` is refused with
  `recipe_store_needs_person`, and `actingFor` for a non-member or in a recipe with a person is
  `recipe_acting_for_refused`. A store refusal fails the step with the store's own code.
- `recipeRunner` takes `stores` and `members`, which `serveRecipes` fills in from the app's
  stores and `cachedMemberDirectory`, now exported from `@indx-workspace/app/server`.
  `recipeHarness` gives recipes in-memory stores that outlive `restart()`, with `storeOf`,
  `personId` and a `members` option.

### Fixed

- `defineApp` accepts an empty `resources` list, as `aw generate app` and `--template portal`
  write it, so `aw dev` starts a new portal: the app's `/api/mcp` no longer answers 500
  `invalid_definition` and the ready screen is reached.
