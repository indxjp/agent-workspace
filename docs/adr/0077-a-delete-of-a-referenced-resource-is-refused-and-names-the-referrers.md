# ADR-0077 — A delete of a referenced resource is refused, and the refusal names the referrers

Status: accepted
Date: 2026-09-29
Decided by: the implementer of SDK unit 8 (SDK migration programme, tracker #232, issue #240)
Scope: `packages/contracts/src/problem.ts` (`IN_USE_REFERRER_KINDS`, `formatInUseReferrer`,
`parseInUseReferrers`); `packages/core/src/secrets/repository.ts` (`delete`);
`packages/core/src/db/repositories/resource-catalogs.ts` (`deleteSkill`);
`apps/web/server/secrets/**`, `apps/web/server/skills/{delete,pending-delete}.ts`,
`apps/web/app/api/secrets/[id]/route.ts`, `apps/web/app/api/skills/{route,[name]/route}.ts`,
`apps/web/server/connectors/handlers.ts` (`patchRefusal`)

## Context

Issue #240 adds the two deletes the catalog lacked — `DELETE /api/skills/:name` (S-12) and
`DELETE /api/secrets/:id` (S-10) — and the migration playbook asks for the rule "a delete of
something still in use" to be decided once for both. Phase 2 of the developer platform
(the developer-platform product and roadmap §5, §7) has `aw apply --prune` call these deletes
unattended, so whatever the rule is, it must be safe to run from a script that did not look first.

A skill is referenced by `agent_skills` rows; a secret by `mcp_servers.credential_secret_id` (a
`RESTRICT` foreign key) and by the model connection whose id its name encodes
(`MODEL_CONNECTION_<id>`, a naming convention until RF-204). Three answers were possible:

1. **Cascade.** `agent_skills` already cascades on the database side, so deleting a skill row would
   silently unassign it from every agent; a secret delete would have to null a connector's
   credential or delete the connector. Either way an agent or connector loses something it was
   configured with, and the next run fails far from the cause.
2. **Refuse with a bare `409`.** Safe, but the caller — a person or `aw apply --prune` — is left to
   rediscover what holds the reference.
3. **Refuse with a `409` that names every referrer.**

## Decision

### D1 — Refuse; never cascade, never orphan

A delete of a referenced resource is refused and nothing is deleted. The reference check and the
delete run in one PostgreSQL transaction that first locks the row (`SELECT … FOR UPDATE`), so a
reference created concurrently either commits first (and is reported) or waits on the lock and then
fails its foreign key. For secrets the `mcp_servers_credential_secret_workspace_fk` `RESTRICT`
stays as the backstop.

### D2 — One naming rule for the refusal

- The code is `<resource>_in_use` — `skill_in_use`, `secret_in_use` — with status `409`.
- `details` lists every referrer as `<kind>:<id>`, sorted by id within a kind; the kinds are
  `agent`, `connector` and `model-connection` (`IN_USE_REFERRER_KINDS`). A client reads them back
  with `parseInUseReferrers` rather than parsing prose.
- The envelope is the standard `ApiProblemSchema` one, built by the domain's own `problem()` helper.

### D3 — A delete across two stores is ordered to be recoverable

A skill's bytes live in the object store and its catalog row in PostgreSQL, and `GET /api/skills` /
`GET /api/skills/:name` upsert a catalog row for every skill whose platform record
`skill-meta/<name>.json` they find. The delete is therefore ordered around a pending-delete marker,
`skill-deletes/<name>.json`, which records the row's owner:

1. The marker is written first. While it exists, the read routes' catalog sync never inserts a row
   for the name: an existing row still answers with its id, and a skill with no row left is not
   listed and reads as `404`. Nothing can resurrect the row or make the reader its owner.
2. The catalog row goes in D1's transaction. A `409 skill_in_use` removes the marker again and
   changes nothing else.
3. The files go, then the platform record. The row is swept once more — a sync that read the
   platform record before the marker existed may have inserted one — and the marker goes last. A
   sync that inserts a row checks afterwards that the platform record still exists and no delete
   has started, and removes the row it inserted otherwise; with the sweep, no sync leaves a row
   behind a delete.

A delete interrupted anywhere after step 1 leaves the marker, and a retried `DELETE` finishes it.
Once the row is gone, the route's ownership check reads the owner from the marker, so the owning
Builder — not only an Owner — can finish their own delete, and another Builder still gets `403`.
A delete that stopped after its catalog step with no marker (a state only a delete from before
this rule can leave) reads the owner as unknown, so only an Owner can finish it.

Not covered: a `PATCH` of the same skill, or a new import under the same name, that runs while the
delete is in flight (tracked as a follow-up of #240).

### D4 — Deletes are authorise-gated through the shared decision table

Both routes call `requireResourceAccess` before touching a row. Secrets are Owner-only in the table,
so every other role is `403` whether or not the id exists; an Owner naming another workspace's id
gets the same `404 secret_not_found` as for an id that never existed. Skills follow the existing
`skills` cells: a Builder deletes only a skill it owns; Admin and Viewer have no skills grant.

### D5 — A saved connector credential never follows the connector to a new destination

`connectors: MANAGE` lets an Admin edit any member's connector, but secrets are Owner-only. The
`PATCH /api/connectors/:id` field update (S-20) keeps the saved credential when a body does not
send one, so without a rule an Admin could change a Builder's `url` — or `command`/`args` of a
`stdio` connector, whose process receives the credential as `MCP_CREDENTIAL` — to a server of their
own, and the next test-connection or run would send the Builder's credential there.

When the connector has a saved credential and the patch changes `url`, `command` or `args` to a
different value, the same body must carry a new `credential`; otherwise the patch is refused with
`409 credential_required_on_retarget` in the standard envelope and nothing changes. These are the
only destination fields: the header or environment variable the credential travels in is fixed
by `(transport, authType)`, a caller cannot set a header or an environment variable, and the
transport cannot change. A patch that switches `authType` to `none` drops the credential and needs
none; a connector with no credential can be retargeted freely.

A patch that carries a `credential` never rotates the saved secret in place. The store seals the
new value as a fresh secret, then changes the destination fields and the secret reference in one
row update, and deletes the fresh secret again if that update throws or does not land. Only after
the row names the fresh secret is the old secret deleted. A failure at any step therefore leaves
either the old destination with the old credential or the new destination with the new one, never
the new destination with the old credential. A failure deleting the old secret does not roll the
connector back: the request succeeds, the orphaned secret is logged by id (never by value), and an
Owner removes it with `DELETE /api/secrets/:id`.

## Consequences

- `aw apply --prune` can call either delete blindly: the worst outcome is a `409` that lists what
  to unassign first.
- A second delete of the same resource is `404`, as for connectors; the deletes are not idempotent
  in status, only in effect.
- The model-connection reference is found by the name convention. When RF-204 replaces the
  convention with a foreign key, the query changes and the rule does not.
