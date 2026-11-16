# @indx-workspace/app

The app kit for Agent Workspace portal apps: the one package a generated app imports, so its own
code stays short and it upgrades by a version bump. It reaches Agent Workspace only through the
published [`@indx-workspace/sdk`](https://www.npmjs.com/package/@indx-workspace/sdk),
[`@indx-workspace/contracts`](https://www.npmjs.com/package/@indx-workspace/contracts) and
[`@indx-workspace/react`](https://www.npmjs.com/package/@indx-workspace/react), and is released in
lock-step with them. The root subpath holds `defineResource`, `defineApp`, the field types and
`allows`; `./db` holds the resource store and the app's tables and migrations, `./server` the
generated routes and `currentPerson`, `./testing` the in-memory twin and `setAppRuntimeForTests`;
the rest of each subpath is filled by later releases. A resource is one
`defineResource({ name, fields, access, agents, search })` call whose fields come from the builders
(`text({ max: 200 })`, `enumOf(['new', 'closed'])`, `person()`, …).

A definition with mistakes throws `DefinitionError` listing every one. The app kit's `files()` is a
record attachment field; `@indx-workspace/sdk/define`'s `files()` is an agent file grant.

| Subpath                       | What it will export                                               | Runs in                       |
| ----------------------------- | ----------------------------------------------------------------- | ----------------------------- |
| `@indx-workspace/app`         | `defineApp`, `defineResource`, the field types, `defineRecipe`    | anywhere                      |
| `@indx-workspace/app/server`  | `resourceRoutes`, `mcpEndpoint`, `currentPerson`, `recipeRunner`  | Node (Next.js route handlers) |
| `@indx-workspace/app/db`      | `storeOf`, `tablesOf`, `createTableSql`, `migrateApp`             | Node                          |
| `@indx-workspace/app/react`   | `ResourceList`, `ResourceBoard`, `ResourceForm`, `ResourceDetail` | browser                       |
| `@indx-workspace/app/testing` | `memoryStoreOf`, `fakePerson`, `setAppRuntimeForTests`, recipes   | tests                         |

`@indx-workspace/app/react` holds the four resource pages, each driven by a `defineResource`
result alone, with `resourceClient` for the resource routes and `AppTheme` for the `.aw-app` root
themed like the hosted surface. Import `@indx-workspace/app/react/styles.css` once; every part
speaks `ja` and `en`.

## Generated routes

A resource's routes are two short generated files:

```ts title="illustrative" claim="illustrative"
// app/api/tickets/route.ts
import ticket from '@/resources/ticket';
import { resourceRoutes } from '@indx-workspace/app/server';
export const { GET, POST } = resourceRoutes(ticket);

// app/api/tickets/[id]/route.ts
import ticket from '@/resources/ticket';
import { resourceItemRoutes } from '@indx-workspace/app/server';
export const { GET, PATCH, DELETE } = resourceItemRoutes(ticket);
```

`GET /api/<plural>` lists newest first (`?cursor=&limit=` and an `enumOf()` field as
`?<field>=<value>`), or searches with `?q=`, answering `200 { items, nextCursor }`. `POST` answers
`201` and a `location`; `GET /api/<plural>/:id` and `PATCH` answer `200`, `DELETE` `204`. Every
answer is `cache-control: no-store`, and every failure is `{ error: { code, message, details? } }`:

| Status | Code                                                                                                       |
| ------ | ---------------------------------------------------------------------------------------------------------- |
| 400    | `invalid_cursor`, `invalid_limit`, `invalid_query`, `invalid_body`, `malformed_body`, `search_unsupported` |
| 401    | `unauthenticated`                                                                                          |
| 403    | `forbidden`                                                                                                |
| 404    | `resource_not_found` (also a record in another workspace, and an id that is not a UUID)                    |
| 413    | `request_body_too_large` (over 1 MiB)                                                                      |
| 415    | `unsupported_media_type`                                                                                   |
| 500    | `app_misconfigured`, `internal_error`                                                                      |
| 502    | `upstream_failure`                                                                                         |

Each handler runs as the person asking. `currentPerson(request)` takes the platform token from
`Authorization: Bearer`, else the app's httpOnly `aw_user_token` cookie, and asks Agent Workspace
`GET /api/me` with it: an `awo_live_` access token (from `aw.auth.exchange`, what the app's sign-in
stores) or an `awu_live_` person token (a developer's or a test's bearer). An API key is not a
person, and nor is a member of a workspace other than the one the deployment serves
(`AW_WORKSPACE_ID`): that request is `401 unauthenticated`. The handlers read `AW_URL`,
`AW_APP_NAME`, `DATABASE_URL` and `AW_WORKSPACE_ID` once; when one is missing or
invalid they answer `500 app_misconfigured` without echoing it.

## Sign-in

`signInRoutes()` is how that cookie gets set: an OpenID Connect code flow at the app's issuer, then
ADR-0161's token exchange. The portal template writes its three routes, one line each:

```ts title="illustrative" claim="illustrative"
// app/api/sign-in/route.ts
export const GET = signInRoutes().start;
// app/api/sign-in/callback/route.ts
export const GET = signInRoutes().callback;
// app/api/sign-out/route.ts
export const POST = signInRoutes().signOut;
```

`start` (`GET /api/sign-in?next=/runs`) discovers the issuer and redirects there with S256 PKCE,
a `state` and a `nonce`, kept with `next` in a signed `HttpOnly` cookie for 10 minutes. `callback`
checks them, redeems the code with `client_secret_basic`, calls `aw.auth.exchange` with the app's
`app-backend` client, and sets `aw_user_token` for the token's `expires_in` (300 s). It reads
`AW_URL`, `AW_OIDC_ISSUER_URL`, `AW_OIDC_CLIENT_ID`, `AW_OIDC_CLIENT_SECRET`, `AW_APP_CLIENT_ID`
and `AW_APP_CLIENT_SECRET` on each request; `aw dev` sets all six. A missing one is
`503 sign_in_not_configured`, naming the variable. A refusal keeps its code (`subject_not_member`,
`sign_in_expired`, `issuer_refused`, …): a browser goes to `/sign-in?error=<code>`, any other caller
gets the envelope. `signInHref(next)` is the page to send a signed-out person to.

## Agent tools

An app has one MCP endpoint, registered with Agent Workspace as an ordinary `mcp` connector that
opts into the signed identity assertion (ADR-0142). Its route is one generated line:

```ts title="illustrative" claim="illustrative"
// app/api/mcp/route.ts
import app from '@/app';
import { mcpEndpoint } from '@indx-workspace/app/server';
export const { POST, GET, DELETE } = mcpEndpoint(app);
```

A resource with `agents.read: true` gets `<name>_list`, `<name>_get` and, when it declares
`search`, `<name>_search`; one whose `agents.write` lists fields gets `<name>_update`, whose input
is the record `id` and only those fields. `richText()` values go in and come out as markdown
(headings, lists, quotes, code, dividers and paragraphs). There are no delete tools, and the only
create tool is a page resource's `<name>_create` (see [Pages](#pages)).

Every request verifies the `x-aw-identity` assertion first, before any store is touched: a missing
or refused one answers `401` (`identity_assertion_invalid`, `identity_assertion_expired`,
`identity_audience_mismatch`, `identity_workspace_mismatch`), and `GET`/`DELETE` answer `405`. A
tool call then runs as the person who asked, through an agent in its run: the resource's `access`
and its `agents.write` must both allow it, and every write's audit row carries the run id. A
refused call is a tool result with `isError: true` and `<code>: <message>`; any other failure is
the fixed MCP error `The app request failed.`.

The endpoint reads three more variables, which the resource routes do not need, besides
`AW_WORKSPACE_ID`, which every handler reads:

| Variable                 | What it is                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `AW_APP_CONNECTOR_ID`    | The platform's id of the app's `mcp` connector: the assertion's audience                 |
| `AW_WORKSPACE_ID`        | The one workspace the deployment serves                                                  |
| `AW_APP_IDENTITY_SECRET` | The connector's signing secret; comma-separated (current first) while it rotates         |
| `AW_APP_API_KEY`         | An Admin API key: the assertion carries no role, so roles are read from the members list |

A member's role is cached for 60 seconds. An API-key or visitor subject holds no role; only a
`person()` field rule naming its subject admits it.

## Pages

`definePages({ access, agents })` is a resource of nested pages, for a wiki or a runbook: the fixed
fields `title`, `parent` (the page it is under), `position` and `blocks` (a `richText()` body of
`paragraph`, `heading1`–`heading3`, `bulleted_item` and `numbered_item` with nested items,
`quote`, `code` and `divider` blocks; any other type is refused), and with `space: true` a
`space` reference. Its `createTableSql` also creates `<name>_revisions` (`page_revisions`):

```ts title="illustrative" claim="illustrative"
// resources/page.ts
import { definePages } from '@indx-workspace/app';
export default definePages({
  access: { read: 'member', create: 'member', update: 'member', delete: 'role:admin' },
  agents: { read: true, write: ['title', 'blocks', 'parent'] },
});

// app/api/pages/[id]/revisions/route.ts (and restore/, move/)
import page from '@/resources/page';
import { pageRoutes } from '@indx-workspace/app/server';
export const { GET } = pageRoutes(page).revisions;
```

- Every create, and every save that changes the title or the body, writes a revision with its
  author and, for an agent, its run, in the same transaction. A page answers its `revision_id`; a
  `PATCH` (or `<name>_update`) that passes it back as `expectedRevisionId` is refused
  `409 page_conflict` when someone saved in between. `POST /api/<plural>/:id/restore` writes an
  older revision back as a new one; history is never deleted, not even with the page.
- `POST /api/<plural>/:id/move` changes `parent` and `position`: under the page itself or below it
  is `409 page_cycle`, and across spaces `409 page_space_mismatch`. Deleting a page with children
  is `409 page_has_children`; the store's `delete(person, id, { cascade: true })` deletes the
  subtree.
- Search (`?q=`, `<name>_search`) covers the title and the text of the blocks with PostgreSQL's
  own full-text search, no extension: Japanese is split into character pairs, so `手順` finds
  `保守手順`.
- The agent tools add `<name>_children` and `<name>_create(parent, title, markdown)`, within the
  person's access and `agents.write` (`position` joins it; `parent` is needed to create a page
  under another).
- `GET /api/<plural>/children?parent=<id>` (`pageRoutes(page).children`, in
  `app/api/<plural>/children/route.ts`) lists the pages under a page, or the top without `parent`.

`./react` draws them: `PageTree({ pages, selectedId, onSelect })` is a WAI-ARIA tree that loads
each level as it opens, with "New page" and a "Move to…" dialog; `RichText({ value, onChange,
readOnly })` is a block editor of labelled text boxes (Enter at the end splits a block, Backspace
at the start merges it, Alt+Up / Alt+Down reorders), drawn through `AssistantProse` when
`readOnly`; and `PageView({ resource, id, agents })` saves with `expectedRevisionId`, offers "Load
latest" or "Keep mine" on a conflict, lists the revisions with Restore, and opens the agent panel
with "Rewrite with <agent>" or "Summarize into new page", whose change lands as a new revision.

## Recipes

A recipe is a workflow written as TypeScript in the app and run by the app over the SDK; Agent
Workspace never executes it. Each `step(key, fn)` is idempotent and starts at most one ordinary
run, whose `Idempotency-Key` is `recipe:<recipeRunId>:<stepKey>`, so a recipe executed again after
a crash resumes where it stopped and never starts a second run for a step:

```ts title="illustrative" claim="illustrative"
// recipes/triage-incident.ts
import { defineRecipe, resourceEvent } from '@indx-workspace/app';
import { z } from 'zod';

export default defineRecipe({
  name: 'triage-incident',
  on: resourceEvent('incident', 'created'),
  async run({ aw, input, step }) {
    const triage = await step('triage', async () => {
      const { result } = await aw.runs.start('triage', {
        prompt: `Triage: ${JSON.stringify(input.record)}`,
        outputSchema: z.object({ severity: z.enum(['low', 'high']) }),
      });
      return (await result).output;
    });
    if (triage?.severity === 'high') {
      await step(
        'escalate',
        async () => (await (await aw.runs.start('responder', { prompt: 'page' })).result).text,
      );
    }
  },
});
```

A recipe starts on a committed write of one of the app's resources (`resourceEvent`) or on a cron
slot the app evaluates (`schedule(cron, timezone)`); it is listed in `defineApp({ recipes })`. Its
progress lives in the app's own `recipe_runs` and `recipe_steps` tables, which the template's
second migration creates. A step whose run stops for approval suspends the recipe until
`decide({ recipeRunId, stepKey, decision }, personClient)` approves or rejects it with the
person's own client. A failed step stores its run's public failure code, never provider text. The
template's `instrumentation.ts` starts the runner with `serveRecipes(app)` when the app has
recipes; it also reads `AW_APP_API_KEY`, the key every step's run is started with. This is a
declared gap: a step's run is decided by the app key's role and only attributed to the person who
started the recipe (`subject`), so a recipe may run an agent that person may not run until a
delegated grant captured at recipe start replaces the key.
`recipeHarness` in `./testing` runs a recipe end to end on an in-memory store and a scripted
platform, with `crashAfter(stepKey)` and `restart()`.

A recipe reads and writes the app's records with `store(resource)` (ADR-0164). It acts as the
person's agent (`via: 'agent'`), so the person's `access` and the resource's `agents` rule both
apply, exactly as for an agent tool call. The role comes from the same members lookup, with
`AW_APP_API_KEY` and a 60 s cache. A write is allowed only inside the step whose run produced it,
and it carries that run's id into the audit row. Anywhere else it is refused with
`recipe_write_needs_run`:

```ts title="illustrative" claim="illustrative"
// recipes/on-mention.ts (the body)
async run({ aw, input, step, store }) {
  await step('reply', async () => {
    const { result } = await aw.runs.start(helperId, { prompt: 'what changed today?' });
    const answer = await result;
    await store(message).create({
      channel: input.record.channel,
      thread_root: input.record.id,
      body: answer.text,
    });
    return answer.text;
  });
}
```

A schedule has no person. Its `store` works only in a step that names the member it acts for,
`step(key, fn, { actingFor: ticket.assignee })`; that step's run also asserts that member as its
`subject`. This is a declared gap: the member named did not ask for the write, though it stays
within their own access. A crash after a write and before its step is recorded as completed
repeats the write when the step runs again. `recipeHarness` gives the recipe in-memory stores that
outlive `restart()`. Read them back with `harness.storeOf(resource)`, and set roles with
`members`.

`aw generate recipe <name> --on resource:<resource>.created` (or `--on 'schedule:*/5 * * * *'`
with `--tz`) writes `recipes/<name>.ts` and its `recipeHarness` test, and adds it to
`app.config.ts`. In the browser, `recipeRoutes(app)` serves the recipe runs and their steps from
five one-line route files, decides a waiting step as the signed-in person, receives the
signed run-outcome webhook (`AW_APP_WEBHOOK_SECRET`), and in development starts a schedule's slot;
`RecipeGraph` and `RecipeRunList` in `./react` draw them:

```ts title="illustrative" claim="illustrative"
// app/api/recipes/runs/route.ts
export const { GET } = recipeRoutes(app).list;
// app/api/recipes/runs/[id]/route.ts
export const { GET } = recipeRoutes(app).item;
// app/api/recipes/runs/[id]/steps/[key]/decision/route.ts
export const { POST } = recipeRoutes(app).decision;
// app/api/recipes/webhook/route.ts
export const { POST } = recipeRoutes(app).webhook;
// app/api/recipes/slots/route.ts
export const { POST } = recipeRoutes(app).slots;
```

Time can be moved in a test, never in production (ADR-0164). `testClock()` from `./testing` is a
clock that moves only when told (`set`, `advance`); `recipeRunner`, `serveRecipes(app, env,
{ clock })` and `recipeHarness({ clock })` read it, and `harness.fireSlot(at?)` starts the schedule
recipe's slot at that instant, as the schedule would, once per instant. A running development app
does the same through `POST /api/recipes/slots` `{ recipe, at }`, for a signed-in Owner or Admin,
so a journey can move a record past its deadline. Under `NODE_ENV=production`, `serveRecipes`
refuses a clock (`clock_override_refused`) and the route answers `404`; schedules there run on the
wall clock as before.

## Realtime channels

`channel(name, { resource, key?, retain? })` from `./server` pushes an app's events to browsers
over PostgreSQL `LISTEN/NOTIFY` and one Server-Sent Events endpoint per channel, with no Redis and
no new service. A durable event is stored in the app's own `app_channel_events` table, which the
template's third migration creates:

```ts title="illustrative" claim="illustrative"
// channels/room.ts
import { channel } from '@indx-workspace/app/server';
import room from '../resources/room.ts';

export const roomChannel = channel('room', { resource: room });

// app/api/channels/room/events/route.ts
import { roomChannel } from '../../../../../channels/room.ts';
export const { GET } = roomChannel.routes();

// in a write: stored and notified in the same transaction
await roomChannel.publish(tx, { key: roomId, type: 'message', data: { text } });
// presence or typing: notified only, never stored
await roomChannel.publishEphemeral({ key: roomId, type: 'presence', data: { online: true } });
```

- `publish(tx, event)` inserts the event and calls `pg_notify` in one statement, so a write that
  rolls back is never delivered. Each key keeps its newest `retain` events (1000 by default).
- `publishEphemeral(event)` only notifies; its payload must encode to fewer than 8000 bytes.
- `GET /api/channels/<name>/events?key=<recordId>` runs as the signed-in person. The bound
  resource's `read` access on the record `key` decides, and a refusal is `404` before the stream
  opens. The stream resumes from `Last-Event-ID` or `?after=` (the header wins). A cursor older
  than the oldest retained event, or newer than the latest, gets a `stream-reset` frame, and a
  malformed one gets `400 invalid_cursor`. No frame is ever named `error`.
- One `LISTEN` connection per process wakes every stream in memory. It reconnects with a backoff
  from 250 ms to 5 s, and a 1000 ms poll covers a missed notification, so delivery stays within a
  second either way. This is a declared limit: `LISTEN/NOTIFY` covers one PostgreSQL primary.

In the browser, `useChannel(name, key)` from `./react` returns `{ events, status, problem }`. It
reconnects with `Last-Event-ID`, gives up after five reconnects in a row that deliver nothing new,
backs off exponentially from the stream's `retry:` (capped at 30 s), honours `Retry-After`, and
discards the events it holds on `stream-reset`. `followChannel` is the same loop without React.
`memoryChannelHub` in `./testing` is the in-memory twin that `setAppRuntimeForTests` installs.

### A resource's channel and `ChannelView`

`aw generate channel message` binds the `message` resource to a channel keyed on its first `ref()`
to another resource (`--key <refField>` names another): it writes `channels/message.ts`, its events
route and `app/channels/message/[key]/page.tsx`, and passes `{ publish }` to the resource's two
route files. A resource with no `ref()` to key on is refused with `channel_key_required`.

```ts title="illustrative" claim="illustrative"
// channels/message.ts
export default channel('message', { resource: roomResource, key: 'room' });
// app/api/messages/route.ts
export const { GET, POST } = resourceRoutes(message, { publish: messageChannel });
// app/channels/message/[key]/page.tsx
<ChannelView channel="message" resource={message} keyValue={key} members={members} />
```

- Every write of a bound resource, through its routes or an agent tool, publishes
  `{ type: 'created' | 'updated' | 'deleted', data: <record> }` on the key its `key` field names,
  inside the write's transaction (the stores' `afterWrite` hook): a write that rolls back is never
  delivered, and a publish that fails rolls the write back. The channel's `resource` is the key's
  resource, whose `read` access admits a subscriber; that subscriber sees every record of the key.
- `ChannelView` draws the key's messages live (`aria-live="polite"`), a thread pane on the
  resource's `ref()` to itself, a composer with `@` mentions over `members` and, given
  `uploadFile`, attachments, and a presence row. Each open stream announces its person every 15
  seconds; a person is forgotten 45 seconds after their last heartbeat.
- Declared limits: the list is what the stream replays (the key's newest `retain` events), since a
  list cannot filter on a `ref()` field yet; a binding exists once a route file that binds it has
  been loaded in the process; a `definePages` resource cannot be bound.
