# ADR-0078 — Every request states its contracts version, and the edge refuses one it does not serve

Status: accepted
Date: 2026-09-29
Decided by: the implementer of SDK migration unit 12 (issue #244)
Scope: `packages/contracts/src/version.ts`; `apps/web/server/versioning/contracts-version.ts`;
`apps/web/proxy.ts`; `apps/web/lib/fetch-json.ts`; `packages/sdk/src/{http,errors,version}.ts`;
`packages/aw/src/{version,output,main,args,help}.ts`; spec `docs/sdk/04-api-specification.md` §4,
§7.3 and §8 row S-7; `docs/sdk/03-sdk-design.md` §3.3; the site's `concepts/public-surface.mdx`

## Context

A client learned it was out of date only when a `.strict()` response schema refused a field it did
not know (S-7), after the request had already run. Every package was `0.1.0` with no changelog and
no deprecation window (P-4). The developer platform's project CLI (#332, slice 0a) must refuse a
server whose contract version it does not support, naming both versions and the command that fixes
it, so the negotiation also has to be reusable outside the SDK's own transport.

## Decision

### D1 — The version and the rule are contracts

`CONTRACTS_VERSION` is exported from the root of `@agent-workspace/contracts` and equals its
`package.json` version (pinned by `packages/aw/src/version.test.ts`). The same module publishes the
header names, the two problem codes (`CONTRACTS_VERSION_PROBLEM_CODES`: `contracts_version_unsupported`
`426`, `contracts_version_malformed` `400`), a strict `MAJOR.MINOR.PATCH` parser, and
`judgeContractsVersion`. The rule is pure so the server, the SDK and any command line judge a
version identically. The two codes are kept out of `COMMON_PROBLEM_CODES`, whose key set is a
formal vector (`tests/formal/contracts-foundation.test.ts`); nothing formal changes.

### D2 — The range is compared on `major.minor`, inclusive, in both directions

A server serves `[minimum, current]`. A patch never changes the wire, so it is ignored. A client
older than `minimum` is refused with `upgrade: 'client'`; a client newer than `current` is refused
with `upgrade: 'server'`, because its strict decoders expect fields and routes that server does not
have. Both answer `426`: the status says "this client cannot be served as it is", and the body and
`upgrade` say which side moves. A present header that is not a version is `400
contracts_version_malformed`, not `426`, because nothing about it names a version to upgrade from.
RFC 9110 §15.5.22 requires an `Upgrade` header on a `426`, so the refusal carries
`Upgrade: agent-workspace-contracts/<current major.minor>`. It is informational — no connection
upgrade follows — and hop-by-hop, so an intermediary may drop it; the envelope and the range headers
are what a client reads. `426` was chosen over `400` or `412` because the request is well formed and
has no precondition that failed: the client's contract is the thing that must change.

### D3 — One place declares the range; the edge applies it first

`apps/web/server/versioning/contracts-version.ts` declares the range — its minimum is computed from
`CONTRACTS_VERSION` by the D7 rule (`minimumServedContractsVersion`) — and `apps/web/proxy.ts` runs the negotiation as the first step for every `/api/**` path —
before the pre-authentication exemptions, the API-key and browser-token allowlists, session
verification, the origin check, `authorise`, and any body read. So every route is covered, a new
route inherits it without a declaration, and a refused request touches nothing. The refusal is the
standard envelope `{ error: { code, message, detail } }` with `cache-control: no-store`; the message
names the client's version and the served range. Every `/api/**` answer the proxy produces — passed
through, refused by negotiation, or refused by the auth gate — carries
`X-Agent-Workspace-Contracts` (current) and `X-Agent-Workspace-Contracts-Minimum`, so any client can
read the range from any response. No route, RBAC row or route declaration changes, so the route
catalogue and `every_matrix_route_is_decided` are unaffected.

### D4 — A request without the header is always accepted, at the current version

Negotiation applies only to a client that declares a version. Several `/api/**` requests come from
the browser itself, which cannot add a custom header to them: the sign-in form
(`/api/auth/login`), the workspace switch form (`/api/auth/workspace`), the identity provider's
`form_post` to `/api/auth/callback`, and `<a href>` downloads under `/api/files/…` and
`/api/sessions/…`. Refusing a missing header would break sign-in, workspace switching and
downloads, and no browser signal separates those requests reliably from a script that simply omits
the header. So a request without the header is permanently accepted and served at the current
contracts version, and is not logged — it is normal traffic, not a deprecation. The SDK, `aw` and
`fetchJson` always send the header, so every client that can be refused is one that declared what
it was built against. An earlier draft of this ADR planned to refuse a missing header in the next
release; that plan is withdrawn for the reason above.

### D5 — The SDK raises a typed subclass, and exports the verdict for other tools

The SDK sets the header on every request after the caller's `headers` option, so it cannot be
overridden, including on the memoised workspace switch. A `426 contracts_version_unsupported`
becomes `ContractsVersionUnsupportedError`, a subclass of `ApiProblemError`: existing `status`/`code`
branches keep working, the error family stays three kinds, and `skew` adds `clientVersion`,
`serverVersion`, `servedMinimum` and `upgrade`, read from the served-range headers. It is `null`
when the `426` carries no readable served range — the headers are missing or unparsable — or one
that, by this client's reading, serves it: something between the client and the control plane
answered, or the two disagree. `null` does not mean "not the control plane". `readContractsVersionSkew(headers, clientVersion?)` is exported
for a tool with its own HTTP client — the project CLI of #332 — and returns the same verdict from
any response. `ContractViolationError` now carries and names `contractsVersion`.

### D6 — `aw` names both versions and the fix

`aw --version` prints `aw <version> (contracts <version>)` without reading configuration or the
network. A `ContractsVersionUnsupportedError` exits `1` (a refused request, as before) with
`error: contracts_version_unsupported: aw X was built against contracts A; the server serves
contracts M to C`, then `fix:` with the `npm install --global` of the `aw` package at C's `major.minor`. The package
name comes from one constant, `AW_PUBLISHED_PACKAGE` in `packages/aw/src/version.ts`, which is
`@indx-workspace/aw`: the Owner decided on 2026-09-29 (#246) that the `@agent-workspace` scope on
npm belongs to a third party, so the fix line never names it. #246 renames `package.json` to match. Because
`aw` is released in lock-step with the contracts (P-3), the `aw` of the server's minor is always
served. When the server is the older side the line offers upgrading the control plane first.

### D7 — Removals only in a major; the server serves the current and the previous minor

One rule, written the same way in 03 §3.3, 04 §4 and `concepts/public-surface.mdx`:

- **Additive changes are minor; removals and renames happen only in a major release.** A route,
  field, problem code or header is first deprecated in a minor — `@deprecated` in the contracts, a
  note in the reference and in each package's `CHANGELOG.md` — and removed in the next major, no
  earlier than one minor after the deprecating release.
- **The deprecating release stops depending on the item itself**: the SDK and `aw` move to the
  replacement, and a response field that will be removed becomes `.optional()` in the contracts.
- **The server serves its current minor and the previous minor of the same major.** At `X.0` it
  serves the last minor of the previous major instead, for that one minor; from `X.1` the minimum is
  `X.0`. Because of the previous rule, a client one minor behind — even across a major — never
  depends on what the server removed. `minimumServedContractsVersion` implements exactly this, with
  `PREVIOUS_MAJOR_LAST_MINOR` set by the release that starts a major, and never goes below the first
  released version: at `0.1.0` the minimum is `0.1.0`.

This rule supersedes ADR-0075 D1's one-release window for `detail`: the deprecated `detail` is removed only in the next major, no earlier than one minor after the deprecating release.

Each Consume package keeps a `CHANGELOG.md` with added, deprecated and removed per release. The
written policy is the "Versions and deprecation" section of `docs/sdk/site/concepts/public-surface.mdx`,
structured so the platform upgrade policy of the developer platform (slice 3f,
`docs/upgrade-policy.md`) can link to it rather than restate it.

## Consequences

- A client outside the served range gets one clear refusal before anything runs, instead of a
  contract violation after a write.
- The control plane's own SDK-backed screens and `fetchJson` send the header; the remaining raw
  `fetch` screens, forms and links do not, and are served at the current version (D4).
- The control plane's own UI sends the version of the bundle it was built with. During a rolling
  deploy or a revision traffic split across a minor bump (Cloud Run, Azure Container Apps), a page
  served by a new revision can reach an old one and be refused with `426` `upgrade: 'server'`.
  Mitigation: cut a minor release over to one revision at a time, or use session affinity; the UI
  should treat a `426` as "reload the page".
- The header is a custom request header, so a cross-origin browser call is preflighted. The
  control plane sets no CORS headers today; whatever change adds them must list
  `X-Agent-Workspace-Contracts` in `Access-Control-Allow-Headers` and expose the two response
  headers.
- The minimum moves only with `CONTRACTS_VERSION` (and `PREVIOUS_MAJOR_LAST_MINOR` at a major), so
  the served range is reviewed with the release that changes the version, in one file.

## Alternatives considered

- **Refuse only older clients, and let the SDK judge a newer one from the response.** Rejected: a
  write would already have happened by the time the client noticed.
- **Put the codes in `COMMON_PROBLEM_CODES`.** Rejected for this change: that table's key order is a
  formal vector, and version negotiation is a separate vocabulary with its own module.
- **A per-route check through `authorise`.** Rejected: it runs after authentication, misses the
  pre-authentication routes, and would need every route to opt in.
