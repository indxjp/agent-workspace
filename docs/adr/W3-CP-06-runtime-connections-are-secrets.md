# W3-CP-06 — A runtime connection is a secret, not a new table

Status: accepted
Date: 2026-09-06
Decided by: W3-CP-06 (runtime profiles CRUD and network-policy data)
Scope: `apps/web/server/runtimes/connections.ts`, `apps/web/app/api/runtime-connections/**`

## Context

§15.1 gives `RuntimeProfile` an optional `runtimeConnectionId`: *"Which stored runtime connection
(cluster, session pool, ECR image...) to use."* §14.9 states the resource's whole contract in one
sentence: *"A runtime connection exists — endpoint + credentials, stored as a secret."*
The Wave 3 plan's 3a-2 cell grants this task `apps/web/app/api/runtime-connections/**` and
names no new table for it, and no schema file for one appears anywhere in the cell's file-by-file
`Owns` list (unlike `runtime-profiles.ts`, `agents.ts`, and `index.ts`, which are named).

A runtime connection therefore has nowhere to live but the existing `secrets` table (§23), which
already stores an encrypted blob under a workspace-scoped id — precisely what "endpoint +
credentials" is once the two are held together as one value.

## Decision

1. **Endpoint and credential are sealed together as one secret value**, JSON-encoded
   (`{"endpoint": ..., "credential": ...}`), under `SecretsService.create`. Neither is ever
   returned by `GET /api/runtime-connections`, matching §23's own write-only rule for secrets
   generally.
2. **The driver is recovered from the secret's `name`, without decrypting.** `secrets.name` is a
   plain column (§23's write-only rule is about the *value*), so this module encodes `driver` and a
   label derived from the caller's `name` into it, behind a fixed prefix (`RUNTIME_CONNECTION__`).
   **Corrected at round 2 (W3-CP-06-B3):** this partitions by naming *convention*, not "by
   construction" as this record originally said — that phrase was measured false against a real
   PostgreSQL 17.11. `/api/secrets`'s own `parseSecretName` accepts the reserved prefix verbatim (it
   checks only `^[A-Z][A-Z0-9_]{0,127}$`), so a caller with secrets-create permission can
   `POST /api/secrets` a body named `RUNTIME_CONNECTION__DOCKER__FORGED` and it is admitted to
   `/api/runtime-connections`'s list as a connection; symmetrically, a genuine connection's encoded
   name appears, undecoded, in `/api/secrets`'s own list, because `listSecrets` filters nothing.
   Both directions require a change in `apps/web/server/secrets/**` (`parseSecretName` refusing the
   prefix; `listSecrets` filtering it) or a structural partition (a dedicated table, or a
   discriminator column `/api/secrets` cannot set) — outside this task's `Owns` glob either way, so
   this is a declared, carried gap rather than a fix shipped this round.
3. **The encoding is total (never throws) and not required to be injective** on the label half:
   every character outside `secrets.name`'s alphabet (`^[A-Z][A-Z0-9_]{0,127}$`) becomes `_`, so two
   different display names can collide into one encoded name. That is acceptable because the label
   is never decoded back — only the driver half is, and `connections.test.ts` proves that half's
   round trip for every §14.2 driver id, including ones containing hyphens (`cloud-run-sandbox`).
   A label that cannot be made to start with a letter after encoding (e.g. one consisting only of
   digits and punctuation) is refused as `name-conflict`, the same outcome a genuine duplicate name
   produces — both are "this name cannot be stored", and this route does not distinguish them by
   response shape, since either error tells the caller the same thing: choose a different name.
4. **`SecretsService.resolveByName` is never called from this route**, matching
   `apps/web/server/secrets/runtime.ts`'s own documented rule for the same method. `GET
   /api/runtime-connections` answers from `SecretsService.list`, which returns metadata only.

## Alternatives considered

* **A `runtime_connections` table**, storing `driver` and `endpoint` in plain columns and the
  credential alone as a secret reference. Rejected: not in this task's `Owns` cell (no schema file
  for it is named), and adding one would be the same "manifest edited at a level that did not ask
  for it" shape ADR-0038 and ADR-0041 forbid for dependencies, applied to a table instead — a
  second task later owning `runtime-connections` schema work would inherit a table nobody's cell
  granted this task to create.
* **Storing the whole connection, endpoint included, only in the encrypted value, with no way to
  list anything but existence.** This is closer to what shipped, but without the name encoding the
  list could show *that* a connection exists and nothing else — no driver — which would make
  §15.1's `runtimeConnectionId` picker unable to filter connections by the profile's own driver.
  The encoding is the minimum needed to keep that filter possible without decrypting.

## Consequences

* **Corrected at round 2 (W3-CP-06-B2):** a runtime connection's display name is *not* preserved.
  This record originally claimed the opposite — that `POST` and a later `GET` show the caller the
  same `name` field, so "no information is actually lost in practice" — and that was measured false
  against a real PostgreSQL 17.11: `POST` returned the caller's own name (`"Primary Docker host"`)
  while `GET` on the same row returned the encoded secret name
  (`"RUNTIME_CONNECTION__DOCKER__PRIMARY_DOCKER_HOST"`), and `GET`'s `createdAt` was a fabricated
  `new Date(0)` rather than the secret's own metadata. Both `create()` and `list()` now return the
  one value the store actually holds — the stored, encoded name and the secret's real `createdAt`,
  from both methods, in both the secrets-backed and in-memory implementations — because decoding the
  label back to the caller's original display string is not possible in general (`encodeSegment` is
  not injective: two different labels can encode to the same name). A future task building a richer
  connections UI reads a connection's name as the platform stores it, not as the operator typed it.
* `/api/runtime-connections` is declared with a `mandate` citing §14.9 in
  `tests/route-declarations/W3-CP-06.ts`, since §34 does not print it (ADR-0026).
* A future task building per-driver `driverConfig` validation or a richer connections UI reads this
  record before assuming a `runtime_connections` table exists — it does not, on purpose.
