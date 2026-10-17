# W9-PROV-127 — The egress policy pins an address only where pinning cannot break TLS

Status: accepted
Date: 2026-09-11
Decided by: W9-PROV-127 (implementing agent)
Scope: `packages/core/src/net/egress-policy.ts`; every call site named on this task's card —
`apps/web/server/models/probe.ts` and `packages/gateway/src/providers/**`

## Context

`#127`'s Proposed Changes ask for one egress policy applied to every server-side provider fetch,
default-deny on loopback/RFC1918/RFC6598/link-local/unique-local/IPv4-mapped forms and cloud
metadata, HTTPS required, userinfo refused, redirects refused, and re-resolution at connection
time so a second DNS answer cannot substitute a different target — while forwarding no provider
credential across origins. The Wave 9 plan's card narrows this to one module,
`packages/core/src/net/egress-policy.ts`, applied at the probe and at each gateway adapter, with
an explicit `EGRESS_ALLOW_HOSTS` allowlist and a development-mode exception for the local fixture
servers this package's own tests already run.

Two implementation facts collide with "connects to the checked address, original Host preserved"
read as literal IP substitution:

1. **`Host` is on the Fetch spec's forbidden-header list.** A request built with
   `fetch(url, { headers: { Host: 'original' } })` sends the header the connection's own authority
   implies, not the one supplied — verified directly: a loopback fixture server receiving a
   request built this way logs the literal connection authority, never the supplied override.
   There is no way to keep an original hostname associated with a request whose URL has been
   rewritten to a raw IP, using the ordinary `fetch()` surface.
2. **Every existing provider and registry test supplies its own `fetch` double and asserts the
   exact URL string it was called with** (for example `registry.test.ts`'s
   `expect(request.mock.calls[0]?.[0]).toBe('http://localhost:9500/...')`). Rewriting the URL
   before handing it to that double would fail tests that are correctly checking something else
   entirely (header and body construction), for a security property that dependency-injected
   test never exercises a real socket to prove.
3. **Substituting a literal IP into an `https:` URL breaks certificate hostname validation** for
   every legitimate provider. Anthropic, OpenAI and Azure OpenAI serve certificates for their
   DNS name, not for their IP address; connecting to the IP directly makes Node's TLS stack
   validate the certificate against an identity no real certificate lists. Since HTTPS is the
   default-required scheme for every production call, an implementation that always pins would
   make the feature that closes an SSRF hole also close every legitimate provider call.

## Decision

`checkEgress(url, policy, resolve?)` is the pure decision: resolve the host once (skipped
entirely when the host is already a literal address), check **every** returned address against
the default-deny ranges, and refuse on the first match unless the exact hostname is on
`EGRESS_ALLOW_HOSTS`. It never rewrites anything and never touches a transport.

`guardedFetch(url, init, policy, transport = fetch, resolve?)` is what every call site uses
instead of calling `fetch` directly. It always issues the request with `redirect: 'error'`, so a
redirect is refused rather than followed regardless of scheme. Address pinning is conditional on
two things being simultaneously true:

- **the target is `http:`** — never `https:`, for the certificate reason above — and
- **`transport` is the real global `fetch`, checked by reference** — never a caller-supplied
  double, which every existing test supplies, and which represents "the wire request" from that
  test's point of view; there is nothing left to pin once a double stands in for the network.

When both hold, the URL handed to `fetch` has its hostname replaced with the address `checkEgress`
already validated, so `fetch`'s own internal DNS lookup for that request never runs — there is no
second answer left to substitute. This is exactly the case the loopback dev-fixture exception
exists for (`docs/operations/W9-PROV-127-egress-policy.md`), which is also what every fixture
server in this codebase's provider tests already is, and it is where `packages/core/src/net/
egress-policy.test.ts`'s `'connects to the checked address on the real transport, closing the
DNS-rebinding window'` test exercises it end-to-end against a real `node:http` server with an
injected two-answer resolver, asserting the resolver is called exactly once and the request never
reaches the second (blocked) answer.

For every other case — `https:` in production, or any caller-supplied test double regardless of
scheme — `guardedFetch` passes the original URL through unchanged. This is gap G-1 below, stated
rather than hidden: the real, credentialed, production traffic to Anthropic/OpenAI/Azure is
exactly the traffic this does **not** pin, because pinning it would break TLS.

## Alternatives considered

**A custom transport (an `undici` `Agent` with a `connect.lookup` override, or a hand-rolled
`node:https` client using `servername` for SNI) that pins the socket while leaving the URL and
`Host` untouched, for every scheme.** This is the technically complete answer — TLS would
validate against the real hostname while the TCP socket still connects to the checked address —
and was rejected for this task on three grounds. It requires a new runtime dependency (`undici`
is present only transitively today) or a hand-built request/response bridge reimplementing
streaming, headers, and abort-signal handling that `fetch` already gives every adapter for free.
It is the "per-connection socket-level hook" and "custom dispatcher" the card's own Deliberately
not built section names as out of scope. And it protects a call site permanently rather than per
request, which is a heavier claim than this task's four call sites need. Declared as gap G-1
instead of built.

**Rewrite the URL for every scheme and update the tests that would break.** Rejected: the tests
that would need rewriting are not testing this feature — `registry.test.ts` and the provider test
suites assert header, body, and URL-construction correctness that predates `#127` — and loosening
or rewriting a passing, correct assertion to make room for an unrelated feature is the "loosen a
matcher" the execution protocol forbids in spirit even when the literal matcher touched is not
the one guarding the regression.

**Leave DNS-rebinding entirely undefended (`checkEgress` only, no pinning anywhere) and call the
whole gap G-1.** Simpler, and defensible given the card's own gap language, but strictly weaker
than what the http/dev-loopback branch above buys at no extra cost or risk once the two
preconditions (`http:`, real transport) are made explicit — so the stronger, still-simple version
was built instead of the weaker one that was equally available.

## Consequences

- The only production traffic that is not literally pinned is HTTPS to a real provider — the
  traffic the policy most needs to protect, and the traffic pinning cannot touch without a
  heavier mechanism. `docs/operations/W9-PROV-127-egress-policy.md` and this task's PR body state
  this as gap G-1, not as complete DNS-rebinding immunity.
- No existing test asserting an exact URL string handed to a provider's own `fetch` double needed
  to change. `azure-openai.test.ts`'s one assertion of `init?.redirect` did change, from
  `'manual'` to `'error'`, because `guardedFetch` centralises redirect refusal and supersedes that
  adapter's own former `redirect: 'manual'` — a behavior change the feature requires, not a
  loosened assertion.
- Adding a fifth call site later (a future provider adapter, or a second probe-shaped function)
  gets the same policy for free by calling `guardedFetch` instead of `fetch`, but nothing enforces
  that at the type level — a call site that reaches for `fetch` directly is not caught by a gate.
  That absence is itself downstream of gap G-1: a generic dispatcher would close it structurally;
  this task's four call sites are updated by hand instead.
- `packages/core/package.json` and `packages/core/src/index.ts` were reserved on this task's Owns
  line for exactly this module; no new runtime dependency was needed (`node:dns/promises` and
  `node:net` are Node built-ins), so `package.json` did not change.

## Related

- `docs/operations/W9-PROV-127-egress-policy.md` — the operator-facing environment-variable
  reference (`NODE_ENV`, `EGRESS_ALLOW_HOSTS`) and the two declared gaps, G-1 and G-2.
- The Wave 9 plan's `W9-PROV-127` card — "Deliberately not built" already names the
  per-connection socket-level hook this ADR's G-1 restates with the reasoning behind it.
