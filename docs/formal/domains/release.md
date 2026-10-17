# Release

## The release model

`formal/AgentWorkspace/Concepts/Release.lean` is the one model of the release state machine
(issue #614). Promotion, rollback, the evaluation gate and pinned conversations refine it (80-07,
80-08, 80-12) rather than adding a model each. It is new behaviour, so only the target exists.

| Concept         | Meaning                                                                                                                                                                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Environment     | `local` or `production`: a name, and one pointer per agent.                                                                                                                                                                                                                      |
| Version         | An agent's saved body, numbered 1, 2, 3, … Only `push` (an `aw push` or a UI edit) adds one, and nothing removes one.                                                                                                                                                            |
| Pointer history | The versions an environment can step back through, newest first: a move puts one on top and a rollback takes the head off (BH061-004). The pointer is its head, which is what makes rollback one step. The server's audit table still records every move.                        |
| Gate            | A pure decision over an optional bar and a version's score. With no bar, promotion needs no evaluation. With a bar, no score refuses `promotion_not_evaluated` and a score below it refuses `promotion_gate_failed` (80-12, #619). `promote` and `point` to production check it. |
| Pinned session  | A conversation stores its version when it starts, the way a session stores its engine, and keeps it.                                                                                                                                                                             |

`step bar state op` returns the next state or a refusal (`version_not_found`, `no_pointer`,
`promotion_not_evaluated`, `promotion_gate_failed`, `nothing_to_roll_back`, `session_already_started`); a refused step changes nothing.

| Tier | Theorem                                     | Meaning to a customer                                                                                             |
| ---- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| T1   | `promote_requires_gate`                     | With a bar set, `promote … production` succeeds only if the version's score is at least the bar; no score refuses |
| T1   | `promote_without_a_bar_needs_no_evaluation` | With no bar set, promoting a version an environment points at always succeeds                                     |
| T2   | `versions_append_only`                      | No step deletes or changes a saved version                                                                        |
| T2   | `pointer_targets_existing_version`          | Every environment points at a version that exists, for the same agent                                             |
| T2   | `rollback_restores_previous`                | After `rollback` the pointer is the previous history entry, and the version left comes off the history            |
| T2   | `rollback_after_promote_is_identity`        | Promote then rollback leaves the pointer where it was                                                             |
| T3   | `session_version_stable`                    | No other step changes the version of a started conversation                                                       |
| T3   | `ui_edit_is_a_version`                      | Every content-changing operation adds exactly one version, and every other operation adds none                    |

`formal/Vectors/Release.lean` emits step sequences and the state after each step
(`formal/generated/vectors/release/steps.json`). `tests/formal/release.test.ts` checks the vectors
themselves and pins this scenario list. Each issue below adds the replay of the scenarios it names
against its pure function when it exports it:

| Scenario                                    | Replayed by                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| `promote-without-a-bar-needs-no-evaluation` | `decidePromote` (80-12, #619), replayed in `apps/web/formal/release.test.ts`  |
| `promote-passes-the-gate`                   | `decidePromote` (80-12, #619), replayed in `apps/web/formal/release.test.ts`  |
| `promote-without-a-score-is-not-evaluated`  | `decidePromote` (80-12, #619), replayed in `apps/web/formal/release.test.ts`  |
| `promote-below-the-bar-fails-the-gate`      | `decidePromote` (80-12, #619), replayed in `apps/web/formal/release.test.ts`  |
| `point-production-passes-the-gate-too`      | `decidePromote` (80-12, #619), replayed in `apps/web/formal/release.test.ts`  |
| `point-at-a-missing-version-is-refused`     | `decideRollback` (80-08, #615), replayed in `apps/web/formal/release.test.ts` |
| `promote-then-rollback-is-identity`         | `decideRollback` (80-08, #615), replayed in `apps/web/formal/release.test.ts` |
| `rollback-twice-steps-back-twice`           | `decideRollback` (80-08, #615), replayed in `apps/web/formal/release.test.ts` |
| `rollback-needs-a-previous-version`         | `decideRollback` (80-08, #615), replayed in `apps/web/formal/release.test.ts` |
| `a-conversation-keeps-its-version`          | `resolveSessionVersion` (80-07, #612)                                         |

`push` only adds a version; it never moves a pointer. The vectors move `local` with an explicit
`point`, so 80-07's replay must account for that step if its `aw push` also moves `local`.

Deviation (80-07, #612): where the model refuses `startSession` with `no_pointer`, the server
starts a legacy, unversioned agent's session with a `NULL` pin that runs from the agent row
(`apps/web/formal/release-sessions.test.ts` asserts it).

A visitor session of an embedded surface (issue #622) pins the same way: `visitor_session_pins_the_resolved_version`
([visitor sessions](visitor-sessions.md#the-pinned-version)) states that its pin is the version its environment pointed at.
