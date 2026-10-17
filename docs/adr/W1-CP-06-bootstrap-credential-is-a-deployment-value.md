# W1-CP-06 — `BOOTSTRAP_ADMIN_PASSWORD` and `SESSION_SECRET` are deployment-level environment values

Status: accepted
Date: 2026-09-03
Decided by: W1-CP-06 (Control Plane)
Scope: `apps/web/server/auth/session.ts`; consumed by `apps/web/middleware.ts`.
Affects `.env.example` and `compose.yaml`, which belong to W1-INF-01.

## Context

Spec §21 permits exactly what this task builds: *"A local bootstrap administrator may be supported
for initial setup."* Spec §37 names the identity half of it — `BOOTSTRAP_ADMIN` is one of the four
example deployment-level environment values — and `packages/core/src/db/seed.ts` already reads it,
validates it as an email address and inserts that person as the workspace `owner`.

§37 names no secret half. There is no password column in the §27 schema, no credential table, and
W1-DB-01 did not add one. So the spec says who the administrator *is* and says nothing about how
they prove it.

§37 also says *"Avoid making users edit `.env` for normal application configuration"* and
*"Environment variables should primarily be for deployment-level values"*. A bootstrap credential
is not normal application configuration; it is the thing that exists before there is any
application configuration to edit.

## Decision

Two variables, both read only at the point of use, both fail-closed:

| Variable | Required | Rule |
| --- | --- | --- |
| `BOOTSTRAP_ADMIN` | yes | Existing (§37, and the seed's). Email-shaped; lower-cased to match the row the seed inserted. |
| `BOOTSTRAP_ADMIN_PASSWORD` | yes | New. At least 12 characters. Never stored, never hashed at rest, never written to the database — compared in constant time against what the caller typed. |
| `SESSION_SECRET` | yes | New. At least 32 characters. The HMAC key for the session token. |
| `WORKSPACE_SLUG` | no | Existing (the seed's). Defaults to `default`, in both places, from the same constant. |

**Absent, blank or too short is a hard failure that names the variable.** `readSessionSecret` and
`readBootstrapAdmin` return a named rejection; `signIn` refuses with `server_not_configured`; and
the middleware refuses *every* `/api/**` request with 401 and logs which variable is missing. There
is no development default, no generated fallback key and no "authentication is off when unset"
mode. That last one is the whole point: [ADR-0015](README.md) — a check that cannot run fails, and
"no credential configured" must never mean "every credential matches".

The reason string names the variable in the **server log**. The HTTP response carries only
`{"error":"unauthenticated","code":"server_not_configured"}`, so an anonymous caller learns that
the deployment is misconfigured and nothing about how.

## Alternatives rejected

- **Fold the secret into `BOOTSTRAP_ADMIN`** (`admin@example.com:password`). Keeps §37's list at
  four entries and breaks the seed, which parses the same variable as a bare email address. Two
  readers, one variable, different grammars — a bug waiting for the first colon in a password.
- **A one-time bootstrap token printed at start-up.** Better security posture, and more machinery
  than this task can land: storage for the used/unused flag, a rotation story, and a UI to consume
  it. The storage is the blocker and it is a *schema* one, not a client one — `apps/web` can reach
  Postgres through `@agent-workspace/core` on this base, but the §27 schema has no column or table
  to put the flag in, and the schema is W1-DB-01's.
- **Generate `SESSION_SECRET` at process start when unset.** Removes a variable and silently
  invalidates every session on restart and on every dev-server reload, and breaks the multi-replica
  `web` of §32 Cluster Mode. Worse, it converts a misconfiguration into behaviour that looks like
  it works.
- **Hash the password at rest with scrypt and store the hash in the environment.** There is nothing
  to store: the value is compared to what the operator configured, not to what a database holds.
  Adding a hash format would add a second accepted credential shape, i.e. a second way in, for no
  gain at this stage.

## Honest downside

**Neither variable is in `.env.example` or `compose.yaml`, because this task does not own those
files.** W1-INF-01 owns `.env.example` and its brief limits it to *"the four deployment values of
§37"*. So a `docker compose up` built from that file alone produces a deployment where every
`/api/**` request returns 401 and the server log says why. That is the correct behaviour for an
auth gate and a bad first-run experience, and it is a real coordination cost this record exists to
make visible: **W1-INF-01 must add `BOOTSTRAP_ADMIN_PASSWORD` and `SESSION_SECRET`** — or the
integrator must, and either way the §37 list is now six values rather than four. It is declared in
this task's PR as a gap rather than fixed by reaching into another task's file.

The second downside: one shared administrator password is a credential that cannot be attributed to
a person and cannot be rotated per user. That is inherent to a bootstrap administrator and is why
§21 makes OIDC the real answer (W6-CP-04) and four roles the real model (W2-CP-06).

**The third, found in verification round 1: rotating the credential does not end the sessions it
issued.** `verifySessionToken` checks that `sub` is a non-empty string; it does not compare `sub`
to whatever `BOOTSTRAP_ADMIN` currently says, and it cannot see `BOOTSTRAP_ADMIN_PASSWORD` at all,
because the password is never in the token and never in the MAC key. So an operator who changes
either variable after a session was issued has changed who can *sign in*, and has not touched the
cookie already in a browser: it stays valid until its own expiry, twelve hours after it was minted.
The only variable whose rotation is also a revocation is `SESSION_SECRET`, which invalidates every
session at once because it is the MAC key.

This is not the same statement as either of the gaps this PR already declared. "No sign-out route"
is about the holder ending their own session; "no key rotation" is about there being one key rather
than a key set. Neither says that a credential rotation leaves live sessions alone, which is the
thing an operator responding to a suspected leak actually needs to know. **The operating
instruction is therefore: to revoke, rotate `SESSION_SECRET`** — rotating `BOOTSTRAP_ADMIN` or
`BOOTSTRAP_ADMIN_PASSWORD` alone does not do it.

Fixing it properly means server-side session state — a revocation list, or a session row with a
version the token carries — and there is nowhere in the §27 schema to keep it. (Reaching Postgres
is not the obstacle: `apps/web` depends on `@agent-workspace/core` on this base. The obstacle is
that auth sessions have no table, and the schema belongs to W1-DB-01.) Fixing it cheaply, by
folding a hash of the password
into the MAC key, would tie every live session to a value §37 lets an operator change for unrelated
reasons and would make a password change silently log everyone out with no way to say why. Neither
belongs in this task; the real answer arrives with real accounts in W2-CP-06. What belongs here is
this paragraph, so the next reader does not have to rediscover it.
