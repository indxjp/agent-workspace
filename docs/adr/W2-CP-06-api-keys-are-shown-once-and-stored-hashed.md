# W2-CP-06 — API keys: shown once, stored as one unsalted SHA-256, and where this deviates from R-12

Status: accepted
Date: 2026-09-05
Scope: `apps/web/server/rbac/api-key.ts`, `apps/web/app/api/api-keys/**`; spec §22
Task: W2-CP-06 · Spec: §22 · Research: research note R-12 §1.1–§1.5

## Context

§22's requirements are two sentences —

> Show the raw secret only once.

> Store only a secure hash.

— plus a printed example that fixes the display prefix `ak_live_` and a field list that contains
`name`, `workspace`, `permissions`, `created_at`, `last_used_at`, `expires_at`, `revoked_at`.

R-12 answers everything §22 leaves open, with measurements rather than argument, and this task
follows R-12 over instinct. This ADR does not restate R-12; it records the three places where an
implementation decision was still required, and the one place where the shipped code differs from
R-12's recommendation.

## Decision 1 — the format and the parser are R-12 §1.4's, unchanged

```text
ak_live_<key_id>_<secret>
         │        └─ 32 random bytes, base64url, 43 characters (256 bits)
         └────────── 16 random bytes, base64url, 22 characters — public, stored in clear
```

The parse is the anchored fixed-length regular expression, **not** a `split('_')`. This is not a
stylistic preference: `_` is inside base64url's alphabet, and R-12 §1.4 measured a `split('_')`
parser requiring four parts rejecting 63 177 of 100 000 freshly minted keys — and rejecting them
*silently*, as a 401 indistinguishable from a wrong key.

`apps/web/server/rbac/api-key.ts` builds the pattern from the two byte counts rather than typing the
lengths out, so a change to either moves the parser with it instead of leaving a literal that
rejects every key. `mintApiKey` parses what it just minted and throws if it cannot, so a drift
between the format and the pattern fails at the point of the change rather than at every
authentication afterwards.

## Decision 2 — the hash is unsalted SHA-256, and the reasons are numbers

R-12 §1.2 and §1.3, in short: a per-row salt makes the stored value uncomputable until the row is
known, so the column cannot serve an equality lookup — `EXPLAIN (ANALYZE)` on PostgreSQL 17 over
100 000 keys reported a sequential scan removing all 100 000 rows by filter at 45 ms with `sha256()`
standing in for the KDF, and the same plan with PBKDF2 is ≈105 minutes of CPU **per request**. A slow
KDF on this path is also attacker-aimed CPU, because verification runs before authentication
succeeds. With 256 bits of uniform entropy there is nothing for a work factor to buy.

A pepper (`HMAC-SHA-256(master_key, secret)`) stays indexable and costs 0.0150 ms/op measured, so it
is viable and is **not** adopted for Wave 2 for R-12 §1.3's reasons: it makes `api_keys` unreadable
without §23's master key and adds a key-rotation procedure with no migration path. It remains a
cheap later upgrade if W2-CP-02 ships a key hierarchy.

## Decision 3 — the digest is stored as lower-case hex, which is where this deviates from R-12

R-12 §1.3 recommends *"stored as `bytea` (32 bytes)"*. The column that landed in sub-wave 2a is
`text`:

```ts
keyHash: text('key_hash').notNull(),
```

`packages/core/src/db/schema/api-keys.ts` is W2-DB-01's file and is outside this task's `Owns` globs,
so the column cannot be changed here. **Decision: lower-case hex into the `text` column.** Hex is
deterministic, indexable and unambiguous, which is what the recommendation was for; the difference
is an encoding, not a scheme. It is recorded here rather than left as a silent divergence from the
research note, and the change to `bytea` — if anyone wants it — is a migration owned by whoever owns
that schema file.

## Decision 4 — presentation once is proved on three surfaces, not asserted on one

The acceptance criterion asks for the half that is usually skipped: *"a test that reads the row back
and asserts the plaintext is unreachable, and a test that a second read of the creation endpoint does
not re-reveal it."* `apps/web/server/rbac/api-keys.test.ts` proves three things, each over a
different surface:

1. **the row** — the stored record is read back through the port, its digest is asserted **equal** to
   `SHA-256` of the secret half (a positive assertion, not an absence), and every field of the row is
   checked for containing the plaintext or its secret half;
2. **the creation endpoint, read again** — `GET /api/api-keys` on the same path the `201` came from,
   twice, scanned for the plaintext, and asserted to still contain the key's *prefix*, so the scan
   cannot pass by the row having vanished;
3. **every response the suite produced** — R-12 §1.5's method: the harness records every response
   body and the plaintext must appear in exactly **one** of them, the `201`. This is the assertion
   that would catch a future route learning to re-reveal a key, which neither of the first two would.

The response type a list route can return, `ApiKeySummary`, has nowhere to put a secret. That is a
type-level version of the same promise, and it is why "does not re-reveal" is a property of the shape
rather than of the handler remembering to redact.

## Decision 5 — a revoked, an expired and an unknown key are one answer

The authenticator's rejections are all the same `null`, and the route's answer is the same `401`.
R-12 §1.5: the three are already one SQL query returning zero rows, and distinguishing them requires
a second query whose only purpose is to tell an attacker which of their guesses was once real.
Revocation writes `revoked_at` rather than deleting the row — §22 lists the column, §36 wants the
action auditable, and a nullable timestamp that can be set back to `NULL` is a resurrection path.

## What is not built

The durable store. `apps/web/server/rbac/directory.ts` is a port and
`apps/web/server/rbac/memory-directory.ts` is an in-memory implementation of it; there is no
PostgreSQL implementation, because a repository for `users`, `memberships` and `api_keys` belongs in
`packages/core/src/db/repositories/**` (W2-DB-02's), the `@agent-workspace/core/db` barrel
deliberately exports no queryable handle, and reaching around it would reopen the tenant-isolation
bypass sub-wave 2a closed. The port is shaped exactly like the repository layer's so that the
translation is a translation. This is declared in this task's PR as a gap, with the file that has to
change named.
