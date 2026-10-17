# W3-RT-05 — the AgentCore aliases share their §14.3 handler, and the route table is data

Status: accepted
Date: 2026-09-06
Decided by: W3-RT-05 (the runtime image)
Scope: `apps/runner/src/server.ts`, `apps/runner/src/http-contract.ts`; informative for W3-CP-07,
which flips `/files` from `not_implemented` to `implemented` two levels below this one

## Context

Spec §14.3's alias table requires `POST /invocations` and `GET /ping` on port 8080 for Amazon
Bedrock AgentCore: *"Provider-required aliases live in the same server so that no separate image
is needed."* The spec does not say what either alias's response should look like beyond that — it
is not a new capability, it is a platform-mandated second name for a capability §14.3 already
defines: AgentCore invokes a container at `/invocations` and probes it at `/ping`, and this
repository's own equivalents are `POST /run` and `GET /healthz`.

Two shapes were available:

1. Two more branches in `server.ts`'s router, each with its own copy of the `/run` or `/healthz`
   logic (or a copy that calls into a shared inner function).
2. Literally the same branch matching both paths — `path === '/run' || path === '/invocations'`,
   `path === '/healthz' || path === '/ping'` — so there is exactly one code path per capability,
   with two names.

## Decision

Shape 2. `/invocations` and `/ping` are dispatched by the *same* `if` branch as `/run` and
`/healthz` respectively, not a second implementation. There is no `handleInvocations` or
`handlePing` function anywhere in this file. A method-not-allowed response names whichever path
the caller actually used (`sendMethodNotAllowed(res, path, 'POST')`), so `GET /invocations` and
`POST /ping` are each still refused with the path that was requested, not a canonical one.

This is the same judgment call `driver.ts`'s generic-seam ADR made for a different kind of
duplication (W1-RN-02): a required second name for one capability is a routing decision, not a
second capability, and giving it a second implementation is the thing that lets the two drift.

## The declared route table (`http-contract.ts`) is data, and the dispatcher is still hand-written

`apps/runner/src/http-contract.ts` holds `RUNTIME_HTTP_CONTRACT`: one entry per declared path,
naming its method, whether it is `'implemented'` or `'not_implemented'`, and (for an alias) which
§14.3 path it aliases. `server.ts` does **not** dispatch generically off this table — the five
endpoints do not share a call signature (`/run` reads a body and streams SSE; `/healthz` does
neither; `/interrupt` takes no body and returns once), and a table-driven dispatcher over that mix
would need a handler-signature union wide enough to hide the real difference between them. That
would be worse than the duplication it removes.

What the table *is* for: it is the one place that says which seven paths this build knows about
and which of them are 501, so `apps/runner/src/http-contract.test.ts` can compare it against
`docs/spec.md` §14.3 (parsed at test time, never transcribed — see that file's header) without
either side needing to also parse `server.ts`'s `if`-chain, and so `server.ts`'s own "no such
endpoint" / "not implemented" messages are generated from one list instead of typed twice (once in
the branch, once in the final `else`'s prose, which is exactly the kind of hand-maintained string
this plan's own "hand-written lists go stale" lesson warns about).

**"Parsed at test time" means every row of the alias table, not one row read out by name.** Round
1 shipped a parser that found the row containing the literal string `"AgentCore"` and read only
that line; its verifier built a tree that shows why that scope is wrong: a fourth alias row (a
provider nobody wired in) was silently accepted, a second row also naming AgentCore was ignored
because `Array.find` stops at the first match, and a correctly-added alias in a *different* row
was refused because the row carrying it was never read at all — failing both the way ADR-0015
calls fail-open and the way it calls fail-closed, from the same defect. The fix, watched failing
on all three trees before and passing after, is `parseAliasTableRoutes`: find the table by its own
header, walk every body row, and classify each one as either "carries concrete backtick-quoted
`METHOD /path` tokens" or "one of the two known prose rows that name no route of their own"
(`Azure Container Apps sessions`, `Kubernetes / Docker / ECS`) — a row that is neither throws,
naming the row, rather than being silently skipped.

## `/files` stays `not_implemented`, and this task does not touch it

The Wave 3 plan's 3a-2 cell is explicit that `/files` (both directions) is W3-CP-07's, two
levels below this one and gated on R-14: the content it would carry —
`apps/runner/src/files.ts`, `packages/runtime/src/transfer.ts` — does not exist in this
repository yet, and neither file is in this task's Owns globs. `RUNTIME_HTTP_CONTRACT` marks both
`/files` entries `'not_implemented'` and `http-contract.test.ts` asserts that set is *exactly*
`{ POST /files, GET /files }` — a fixed literal, not derived from the spec (§14.3 does not say
which of its own endpoints a given build implements). W3-CP-07 changes that literal when it lands
real handlers, and the point of stating it as a literal rather than deriving it is that the change
then shows up as a diff to a named assertion, not as an unobserved behaviour change landing under
an unrelated commit.

## Consequences

* One handler per capability, two route strings per handler for the two that have a
  platform-required alias. Adding a third alias to §14.3's table (in a row with concrete
  backtick-quoted tokens — see the parser note above) is a one-line addition to
  `RUNTIME_HTTP_CONTRACT`, a one-token change to the matching `if` condition in `server.ts`, and a
  one-line addition to each of `http-contract.test.ts`'s two intentionally-hand-written literals
  (the parsed-route-count list and the implemented-set list — both deliberately not derived, so
  that a route this build's set actually changed shows up as a diff to a *named* assertion rather
  than an unobserved behaviour change; see "the declared route table … is data" above and
  `http-contract.test.ts`'s own header). Not a new function, and not a change to the row
  classifier itself — verified by building exactly that tree and running the suite: 37/37 green,
  where round 1's narrower parser rejected the identical recipe with "declared in
  RUNTIME_HTTP_CONTRACT but not found in docs/spec.md §14.3".
* `http-contract.test.ts` is the only place that knows how to parse §14.3's fenced block and its
  alias table; `server.ts` never re-derives that set, it only imports the already-declared table.
* This ADR does not change `packages/runtime/src/driver.ts` or `types.ts` (W3-RT-01's, already
  widened and pinned by `packages/runtime/src/spec-transcription.test.ts`) — the AgentCore aliases
  are an HTTP-layer routing decision inside `apps/runner`, not a `RuntimeCapabilities` or
  `RuntimeDriver` concern.
