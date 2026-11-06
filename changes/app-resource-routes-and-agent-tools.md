---
changelog: app
section: Added
---

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
