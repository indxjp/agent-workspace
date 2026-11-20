# D1 lifecycle-run unit

## Model

`Lifecycle.Run` preserves the Phase-0 `runStep` interface and adds a run's status, logical clock,
timestamps, event log closure, gateway-token revocation, browser-token revocation, and the
actions in an interrupt or launcher conclusion. `terminalCommitCurrent` retains the historical
append/finish split for comparison; `terminalCommitTarget` models the merged atomic commit and
records only the status that wins termination.
`Lifecycle.RunAccounting` recomputes accounting from the response ledger independently of the
run status, including duplicate responses, late pricing and a `pending → failed` settlement
failure.

## Theorems and witnesses

The Phase-0 `Runs` T0/T1/T2 theorems remain the status-machine foundation. Phase-1
`ConceptWork.store_operations_preserve_run_checks` and `store_durations_are_exact` already prove
`endedAt ≥ startedAt` over every valid-clock store sequence. `LifecycleRun`
adds T1 witnesses for creation, mark-once, direct queued finish, interrupt effect order, browser
token separation, preparation failure and later settlement. T2 proves the terminal timestamp,
closed log and revoked gateway-token flags across arbitrary action sequences, and the ledger
recomputation and duplicate no-op rules. A T1 witness shows settlement after terminal status;
another fixes the partial result for a mixed ledger in either arrival order. T4 gives the repaired interrupt/conclude interleaving that
leaves only `cancelled` in the log when the run record is `cancelled`, and the serialized
target's matching single event. `Vectors.LifecycleRun` emits operation sequences replayed by
`apps/web/formal/lifecycle-run.test.ts` against the real `InMemoryRunStore`.

## Findings

- **Terminal event race, probable product defect.** `register.ts` `interruptRun` and
  `launcher.ts` `conclude` each append before finishing. Two appends can commit before either
  finish, although `finish` is first-call-wins. The T4 witness demonstrates that an event can
  disagree with the record. This conflicts with the lifecycle event's documented status-change
  meaning and needs triage before a product fix.
- **Browser-token rows remain unrevoked on ordinary finish, ambiguous.** The database finish
  revokes `run_tokens`; `browser_tokens.revokeForRun` runs on interrupt/explicit revocation. A
  terminal-run check blocks later use, but does not update those rows. T1 pins this distinction.
- **Preparation failure records running, ambiguous.** The launcher stamps `startedAt` and appends
  a running event before failing, even though no runtime was contacted. T1 pins that path.
- **Accounting failure is non-final, documentation gap.** A later `recordUsage` recomputes the
  state and can supersede `failed`; the lifecycle page says only `complete` is settled but does
  not explain this transition. T1 pins the later settlement.

## Coverage and limits

| Checklist                    | Evidence                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| LC-1–7, LC-9–11              | Phase-0 and LifecycleRun T1/T2, sequence replay                                                                          |
| LC-8, LC-25                  | Durable token distinction modelled; database-backed replay belongs to run-token unit                                     |
| LC-10, LC-14                 | Closed log and append-before-finish model; real store replay                                                             |
| LC-12–13                     | Preparation failure modelled; interrupted launch abandonment remains a gap, with `launcher.test.ts` as product oracle    |
| LC-17–21                     | Ledger state, duplicate no-op, both mixed-ledger orders and late pricing modelled; repository-backed replay still needed |
| LC-15–16, LC-22–24, LC-26–27 | Not modelled here; timeout, token issue and session behavior belong to adjacent units or product integration tests       |

The logical clock advances by explicit nonnegative elapsed milliseconds. A system clock that
moves backwards is outside this model. The in-memory store has no token or usage-ledger table,
so its vector replay cannot establish database token revocation or settlement persistence. The
accounting ledger abstracts each provider response to its priced/unpriced flag; provider response
identity, numeric counters and cost deltas remain outside this unit's accounting model.
The in-memory replay does establish that a run can become terminal while its accounting remains
`pending`; the aggregate recomputation has no in-memory store entrypoint to replay.

## Verification

The six narrow Lean targets build. The axiom audit reports 965 declarations with only the three
allowed axioms, the import audit passes, and all 59 catalogue citations resolve. Generated
vectors replay against `InMemoryRunStore`; the lifecycle and Phase-0 run suites pass together
(63 tests). The app TypeScript check, ESLint and Prettier pass.

Nine source-definition mutations were each caught by a theorem, then restored byte for byte:
mark-running status, first start stamp, direct-finish start stamp, log closure, gateway-token
revocation, append refusal after finish, interrupt effect order, the accounting failure guard,
and the unpriced-ledger result. The narrow modules were rebuilt and the vectors replayed after
restoration.

Independent verification found two more surviving definition mutations: a duplicate response
appending to the ledger, and a mixed priced/unpriced ledger mapping to `complete`. The universal
`duplicate_settlement_is_noop` theorem and the two-order `mixed_ledger_is_partial_in_both_orders`
witness now catch both mutations. They were restored byte for byte; the final narrow build,
catalogue, axiom and import audits, and 63 replay tests pass.
