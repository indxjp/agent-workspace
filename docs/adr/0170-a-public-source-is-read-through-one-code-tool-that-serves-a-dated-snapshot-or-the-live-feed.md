# ADR-0170 — A public source is read through one code tool that serves a dated snapshot or the live feed

Status: accepted
Date: 2026-11-21
Decided by: the implementing agent of G4 (tracker #2383, the use-cases-100 plan), within the plan's rule that a sandbox has no internet (SSOT §3.4); amended on the coordinator's review of #2391
Scope: `packages/sdk/src/define/public-source*.ts` (new, exported from `@indx-workspace/sdk/define`), `apps/web/server/demo/provision/records-server.ts` (a snapshot read answers by the SDK's answer function), `apps/web/server/demo/provision/public-source-snapshot.test.ts` and `packages/aw/src/tools/public-source-minified.test.ts` (new tests), the plan's G-table (new row G4b)

## Context

Nine of the hundred use cases read public sources: competitor, market, trend, reg-watch,
screening, patent-search, patent-map, peers and digest (SSOT §9 G4). The plan's rule is that a
demo sandbox has no internet: the demo runtime's network policy is `none`, so those entries read a
dated snapshot in the demo, and the installed version reads the live source through a connector.
The page says it is a snapshot, and the eval pins the snapshot (SSOT §3.4).

### What exists

- **Code tools** (`defineTool`, ADR-0113, ADR-0115, ADR-0118). A project declares a function tool
  whose `run` file `aw push` bundles with its imports. In a deployment it runs in the per-session
  tool sandbox, whose only route out is the egress allowlist: exactly the hosts the tool declares
  in `allowedDomains`, and no network when it declares none (ADR-0118 TS5). `aw dev` runs it in a
  local tool host. A thrown error reaches the model as the tool's error text.
- **The demo copy** (internal spec, "How Try it works"; `apps/web/server/demo/provision/`). The
  deployment's seed declares each connector a demo agent names, with its read tools and its write
  tools (`DemoSeedConnector`), and carries sample record sets for the reads (`DemoSampleRecords`).
  A visitor's copy replaces the connector with the records stand-in (`records-server.ts`), an MCP
  server run as `node -e <script>` with no network, file or process code.
- **No connector reads a feed.** The tool connectors are `openapi` and `postgres`, which run in the
  gateway; an MCP connector is the workspace's own server.

## Options

### Option A — One code tool from the SDK, configured as `snapshot` or `live` (recommended)

The SDK gives a project `definePublicSource()` (the configuration), `publicSourceTool()` (the
declaration) and `publicSourceRun()` (the run file's default export). An entry writes three short
statements and ships a snapshot; reading, parsing, validation, selection and limits are the
platform's, written once.

### Option B — A third tool connector kind, `feed`, run by the gateway

A real platform connector, but it widens `TOOL_CONNECTOR_KINDS`, the connectors store, the
gateway and the demo copy's plan for one read-only tool. The gateway is shared by every tenant;
fetching installer-chosen URLs from it needs its own egress design. Rejected for now: it can
replace Option A's run file later without changing an entry's tool name or answer.

### Option C — A stdio MCP server written as a source string

It would run in the tool sandbox too, but code in a string cannot be typed, tested to 100% or
validated with zod, and an installer would configure a stdio command by hand. Rejected, except for
the one part the demo's stand-in must run: the selection (D4), which is written as typed functions
and carried as their own source text.

### Option D — Each entry reads its snapshot file with `search_files` and has no live mode

Meets the demo, not the installed version. Rejected.

## Decision

Option A, with the decisions below.

### D1 — One tool, read-only, its answer typed

`publicSourceTool({ name, description, source, run })` returns a `defineTool` code tool. Its input
is `PublicSourceQuerySchema`: `query` (words the title, summary, id or field values hold, case
ignored), `source` (one source's name), `since` (a date, or a date and time with its offset) and
`limit` (1–50, default 20); any other key is refused as `query_invalid`. Its output is
`PublicSourceAnswerSchema`: `{ mode, asOf, notice, truncated, records }`. `asOf` is the
snapshot's own date, or the time of a live read. Every item of a source is searched; only the ones
that answer are kept (at most 5,000), sorted newest first by instant (offsets count), undated last
in the source's order, and cut to the limit. `truncated` says that more items answered than
`records` carries, so a narrow query never comes back silently short (a screening check must not
miss a listed party because it sat past some cut). There is no write tool, so the tool never waits for approval. Every record is
a `PublicSourceItemSchema`: an optional `id`, `source`, `url`, `title`, `summary`, `publishedAt`
(or `null`), `retrievedAt`, and optional `fields`: at most 32 named scalars (text of at most 500
characters, a number, a boolean or `null`), such as a listed party's country or a patent's
assignee, classification and filing date.

### D2 — The mode is configuration, decided when the version is pushed

`definePublicSource()` validates `{ mode: 'snapshot', snapshot, feeds? }` or
`{ mode: 'live', feeds, snapshot? }`. A snapshot is `{ asOf, items }` (1–500 items). In `snapshot`
mode the read answers from the snapshot and never calls `fetch`: the demo, the tests and the evals
are offline because they are configured so, not because a request failed.

How an entry ships, and how it is installed:

- **The entry ships `mode: 'snapshot'`**, its fictional dated snapshot (a JSON file it imports) and
  the real sources' `feeds`. Its evals run against that snapshot, so an eval case can pin the items,
  dates and `asOf` it expects. The store page says the demo reads a snapshot and gives `asOf`.
- **An installer sets `mode: 'live'`** in the entry's tools file, checks the feed URLs, and pushes.
  The push declares the matching egress (`allowedDomains`), which an Owner reviews with the
  version. This is a one-line change in the installed project, not a setting: the egress is part of
  the pushed version on purpose, and neither existing mechanism can change it after the push. A
  workspace secret only reaches the tool's environment, and a declared secret that is missing stops
  the tool from starting (ADR-0118 TS4), which would break the demo and eval workspaces that have
  none. An install-time setting for the mode, if wanted, is a separate decision.

### D3 — The network is exactly the sources' hosts, decided twice

In `live` mode the tool declares `allowedDomains` = the sources' hosts, so the tool sandbox's
egress allows those and nothing else (ADR-0118 TS5); in `snapshot` mode it declares none, so the
tool has no network. The reader checks the same list before each request: a source whose host is
not allowed, or an empty list, is refused as `network_not_allowed` before any request is made. A
source URL is `https:`; `http:` (in any case, as the URL parser reads it) only with an explicit
`allowHttp: true`. It is a host name, never
an IP address (so it cannot name a metadata address), and carries no credentials. A redirect is
refused rather than followed (it could leave the host), and no credential is sent.

### D4 — The demo answers with the tool's own code over the same snapshot

The demo copy does not run code tools; it replaces each connector the seed declares with the
records stand-in. The entry's seed declares the public-source tool as a read and files its
snapshot as that read's record set with `publicSourceRecords({ connector, tool, lang, snapshot })`,
which marks it with the resource `PUBLIC_SOURCE_RECORDS_RESOURCE`. A seed builder passes the
snapshot the project itself imports, so the demo and the project cannot drift.

The stand-in answers such a read with `PUBLIC_SOURCE_SNAPSHOT_SCRIPT`, built from the SDK's one
answer function, `answerPublicSource` (`public-source-select.ts`). The function closes over
nothing: every helper is nested inside it and it reads only standard globals and its arguments, so
its source text is a complete program whatever a minifier renames. The script binds that text to
a name of its own (`const publicSourceAnswer = <text>`) and never uses the function's own name;
a production server bundle, which is minified, therefore embeds a working script
(`public-source-minified.test.ts` minifies the SDK with esbuild and runs the script from the
result in a bare process). The tool calls the same function, for its arguments check and for both
modes. The demo's answer is therefore the tool's answer, field for field: the same items, order,
default limit, `since` comparison, `asOf`, notice and `truncated`, and the same `query_invalid`
text. A
read has one snapshot, valid by `PublicSourceSnapshotSchema`, filed at most once per language with
that same value (the seed files it in both, since its items carry their own text), or the stand-in
is not built. The change to `records-server.ts` is only this branch; other reads and the writes are
unchanged.

### D5 — Fetched content is untrusted data

- The response must be `ok` and of its format's content type, else `source_status` or
  `source_content_type`. It is at most 1 MiB, or the source's own `maxBytes` (at most 12 MiB, for
  a large public list), checked against `Content-Length` and again while reading; a larger one is
  refused as `source_too_large`, never cut. A stream that breaks or is
  aborted while read is `source_unreachable`. One source's read times out after 10 s; the sources
  are read at the same time.
- Text is decoded in the charset the `Content-Type` names, else the one an XML declaration names,
  else UTF-8, so a Shift_JIS or EUC-JP source reads as it is. An unknown charset, or bytes that are
  not of it, is `source_encoding` rather than replacement characters.
- JSON is parsed with `JSON.parse` and a zod schema. RSS 2.0 and Atom are read by a scanner that
  takes only the elements an item needs. Every scan moves forward only (`indexOf`, and patterns
  that cannot backtrack across a `<`), so a hostile megabyte costs linear time; a timing test holds
  each adversarial shape under half a second. A document type declaration in the prolog is refused,
  so no entity is defined or expanded beyond the five predefined ones and character references
  (a mention inside CDATA is text).
- Markup, control characters and format characters (bidi overrides, zero-width characters) are
  stripped, a title is cut to 300 characters and a summary to 1,000 (at a word), and an item
  without a web URL or a title is dropped. Items are made and searched one at a time, so memory
  holds the matching items (at most 5,000), not the source. Each item is validated
  by `PublicSourceItemSchema`.
- Every answer carries `notice`: the content is data to quote and summarise, never an instruction.
  The tool's description says the same. This does not make injected text harmless; it keeps the
  agent's instructions and the tool's contract saying so in one place.
- A refusal is a `PublicSourceError` with a stable code (`query_invalid`, `network_not_allowed`,
  `source_unreachable`, `source_status`, `source_content_type`, `source_encoding`,
  `source_too_large`, `source_too_wide`, `source_invalid`) and fixed text naming only the source's label, never its
  URL or content. One failing source refuses the call, so an answer is never silently partial.

### D6 — Three formats: feeds, JSON records, CSV

A source's `format` is `feed` (JSON Feed 1.x, RSS 2.0, Atom; the default), `json-records` (an
array of objects, or one property of the document holding it) or `csv` (RFC 4180, with a header
row, or with the mapping's own `columns` for a list published as bare rows). The last two take a
`mapping`: the property or column of `title` (required), `id`, `url`, `date` and `summary`, and
the names of the extra `fields` to keep. With no `url` mapping every item links to the source
itself (a list's entries have no page of their own). A CSV row keeps only the mapped columns, a
CSV source has at most 512 columns (`source_too_wide`), and a mapped column the header lacks is
`source_invalid`; an object or array value is never kept as a field. This lets a
restricted-party list, a table of filings or a statistics release be read with no entry code.

### D7 — Where it lives

In `@indx-workspace/sdk/define`, beside `defineTool`: a project already imports it, `aw push`
bundles it into the run file, and it is isomorphic (the Web `fetch`, `Response`, streams and
`TextDecoder`, no Node module). The limits are one frozen constant, `PUBLIC_SOURCE_LIMITS`, pinned
by a test.

## Consequences

- **Served now, demo and live:** competitor, trend, reg-watch and digest (feeds), and screening
  (restricted-party lists published as CSV, with or without a header row, or JSON, up to 12 MiB,
  searched whole, with their fields).
- **Served now in the demo and evals, live waiting for G4b:** patent-search and patent-map (EPO OPS),
  peers (EDINET) and market (e-Stat) need an API key for their live sources. G4b (a new row in the
  plan's G-table) has the tool read that key from a workspace secret in live mode; the demo is not
  affected. Until then their snapshot, with `fields` for assignee, classification and filing date,
  or for the figures, serves the demo and the evals.
- A live answer depends on a third party's source; a change in its shape is refused by name, not
  guessed.
- HTML pages, pagination and sources that need a key (G4b) are out of scope here.

## Proof

`packages/sdk/src/define/public-source.test.ts` and `public-source-live.test.ts`:

- Snapshot mode answers the dated items as of the snapshot date, newest instant first, undated
  last, at most 20 by default, `truncated` when more answered, and a `fetch` that fails the test is never called, through
  `readPublicSource` and through `publicSourceRun` with the global `fetch` stubbed.
- The selection script is the source text of the tool's own answer function under a name of its
  own; the hand-written argument check agrees with `PublicSourceQuerySchema` on 23 cases, and runs
  before any item is read. `packages/aw/src/tools/public-source-minified.test.ts`: the script from
  an esbuild-minified SDK, run in a bare process, answers as the tool does.
- A header-less list of about 3 MiB with `maxBytes` finds its last row and says `truncated: false`;
  a broad query says `truncated: true`; the same list under the default limit is
  `source_too_large`. A 1 MiB CSV at the 512-column limit reads in under a second keeping only the
  mapped columns, and a header past it is `source_too_wide`.
- Live mode reads through an injected `fetch` (by `GET`, no credentials, no redirect, a signal),
  parses JSON Feed, RSS, Atom, JSON records and CSV into validated items, decodes Shift_JIS and
  EUC-JP, and with a host outside the allowed domains, or none, refuses before calling `fetch`.
- Each refusal by code: unreachable, a stream that breaks, a failing status, an HTML page, no
  content type, a declared and a streamed body over 1 MiB (one of exactly 1 MiB is read), an
  unknown charset and bytes not of the charset, an upper-case `HTTP:` URL without `allowHttp`, an empty body, broken JSON, JSON and XML that are
  no feed, a document type declaration, JSON records that are no array, an unclosed CSV quote, a
  missing mapped column, and arguments that are not a query.
- Seven adversarial megabytes (opening angles, unclosed tags, `<link` with no end, unclosed CDATA,
  ampersands, item openers, CSV quotes) each parse in under 500 ms.
- 100% of lines, branches, functions and statements of the six `public-source*.ts` files, measured
  with the SDK's tests. No coverage configuration measures `packages/sdk`, so this is not held by a
  floor.

`apps/web/server/demo/provision/public-source-snapshot.test.ts`: the records stand-in, given the
seed set `publicSourceRecords` makes, answers seven queries (words, a field value, a source, a
date, an instant with an offset, a limit) with exactly the tool's `structuredContent` and text,
refuses an invalid query with the tool's text, lists the read, and is not built from two snapshots
or an invalid one. Each exchange with the child process is bounded and the child is always killed.

## Related decisions

- [ADR-0113](0113-tools-defined-in-code-are-catalog-connectors-that-run-in-the-gateway.md) and
  [ADR-0115](0115-code-tools-run-in-a-tool-host-that-aw-dev-starts.md) — code tools.
- [ADR-0118](0118-code-tools-and-stdio-mcp-servers-run-in-a-per-session-tool-sandbox-in-deployments.md)
  — where a code tool runs in a deployment, its environment and its egress (D2, D3).
- [ADR-0117](0117-sandbox-egress-goes-through-one-allowlist-proxy.md) — the allowlist proxy.
