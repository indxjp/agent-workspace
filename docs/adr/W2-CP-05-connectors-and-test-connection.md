# W2-CP-05 — MCP connectors, a from-scratch Test Connection probe, and the composition-root call the integrator makes

Status: accepted
Date: 2026-09-06
Decided by: W2-CP-05 (implementer)
Scope: `apps/web/server/connectors/**`, `apps/web/app/api/connectors/**`, plus (declared below,
outside this task's dispatched `Owns:` globs) `packages/core/src/db/repositories/mcp-servers.ts`
and small additive edits to `packages/core/src/db/repositories/{index,root,unscoped}.ts` and
`packages/core/src/db/index.ts`, `apps/web/server/rbac/declarations/W2-CP-05.ts` and one import
line in `apps/web/server/rbac/declared-sub-resources.ts`.

## Context

Spec §8 needs MCP connectors over stdio/http/sse, credentials referenced from `secrets` (spec
§23), and a Test Connection probe (research note R-06 §4). This task's
dispatched `Owns:` globs are narrow: `apps/web/server/connectors/**` and
`apps/web/app/api/connectors/**` only — no `packages/core` glob, unlike sibling 2b-1 tasks
(W2-CP-02 got `packages/core/src/secrets/**`, W2-CP-03 got `packages/core/src/storage/**`).

## Decision 1 — the `mcp_servers` repository is added outside this task's dispatched `Owns:` globs, declared here under ADR-0018

`packages/core/src/db/schema/mcp-servers.ts` already ships the table (W2-DB-01), and its own
header says plainly: *"The pull request declares the unguarded column [`args`] as a gap for its
first consumer, W2-CP-05."* `DatabaseRoot` (`packages/core/src/db/repositories/root.ts`) had no
`mcpServers` field, and `@agent-workspace/core/db`'s barrel re-exports only from
`./repositories/index.ts` (`database-reachability.test.ts` enforces exactly that shape) — the same
problem W2-CP-02 hit for `secrets`, recorded in
`docs/adr/W2-CP-02-envelope-encryption-and-its-own-connection.md`.

This task's PROTOCOL is explicit that `apps/web/instrumentation.ts`, every `package.json` and
`pnpm-lock.yaml` are the INTEGRATION task's (W2-INT-02) to touch, not this one's, and this ADR
honours that literally: **no package.json, no lockfile, and no instrumentation.ts line is added by
this task.** What it does not settle is `packages/core/src/db/repositories/**`, which is a
different kind of file — not a cross-cutting manifest every sub-wave task edits, but a *new,
disjoint* file plus small additive lines in a barrel already built (by its own header) to grow this
way: *"A new resource copies the shape rather than the code: a record type, a discriminated outcome
union … a line on `DatabaseRoot` …"* (`repositories/index.ts`'s own header, W2-DB-02).

**ADR-0018** — the standing rule ADR-0023 decision 2 reaffirms for every Wave 2 derived glob — is
what this task invokes: *"a task that needs a file outside its glob declares it with a reason, and
the declaration is the boundary provided it stays disjoint from its siblings."* Two things make
this specific addition disjoint and low-risk:

1. **No sibling 2b-2 track touches it.** W2-CP-04 (skills) persists through
   `@agent-workspace/core/storage`, already shipped with its own export subpath; it has no reason
   to add a `packages/core/src/db/repositories/**` file.
2. **It needs no new `package.json` export.** `@agent-workspace/core/db` already exists. Adding a
   repository here, and re-exporting its types by name from `./repositories/index.ts` (the same
   move `./runs.ts` already makes for `runStatuses`), is growing an existing barrel the way its own
   header says a seventh resource should — not adding a manifest entry.

Verified rather than assumed: `packages/core/src/db/repositories/mcp-servers.test.ts` runs the
full CRUD/tenant-isolation/FK-violation contract against a real, isolated PostgreSQL 17 database
(`createIsolatedTestDatabase`), and the repository-wide `scope-forgery.test.ts` and
`database-reachability.test.ts` (which auto-derive their own coverage from the tracked tree) both
pass unmodified with the new provider present — see this task's PR report for the pasted run.

**What is still, correctly, left to the integrator:** the one call that installs the runtime —
see Decision 4.

## Decision 2 — Test Connection speaks the MCP wire protocol directly; it does not depend on `@modelcontextprotocol/sdk`

research note R-06 §4.6's reference implementation
(`fixtures/R-06-mcp/test-connection.mjs`) is built on `@modelcontextprotocol/sdk`, and its own
header instructs W2-CP-05 to copy it. This task's PROTOCOL is more specific for *this* wave than
that note anticipated: *"every `package.json` and `pnpm-lock.yaml` belong to the INTEGRATION task
W2-INT-02 … If you need a dependency … STATE IT … and DO NOT add it. Your routes will answer 503
until the integrator wires you up, and that is the correct intermediate state."* A Test Connection
button that cannot run until a dependency lands cannot meet this task's own acceptance criterion —
*"a wrong URL and a wrong token produce two different human-readable errors — drive both and paste
both messages"* — which this task's own PR must satisfy now, with real, pasted output.

So `apps/web/server/connectors/wire/*.ts` implements the MCP wire protocol directly — JSON-RPC 2.0
framed over stdio (newline-delimited) and over http/sse (`fetch`) — using only Node built-ins
(`node:child_process`, `fetch`). `apps/web/server/connectors/classify.ts` ports R-06 §4's
discriminator table (the HTTP-status split, the JSON-RPC pre-defined-vs-application error-range
split — mind the direction, R-06's own warning — and the credential-configured split on 401 and on
a server-sent application error) onto a `ProbeSignal` this task's own wire code produces, rather
than onto an SDK error object.

**Declared, not assumed:** measured in this task's own worktree before this file was written
(`pnpm install --frozen-lockfile`, then checked against `apps/web/node_modules/` and
`apps/runner/node_modules/`), `@modelcontextprotocol/sdk` is reachable from **neither** without a
new dependency declaration — confirming R-06 §4.6's own finding that it is only a transitive peer
of `@anthropic-ai/claude-agent-sdk`, not a declared dependency of any workspace package.

**Stated, not added, per this task's protocol:** if a future round wants to build on
`@modelcontextprotocol/sdk` instead (R-06's own recommendation, absent this wave's package.json
restriction), it is `1.30.0`, pinned by R-06 §4.6, added to `apps/web/package.json`. This task does
not add it.

**Declared simplification, proven against real fixture servers rather than against the SDK:** this
task's own `apps/web/server/connectors/fixtures/{http,sse,stdio}-server.mjs` are small, hand-rolled
MCP servers (no SDK either), driven by `apps/web/server/connectors/test-connection.test.ts`, which
drives the acceptance criterion directly and prints both sentences on `http` (see this task's PR
body). What is **not** reproduced from R-06's 33-case matrix: the full stderr-mojibake-on-Windows
guard's `probe-classify.mjs`-style exhaustive case count, the Streamable-HTTP↔SSE auto-fallback
(R-06 §4.5, itself only `documented`, not run, in R-06), and `MCP-Session-Id` resumption beyond a
single probe's lifetime. Each is a smaller, explicitly scoped MVP than R-06's reference, not a
silent gap.

**Correction (round 3, ADR-0045):** `fixtures/stdio-server.mjs` still exists and is still exercised
by `test-connection.test.ts`, but no longer to drive the acceptance criterion over stdio — it is
now the fixture used to *prove the stdio probe is never spawned* (a real MCP server that would
answer within milliseconds if it ran, and provably does not run). The control plane does not spawn
a caller-supplied `stdio` command at all any more; see
`docs/adr/0045-the-stdio-connector-probe-runs-in-a-sandbox-or-it-does-not-run.md` and this task's
PR report. The acceptance criterion is satisfied on `http` alone, which spec §8 permits (Test
Connection is not specified as stdio-only).

## Decision 3 — the credential field name is fixed per `(transport, authType)`, not user-chosen

Spec §8's mockup (`ui/connector-new.html`) lets the user name the header an API key is sent under
("Sent as a header you name"). `packages/core/src/db/schema/mcp-servers.ts` — W2-DB-01's, not this
task's `Owns:` glob — has no column to store that name: its columns are `transport`, `command`,
`args`, `url`, `authType` and `credential_secret_id`. Adding one is a migration this task does not
own (migrations are a shared, ordered artefact — `migrations/meta/_journal.json` — and a task
outside its `Owns:` glob does not create one). So `apps/web/server/connectors/contract.ts`'s
`credentialFieldFor` fixes the field per pair: `Authorization` (bearer, oauth), `X-Api-Key`
(api-key, http/sse), `MCP_CREDENTIAL` (any authenticated type, stdio). Declared as a gap: a future
task that adds a `credential_field_name` column to the schema can widen this without changing the
wire shape `test-connection.ts` and the routes already agree on.

## Decision 4 — `test-connection` rides `POST /api/connectors` as a `dryRun` flag, not a route of its own

The first draft of this task shipped `POST /api/connectors/test-connection` (the wizard's pre-save
probe) as its own route. `tests/route-inventory.test.ts`'s shape rule (ADR-0026 decision 3) admits
only `/api/<resource>`, `/api/<resource>/:id` and `/api/<resource>/:id/<sub>` — a literal second
path segment with **no** id first is refused as *"a second resource that has not been named"* the
moment it carries a `mandate` rather than being printed by §34. Declaring `test-connection` as a
genuinely new top-level resource means writing four roles' grants into
`apps/web/server/rbac/permissions.ts`'s `RESOURCES`/`POLICY` — W2-CP-06's file, not this task's to
add a resource to, and not something ADR-0040's sub-resource partition covers either (that
mechanism is only for attaching a `<sub>` to a resource §21's table *already* classifies).

So the wizard's pre-save `[ Test Connection ]` (driven before `[ Save ]`, spec §8) rides the one
route that is already shape-legal and already gated on workspace membership:
`POST /api/connectors` reads a `"dryRun": true` field off the same body it already validates, and
when set, runs the probe and returns its `TestConnectionOutcome` (200) instead of writing a row —
never touching the store. `POST /api/connectors/:id/test-connection` (re-testing an already-saved
connector, resolving its stored secret reference server-side) keeps its own route: `:id/<sub>` is
shape-legal, and is additionally declared in `apps/web/server/rbac/declarations/W2-CP-05.ts`
(ADR-0040) as a `write`-width sub-resource of `connectors` — not `run`, because it spends no money
and executes no agent, but it does resolve and use the connector's own credential, which is at
least as sensitive as writing the row.

`apps/web/server/connectors/handlers.ts`'s header carries the full reasoning; see also this task's
PR report for the `route-inventory.test.ts` failure this draft produced before the fix, kept as
this record's own evidence that the shape rule was actually driven, not assumed.

## Decision 5 — the connectors runtime wiring call (for the integrator, W2-INT-02)

`apps/web/server/connectors/runtime.ts`'s `configureConnectorsRuntime` is the seam. Until something
calls it, every `/api/connectors*` route answers `503 connectors_runtime_not_configured` — measured
in this task's own `no-route-answers-503.test.ts` run (see PR report). The exact call, modelled on
`installSecretsApi`/`installFilesApi` already in `apps/web/instrumentation.ts`:

```ts
// Inside apps/web/instrumentation.ts's register(), alongside the sub-wave 2b-1 installers —
// after `root` (DatabaseRoot) and the secrets service are both available:
const { createRepositoryConnectorsStoreProvider } = await import('./server/connectors/store');
const { configureConnectorsRuntime } = await import('./server/connectors/runtime');
configureConnectorsRuntime({
  resolveWorkspace, // the SAME closure already passed to configureSecretsRuntime/configureFilesRuntime
  connectors: createRepositoryConnectorsStoreProvider({
    mcpServers: root.mcpServers, // DatabaseRoot.mcpServers — this task's Decision 1 addition
    secrets: /* the same SecretsService instance installSecretsApi already constructed */,
    scopes: root.scopes,
  }),
});
```

The one thing this call needs that `installSecretsApi` does not yet expose: the constructed
`SecretsService` instance, currently local to that function's closure in
`apps/web/instrumentation.ts`. The integrator either hoists that instance one scope up (cheapest)
or constructs a second `SecretsService` for this call (works today — `createSecretsService` opens
its own pool regardless, per `docs/adr/W2-CP-02-envelope-encryption-and-its-own-connection.md`
Decision 1 — but is a second pool for no reason). Stated so the choice is made once, in the open,
rather than found mid-diff.

## Declared gaps this record does not resolve

- **No `PATCH /api/connectors/:id`.** Only create, list, get, delete and the two Test Connection
  paths are built, matching the acceptance criteria's own scope.
- **The orphaned-secret race on create.** `store.ts`'s `create` seals the credential as a secret
  *before* inserting the `mcp_servers` row (the row's FK needs an id that already exists). If the
  insert then fails (most likely: a name conflict), the sealed secret is orphaned — `SecretsService`
  has no delete method (`docs/adr/W2-CP-02-…`'s own declared gap), and the two subsystems use
  separate connection pools, so no cross-pool transaction could undo it either. A best-effort
  pre-check is not implemented; this is a bounded, rare, non-security-relevant leak (an unreachable
  encrypted row), declared rather than engineered around.
- **No Streamable-HTTP↔SSE auto-fallback** (R-06 §4.5) — the mockup's explicit Transport toggle is
  what W2-UI-10 wires the wizard to instead.
- **OAuth is bearer-shaped, not a real flow.** `authType: 'oauth'` accepts a pre-obtained access
  token exactly like `bearer` (R-06 §3: *"the control plane runs the whole OAuth 2.1 flow and
  passes the resulting access token in headers"*) — no discovery, no Dynamic Client Registration,
  no token refresh. Building the flow is out of this task's scope.
- **Two pre-existing, cross-cutting test failures this task's branch reproduces but cannot fix** —
  see `docs/adr/W2-CP-05-two-repo-wide-gate-defects.md`.
- **The `stdio` Test Connection probe cannot run in this deployment (round 3, ADR-0035 declared
  gap, implementing [ADR-0045](0045-the-stdio-connector-probe-runs-in-a-sandbox-or-it-does-not-run.md)).**
  A caller-supplied `stdio` command is no longer spawned by this control plane at all — see
  `docs/adr/W2-CP-05-stdio-probe-removed-per-adr-0045.md` for the full record and this task's PR
  report for the evidence.
