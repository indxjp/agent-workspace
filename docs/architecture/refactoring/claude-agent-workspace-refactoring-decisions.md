# Claude Agent Workspace refactoring decision ledger

Status: safe defaults recorded for RF-001; product ratification remains open.

This ledger makes the unresolved product questions in the
[refactoring plan](claude-agent-workspace-refactoring-plan.md) explicit before any schema or
runtime cutover. The entries below are conservative implementation defaults, not silent product
policy. A later decision may replace a default, but the owning refactoring unit must then document
the compatibility and migration consequences before changing behavior.

## Product defaults

| Decision                                                                  | Safe default in force                                                                                                                                                                                                                     | Why this is safe now                                                                                                   | Ratification owner     | First blocking unit                                                                                            |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| Project-level model defaults despite `docs/spec.md` section 20.5.2 rule 5 | Preserve the current workspace/project/agent/run resolution behavior, mark the specification mismatch, and do not add another project model capability.                                                                                   | Removing an existing setting would be a behavior and data migration; preserving it does not widen access.              | Product + architecture | No existing RF owner; Product + architecture must assign ownership before RF-401/RF-502 changes this contract. |
| API keys creating durable Sessions                                        | Permit this only after a machine `WorkspacePrincipal` can own the Session explicitly. Until then, an API key must not borrow a human owner for an own-scoped operation.                                                                   | It prevents machine activity from being authorized or attributed as the oldest human Owner.                            | Product + security     | RF-101 and RF-301                                                                                              |
| Run, transcript, and audit retention/legal hold                           | Retain indefinitely, expose archive rather than purge, and do not schedule automatic deletion.                                                                                                                                            | Keeping evidence is reversible; deleting it before a retention decision is not.                                        | Product + compliance   | RF-201 purge design                                                                                            |
| Runnable public links                                                     | Keep the release gate permanently false. Definition and snapshot rendering may remain, but anonymous execution must not be enabled.                                                                                                       | It avoids anonymous spend and execution exposure while provenance, limits, and recovery remain incomplete.             | Product + security     | No existing RF owner; Product + security must define a scoped unit before the release gate can change.         |
| Invitation email delivery                                                 | Keep manual copy-link delivery as a supported adapter and complete the acceptance/rejection journey independently.                                                                                                                        | Acceptance correctness does not depend on selecting or operating an email provider.                                    | Product + operations   | RF-203                                                                                                         |
| Persisted Run `waiting`/`suspended` state                                 | Persist no live wait: `waiting` and `suspended` stay unadded. A stopped, non-final state may exist only under an accepted ADR that names its exits and deadline and holds nothing; `awaiting_approval` is the first (ADR-0145, ADR-0151). | A speculative durable state would create transition, recovery, and compatibility obligations with no current producer. | Product + runtime      | RF-301                                                                                                         |

## Stable Problems reserved by the refactoring plan

These codes name expected caller-correctable failures. Recording them here prevents later units
from exposing raw database, provider, filesystem, URL, or credential-bearing messages while the
wire contracts are still being designed.

| Code                            | Owning unit | Emitted today | Meaning                                                                                            |
| ------------------------------- | ----------- | ------------- | -------------------------------------------------------------------------------------------------- |
| `machine_ownership_unsupported` | RF-101      | No            | A machine caller reached an own-scoped operation before a machine principal can own the resource.  |
| `connector_not_found`           | RF-102      | Yes           | The requested connector is absent or concealed from the caller.                                    |
| `invalid_share`                 | RF-103      | Yes           | The publish command is malformed, including caller-authored authoritative content.                 |
| `runner_unauthenticated`        | RF-104      | No            | A private runner control request has no acceptable service credential.                             |
| `agent_archived`                | RF-201      | No            | A new execution was requested from an archived Agent.                                              |
| `membership_in_use`             | RF-202      | No            | Conservative membership removal cannot proceed without resolving reported dependencies.            |
| `invitation_unavailable`        | RF-203      | No            | An invitation is absent, mismatched, expired, revoked, or otherwise concealed from the caller.     |
| `credential_ownership_invalid`  | RF-204      | No            | A credential has no valid same-workspace owner/purpose relationship.                               |
| `run_idempotency_conflict`      | RF-301      | No            | An idempotency key was reused with a different immutable request.                                  |
| `run_transition_conflict`       | RF-301      | No            | A stale or illegal Run transition was refused.                                                     |
| `runtime_allocation_conflict`   | RF-302      | No            | An allocation generation or ownership precondition failed.                                         |
| `storage_operation_conflict`    | RF-304      | No            | An object/catalog precondition changed while a durable storage operation was pending.              |
| `composer_projection_stale`     | RF-502      | No            | Submitted resource ids are no longer available in the authorized projection and must be refreshed. |

`connector_not_found` and `invalid_share` are existing production codes whose use is widened and
standardized by RF-102 and RF-103. Every other code in the table is reserved but not yet emitted.

The owning unit may refine status mapping or split a code only when a caller has a distinct recovery
action. Infrastructure and programming failures remain observable 5xx responses and never reuse
these codes.

## RF-001 characterization register

Expected-failure tests carry the owning RF id in their title. They are intentionally green only
while the target invariant still fails: once an implementation makes the assertion pass, Vitest
reports an unexpected pass and the owning unit must convert or replace the test with a normal
regression test. `tests/refactoring-characterization-register.test.ts` mechanically verifies that
every tracked `it.fails` title names exactly one RF owner and that the set of owners matches this
register's `Expires in` column. When the owning RF converts or removes an expected failure, the
same change must update the ordinary guard in that test's `describe` block.

| Current gap                                                                                                                                           | Characterization                                                                                                            | Expires in |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Publish accepts `subjectLabel`, `snapshot`, and `definition` as authoritative caller input (a `transcript` chooses runs the server copies, ADR-0158). | Share request contract rejects each authoritative field.                                                                    | RF-103     |
| Agent deletion cascades through Session execution history.                                                                                            | PostgreSQL refuses the delete and retains Session, Run, event, transcript, message, usage, and share-charge counts.         | RF-201     |
| Membership deletion discovers Session dependencies as a raw constraint failure.                                                                       | Removal returns typed `membership_in_use` with dependency counts.                                                           | RF-202     |
| Composer server mapping discards assigned Files/Connectors and fetches an unused model list.                                                          | Projection supplies assignments and has no unused model-connections prop/query.                                             | RF-502     |
| A grant path normalises to a drive-shaped path (`x/../C:/y` to `C:/y`) that reads back as absolute.                                                   | `normaliseGrantPath` refuses `x/../C:/y`; no RF unit owns path grants, so RF-001 holds it until one is assigned.            | RF-001     |
| Agent instructions ending in a line break change on a Claude Managed Agents compile/import round trip.                                                | Compile then import keeps the trailing line break of `Answer briefly.`; no RF unit owns the translator, so RF-001 holds it. | RF-001     |

The other P0/P1 units deliberately have no RF-001 expected-failure row:

| Unit   | Existing invariant test or deferral reason                                                                                                                                                                                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RF-002 | `packages/core/src/db/repositories/session-migration.test.ts` exercises the service-backed migration invariant; nondeterministic teardown diagnosis is deferred to its stress/instrumentation unit.                                                                                      |
| RF-104 | `apps/runner/src/manager.test.ts` pins the manager's bearer 401, while `apps/runner/src/server.test.ts` still succeeds against the fixed runner without credentials; RF-104 adds signed, request-bound, expiring, and rotatable service-token semantics.                                 |
| RF-203 | `apps/web/server/invitations/lifecycle.test.ts` covers the current backend lifecycle; the identity-bound accept/reject journey waits for RF-101 and RF-202 semantics.                                                                                                                    |
| RF-204 | `apps/web/server/runtimes/connections.test.ts` characterizes forged reserved-name ownership; typed-FK and wrong-purpose/cross-tenant database tests wait for RF-204's schema.                                                                                                            |
| RF-301 | `apps/web/server/runs/store.test.ts` runs the current memory/PostgreSQL terminal-transition conformance; only the new idempotency-key, lease, version, claim, and `RunAttempt` contracts wait for RF-301.                                                                                |
| RF-302 | `apps/runner/src/manager.test.ts` and `apps/web/server/compose/runtime-manager-client.test.ts` cover current process-local allocation and scoped client behavior; durable authority, restart, and reconciliation tests wait for RF-302.                                                  |
| RF-303 | `apps/web/server/runs/api.test.ts` (`RF-303 answers 202 for a persisted run whose process-local launch handoff threw`) replaced the expected failure once ADR-0151 option A made the committed run row the acceptance; recoverable-worker lease and restart tests still wait for RF-303. |
| RF-304 | `apps/web/server/files/subtree.test.ts` covers subtree failure injection, partial results, and clean retry; durable `StorageOperation` process-death/restart tests wait for RF-304.                                                                                                      |
| RF-501 | `apps/web/lib/fetch-json.test.ts` covers the existing parsed-fetch boundary; RF-501 will extend that normal invariant rather than invert it.                                                                                                                                             |
| RF-504 | `tests/browser/team-invitations.spec.mjs` characterizes the emitted invitation link and current issuer journey; only the missing prerequisite-dependent accept/reject and other corrected journeys wait for RF-504.                                                                      |

## RF-002 PostgreSQL teardown finding

RF-002 confirmed the observed `57P01` as test infrastructure behavior, not a product database
defect. Two composition-root integration suites opened a second `DatabaseRoot` through
`register()` but intentionally left it alive, static isolated-database names could collide across
concurrent test processes, and teardown could force-drop a database or remove a container while a
client was still reachable. That could terminate the client and emit a late unhandled driver error
after the assertions had passed.

The RF-002 invariant is now executable: each helper call creates a readable collision-resistant
database name, tags connections, closes its owned pool, inspects `pg_stat_activity`, normally drops
only after proving zero sessions, and uses bounded forced cleanup only to remove diagnosed leaked
state. Diagnostics expose only safe application/state metadata and SQLSTATE codes; connection URLs,
credentials, and query text are redacted. Composition integration tests explicitly close the handle
returned by `register()` before dropping their database, and the service harness requires fatal
unhandled rejections. On a green run where the harness created PostgreSQL itself, it waits for the
Vitest process to terminate and verifies through `pg_stat_activity` that the owned container has no
client backends before removal. The probe does not run when CI supplies `TEST_DATABASE_URL`, or on
a red run where preserving the test failure takes precedence. Waiting for the child's `close`
event is retained as belt-and-braces lifecycle handling; it does not itself drain inherited stdio
or prove database quiescence. Process termination plus the successful PostgreSQL activity probe
provide that evidence.

## Migration fixture inventory

RF-001 fixtures use synthetic identifiers and non-secret values. They cover:

- two human Memberships and legacy rows whose `created_by` values reference the fixture Owner;
- one unused Agent and one Agent with installed Session, Run, RunEvent, transcript, message, usage,
  Share, and ShareRunCharge rows;
- a departing member referenced by the installed active Session;
- a ModelConnection plus synthetic Secret rows using the installed legacy model/runtime naming
  conventions;
- one File catalog row plus a returned synthetic object-key mismatch descriptor. The database
  fixture does not install object-store state.

`RuntimeAllocation` and `StorageOperation` rows cannot be fixtures before RF-302 and RF-304 add
their tables. The fixture reserves those cases by name and records their prerequisite; it does not
invent a production schema in RF-001.

## Observability names reserved, not emitted

- `principal_ownership_ambiguous_total`
- `authorization_decision_divergence_total`
- `share_projection_mismatch_total`
- `runner_service_auth_total`
- `run_lease_recovery_total`
- `runtime_allocation_reconciliation_total`
- `storage_operation_reconciliation_total`

RF-001 emits none of these metrics. Each owning unit must define bounded labels and redaction before
instrumentation is added.
