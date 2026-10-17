# W1-CP-04b — The acceptance harness authenticates with a real, validly-signed session cookie, not none at all

Status: accepted
Date: 2026-09-03
Decided by: W1-CP-04b (Control Plane)
Scope: `apps/web/server/runs/acceptance/run-acceptance.mjs`, `apps/web/server/runs/acceptance/README.md`;
binding on anyone who edits `apps/web/server/auth/session.ts`'s exported names or
`apps/web/server/runs/acceptance/nginx.conf`'s `Host` forwarding

## Context

`run-acceptance.mjs` was written and landed under W1-CP-04, before W1-CP-06's global auth
middleware existed. Every `fetch()` it made was cookie-less by construction, because there was no
cookie to send yet. W1-CP-06 later landed `apps/web/middleware.ts`, which denies every `/api/**`
request that carries no session cookie verifying under `SESSION_SECRET`
(`docs/adr/W1-CP-06-the-gate-covers-api-only.md`) — a change entirely correct on its own terms,
made by a task that had no reason to know a probe fixture existed that would stop working the
moment it merged.

The result was not a failing assertion; it was **no assertion running at all**. The harness's own
readiness probe (`GET /api/runs/not-a-uuid`, expecting 400) got 401 instead, timed out its
`waitFor`, and the script aborted before nginx, the SSE stream, or the reconnect were ever
exercised. The original W1-CP-04 PR's acceptance evidence was therefore never actually producible
against the merged tree — the exact shape ADR-0015 names: a gate that reads as passing because the
input it needed (a request that could fail the thing it checks) was never supplied, not because
the thing it checks was verified. Independent confirmation that the SSE mechanism itself is sound:
patching only the probe's `fetch()` calls with a signed cookie, with nothing else changed, was
enough to get past 401.

Two more blockers surfaced only by actually running the fixed harness end to end, both from code
that landed on this branch's base *after* the harness was authored:

1. **`apps/web/instrumentation.ts` now exists.** W1-COMP-01 landed the real composition root at
   that exact path — the path the harness's own comments describe as "outside W1-CP-04's ownership
   globs and therefore must not be committed", true when written, false on this branch's base
   today. The harness's guard was "abort if the file is already there", written to protect a
   concurrent session's uncommitted work; against a committed file it does the same thing every
   single run, forever, having nothing to do with a concurrent write.
2. **nginx's own `Host $host` strips the port**, on both `/stock/` and `/tuned/`. The app never
   sees the client-facing proxy port (`8099`) in either `nextUrl.host` or the forwarded `Host`
   header, measured from the 403 `checkRequestOrigin` produced: `Origin host "127.0.0.1:8099" is
   none of "localhost:3111", "127.0.0.1"`. An `Origin` header built from the address the probe
   itself calls (`http://127.0.0.1:8099`) is therefore not "matching" — it is refused by the same
   host-only comparison `server/auth/origin.ts`'s own module comment says exists precisely for a
   reverse proxy whose public and upstream addresses differ.

## Decision

**1. Mint one session token per run, with the real signing function.** `run-acceptance.mjs` now
imports `mintSessionToken`, `newSessionClaims`, `readSessionSecret` and `SESSION_COOKIE_NAME`
directly from `../../auth/session.ts`. Node 24 strips TypeScript types natively and that module
imports nothing else (`docs/adr/W1-CP-06-auth-modules-are-standalone-es-modules.md`), so the import
resolves with no build step and no bundler. A probe that reimplemented the HMAC scheme could pass
against a bug the two implementations happen to share; importing the authority itself cannot.

**2. Every `fetch()` the script makes carries the cookie and a same-host `Origin`.** One
`authHeaders(origin, extra)` helper is the single place that attaches both, used by the direct
`next start` readiness probe, the nginx readiness probe, both SSE connections, the run-creation
`POST`, and the final `GET /api/runs/:id`. Uniform on every call rather than only the unsafe
methods `checkRequestOrigin` actually requires it for, so a future assertion added to a safe-method
call does not silently regain the auth gap this ADR closes.

**3. The `Origin` sent through nginx is `http://127.0.0.1` — no port.** Not the address the probe
calls (`http://127.0.0.1:8099`): measured, that address is in neither `nextUrl.host` nor the
`Host` header nginx actually forwards for either location in `nginx.conf`, both of which read
`proxy_set_header Host $host;`. This is not a workaround for a broken check; it is the genuinely
matching value for this deployment shape, which is exactly the shape `origin.ts` names as its
reason to compare host-only rather than full-origin.

**4. `apps/web/instrumentation.ts` is saved and restored, not existence-checked and aborted.**
Whatever bytes are on disk when the harness reaches step 2 — the real composition root on a base
that has W1-COMP-01, nothing at all on one that doesn't, or a concurrent session's uncommitted work
either way — are read into memory before the harness's own temporary re-export is written, and
written back verbatim in the `finally`, in place of the previous unconditional `rmSync`. Absence
is still handled the same way it always was (delete the temporary file, leave nothing behind).

## Alternatives considered

* **Reimplement the cookie's HMAC in the probe.** Rejected for the reason `stream()`'s own comment
  gives for writing an independent SSE parser, pointed the opposite direction: here the goal is to
  prove the request the *real* middleware accepts, so importing the real signer is the only version
  of this fix that cannot pass by accident.
* **Have the harness generate and export its own `SESSION_SECRET`.** Rejected: the ACCEPT
  criterion supplies `SESSION_SECRET` from the environment specifically so the evidence is produced
  against a secret the deployment configures, matching how `next start` receives it a few lines
  later in the same script.
* **Widen `checkRequestOrigin` to ignore port, or teach it about this proxy's port.** Out of scope
  and the wrong file: `server/auth/origin.ts` belongs to W1-CP-06, is already host-only by design,
  and the harness adapting to the real deployed behavior is the correct direction of fix, not the
  other way around.
* **Add `proxy_set_header X-Forwarded-Host $http_host;` to `/stock/` in `nginx.conf`.** Rejected
  for that location specifically: its whole documented purpose is proxying at nginx's own
  defaults, unmodified beyond what SSE strictly requires, and adding a header nobody configures by
  default would make a pass there mean less, not more.
* **Keep the existence-check-and-abort for `instrumentation.ts` and delete the file, expecting
  W1-COMP-01's build step to regenerate it.** Rejected: nothing regenerates a deleted source file,
  and a hard-killed harness run would leave another task's committed file permanently gone from the
  working tree with no run-acceptance.mjs process left to blame it on.

## Consequences

* `run-acceptance.mjs` now has a runtime dependency on `apps/web/server/auth/session.ts`'s exported
  names (`SESSION_COOKIE_NAME`, `mintSessionToken`, `newSessionClaims`, `readSessionSecret`). A
  rename or signature change there breaks this harness loudly, at import time, rather than the
  harness quietly minting a token nothing downstream recognizes.
* The save-and-restore of `apps/web/instrumentation.ts` is a `finally`, not a guarantee: a hard
  kill (`SIGKILL`, or Windows `taskkill /F` without going through the script's own `killTree`)
  still leaves the harness's temporary stub on disk, same as the previous unconditional delete did
  for a run that never existed before it. `README.md`'s "If a run is killed hard" note is updated
  to say restore from git rather than delete.
* `NGINX_ORIGIN`'s port-less value is coupled to `nginx.conf`'s `Host $host` line. Both files are
  in this task's `Owns` glob, but if a later task adds `X-Forwarded-Host` to either location, this
  constant should be revisited alongside it rather than left as a stale workaround for a proxy
  behavior that no longer exists.
* The harness's own README claim that "the harness authenticates every request" described only the
  acceptance-mode route-level stub (`instrumentation.ts` in this directory, whose `authenticate()`
  always returns the same fixed principal once a request reaches it) and never described the global
  gate in front of it. `README.md` is corrected to say both are true: the middleware now demands a
  genuine signature, and the stub behind it still authorizes unconditionally once that gate is
  cleared.
