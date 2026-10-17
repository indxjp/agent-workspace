# D1 events-sse unit

## Model

`Contracts.RunEvents` pins the control, status and relayed vocabularies and the four payload
schemas. `Events.RunLog` models per-run sequence allocation, bounded retention, cursor resets,
closure and the different stream exit checks. `Events.Sse` models server name checks, frames,
outcome classification and relay line/message parsing. `Events.Resume` models cursor precedence
and range. `Events.SdkSse` models the SDK's frame parser and splitter.

The SDK parser and splitter use recursive character lists, and the cursor parser accumulates
ASCII digits directly. This keeps the same LF/CRLF, empty-id and cursor-boundary behavior while
allowing kernel reduction of the concrete proofs. Server frame encoding uses a total JSON string
escaper for keys and string values, matching `JSON.stringify` for the representable JSON input
domain; numeric values still use Lean's JSON printer. JavaScript-only values and lone surrogate
code units remain outside the model.

The theorem family has 38 compiled theorems across all five tiers. In particular, T2 proves allocation, closed-log
refusal, strict replay and the in-memory follow condition. T3 proves that reserved and
newline-bearing runtime names cannot reach a durable frame. T4 gives a concrete repository
tail-loss interleaving and server/SDK framing witnesses.

## Finding

The repository stream can drop the final event of a run. Its event-list query can finish before
a concurrent append, then its separate terminal-run read can observe completion and return. The
T4 witness delivers event 1, then places event 2 in the terminal log; the current repository exit
test ends, while the tail-aware target and the in-memory adapter remain open. This is also listed
as D1 finding 1 in `docs/formal/domains/d1-runs.md` and needs a product change outside this unit.

The SDK splitter originally normalised CRLF but did not split a lone CR, although the server relay
did. PR #284 fixed the splitter, and T4 now proves agreement on the lone-CR witness. Server-generated
frames use LF, so this case concerns input from another SSE producer.

## Replay and coverage

The generated family has 94 vectors in 13 files. It covers vocabularies, schemas, name classification, cursor parsing,
SDK frame parsing and splitting, relay line splitting and message assembly, server durable and
control frames, run-log retention/reset/closure, run-outcome classification, and terminal frame
order. The root test
replays contract and SDK vectors against the real packages. The web test replays server vectors
against the real cursor, SSE, relay, API and in-memory store implementations. Additional web
tests exercise response admission, relay terminal and failure paths, and outbound frame order and
teardown; the root test probes every UTF-8 byte split in a Unicode frame.

EV-1–3, EV-5–7, EV-9–11, EV-14–21, EV-23, EV-26–28, EV-31–34 and EV-38 have direct model,
replay or both. The repository tail-loss witness covers the current behavior in EV-13; it does
not establish a corrected repository implementation. EV-8 and EV-12 are modeled at the log
level and replayed through the in-memory adapter, but this unit has no database-backed replay.
EV-4 has a model only for values already representable as JSON; rejection of JavaScript BigInt,
cycles and undefined remains in product tests. EV-22 has a frame-model witness and a direct
web test. EV-25 is a direct test because timer/resource teardown is outside the pure model.

EV-29 has direct TypeScript tests for bad JSON, unnamed frames, reserved-name refusal, terminal
frames and the reported session id; it is not fully modeled in Lean. EV-30 and EV-35–37 remain
outside this unit's Lean model. The SDK-facing TypeScript tests cover `classifyRunEventFrame` for
the declared relayed vocabulary and a malformed platform frame, but not every payload variant.

## Verification

`lake build Vectors.EventsSse` passes after restoration (23 narrow jobs). Both real TypeScript
replay files pass: 108 tests. Web and root TypeScript typechecks and narrow ESLint pass. Six
initial definition mutations were detected by the named theorem modules, then restored:

| Mutation                           | Detection                    |
| ---------------------------------- | ---------------------------- |
| Accept every event name            | T3 newline-injection theorem |
| Allocate `lastId + 2`              | T2 allocation theorem        |
| Suppress retention gap             | T1 gap witness               |
| Rename failure frame to `done`     | T1 outcome-order theorem     |
| Admit the first overflowing cursor | T0 range witness             |
| Normalize lone CR in the SDK       | T0 splitter witness          |

An independent review supplied seven fresh mutations. All seven initially survived at theorem
level; the added witnesses now catch each one:

| Fresh mutation                               | New detection               |
| -------------------------------------------- | --------------------------- |
| Retain a prefix instead of the newest suffix | T2 exact retention theorem  |
| End an in-memory stream before close         | T2 closed-exit theorem      |
| Make the retention-gap boundary inclusive    | T1 oldest-minus-one witness |
| Make the ahead boundary inclusive            | T1 latest-id witness        |
| Admit a runtime name on the platform path    | T3 platform-name witness    |
| Admit a control name as a durable event      | T3 stored-name witness      |
| Discard earlier SDK `data:` lines            | T0 multiline parser witness |

Every mutated source was restored byte for byte. The restored narrow target built and the vector
family regenerated. The final replay after these seven repairs passed all 108 tests. These
checks do not run the full repository build or a PostgreSQL-backed stream replay.

The later axiom audit passed for 9,619 declarations with only `propext`, `Classical.choice` and
`Quot.sound`. Six theorem docstrings were added and seven concrete proofs now use kernel-checked
`decide` instead of `native_decide`. All three EventsSse theorem modules built (19 narrow jobs),
and the two real TypeScript replay suites passed 108/108 tests after the computational rewrite.
The global `pnpm formal:check` passed after the integration removed a
`Contracts.RunEvents` to `Concepts.RunEvent` import and regenerated the catalogue.
