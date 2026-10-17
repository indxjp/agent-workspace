# W1-CP-06 — The session token is Web Crypto HMAC, not `jose`, because the lockfile is not this task's to open

Status: accepted
Date: 2026-09-03
Decided by: W1-CP-06 (Control Plane)
Scope: `apps/web/server/auth/session.ts`

## Context

Two rules apply to this task and they point in opposite directions.

- **Spec §40, restated in this task's brief**: *"anything cryptographic here uses a mature library.
  Do not hand-roll session signing, password hashing or CSRF protection."*
  `docs/dependency-policy.md` §1 repeats it: cryptography is one of the five categories where a
  mature library is *mandatory*, not merely permitted.
- **[ADR-0009](0009-pnpm-lock-ownership-exception.md)**: `pnpm-lock.yaml` is owned by the wave's
  first task. *"A later task in the same wave that needs a new dependency escalates rather than
  editing it in parallel."* W1-CP-06 is a later task in Wave 1. Its `Owns` globs are
  `apps/web/server/auth/**`, `apps/web/middleware.ts`, `tests/auth.test.ts` and
  `docs/adr/W1-CP-06-*.md`. Neither `pnpm-lock.yaml` nor `apps/web/package.json` is among them,
  and the file-ownership gate in CI fails a PR that touches a file outside its declared globs.

So the obvious implementation — `pnpm --filter @agent-workspace/web add jose`, or `iron-session`,
or `@node-rs/argon2` — is not available to this task. It is not a matter of preference: the PR
would fail CI on ownership before anyone read the code.

Earlier versions of this record added *"`apps/web` today depends on `next`, `react` and
`react-dom` and on nothing else. It cannot even import `@agent-workspace/core`."* That was true
against the old base and is **false** on this one: W1-DEP-01 added
`"@agent-workspace/core": "workspace:*"` to `apps/web/package.json`, and the sentence is withdrawn.
It never carried this decision — the reason a *new third-party* dependency is unavailable is the
lockfile rule above, and that rule is untouched by a workspace link that already exists. Adding
`jose` still means `pnpm --filter @agent-workspace/web add jose`, still means editing
`apps/web/package.json` and `pnpm-lock.yaml`, and still fails the ownership gate. What the
withdrawn sentence *was* load-bearing for is the tenant claim, and that decision has been re-taken
from the facts as they now stand in
[W1-CP-06 — the session carries the workspace slug](W1-CP-06-session-carries-the-workspace-slug.md).

## Decision

**Use the platform's Web Crypto implementation — `crypto.subtle.sign`, `crypto.subtle.verify`,
`crypto.getRandomValues` — and add no dependency.** The token is a fixed, non-negotiated
construction:

```text
aw1.<base64url(JSON claims)>.<base64url(HMAC-SHA-256 over "aw1.<payload>")>
```

Three properties are deliberate and each closes a class of attack that a JWT would have opened:

1. **There is no algorithm field.** The version tag `aw1` is a constant that must match exactly.
   `alg: none`, algorithm confusion and `kid`-injection have nothing to aim at.
2. **The MAC is checked before the payload is parsed.** No attacker-controlled JSON reaches
   `JSON.parse` on the strength of a bad signature.
3. **Nothing compares two secrets by hand.** `crypto.subtle.verify` *is* the constant-time
   comparison, which is why the signature check is written as a verify rather than as a
   sign-then-compare, and why the credential check in the same file MACs both strings and verifies
   rather than using `===`.

Web Crypto is a mature implementation by any reading of §40: it is the platform's, it is the same
OpenSSL/BoringSSL primitives a library would call, and it is present in both runtimes Next.js
middleware can run in, which a Node-only package is not.

## Alternatives rejected

- **Escalate and stop.** Correct by the letter of ADR-0009, and it would have delivered nothing:
  no gate, no tests, no evidence, and a blocked wave whose other five tasks all sit behind
  "unauthenticated request returns 401". An honest 80% beats a blocked 100%.
- **Edit `apps/web/package.json` and `pnpm-lock.yaml` anyway and declare it.** Fails the ownership
  gate mechanically, and ADR-0009 exists precisely because two tasks editing the lockfile in
  parallel is how a wave loses a day.
- **A random opaque session id with a server-side store.** Better in every way except the two that
  matter here. The §27 schema has no table an auth session could be written to — its `sessions`
  table is *"one conversation with one agent"* (`packages/core/src/db/schema/sessions.ts:2`), not
  a login. So the store would have to be process memory: it would not survive a restart or a
  second `web` replica, and Next.js
  middleware may run in an isolate that does not share memory with the route handlers. A stateless
  token has neither problem. (`apps/web` *can* reach Postgres through `@agent-workspace/core` on
  this base — that is not the obstacle; the missing table is, and adding one is W1-DB-01's schema
  to change, not this task's.)
- **Node's `crypto.createHmac` + `timingSafeEqual`.** Equivalent cryptographically and unavailable
  in the edge runtime, which would tie the gate to one Next.js middleware runtime setting.

## Honest downside

**This is a token format nobody outside this repository has reviewed.** A `jose` JWS would have had
years of adversarial attention on its parser; this one has a test file. The mitigation is that the
format is as small as a MAC'd token can be — the claims `SessionClaims` declares, one version
constant, no algorithm field and nothing to negotiate — and that every rejection path in
`verifySessionToken` is asserted in `tests/auth.test.ts`, including correctly-signed tokens whose
`exp` is absent or is a value that is not a finite number. That set exists because
[ADR-0015](README.md)'s named bug is exactly this shape: `NaN < Date.now()` is `false`, so an
unparsed expiry reads as "not expired" and the gate fails open.

Two counts written into the paragraph above when this PR was opened — "three fields" for the
payload and "eight" for the malformed-expiry tokens — were both wrong, and verification round 1
caught the second. Neither is replaced by a corrected number: [ADR-0016](README.md) says a
measured number does not live in prose. The invariant is stated here; `tests/auth.test.ts` names
the payloads and the run prints how many there were.

The second downside is that **key rotation is not implemented**. One `SESSION_SECRET`, one key;
changing it invalidates every session at once. A `kid` and a key set belong with the task that
owns real user accounts (W2-CP-06), and this file should be replaced by `jose` at that point, when
the lockfile is open again.

## What would reverse this

W2's schema task opening `pnpm-lock.yaml`. At that point: add `jose`, replace `mintSessionToken`
and `verifySessionToken` with `SignJWT`/`jwtVerify`, keep the cookie attributes and the classifier
exactly as they are, and keep every rejection test — they are written against the public functions,
not against the format.
