# D1 agent-frames unit

ENG-03 ([#302](https://github.com/indxjp/agent-workspace/issues/302)). Counts are not stated
here: the build that produces them runs in the orchestrator, and a number in a document that nothing
checks is a claim (ADR-0016). `docs/formal/catalogue.md` and `docs/formal/traceability.md` carry them.

## Model

`Events.AgentFrames` holds the whole seam in one module, because the four implementations the unit
touches are four uses of two functions:

- the closed `agent.*` frame union (`Frame`), its `encode`/`decode` codec, ACP's tool kinds and stop
  reasons, and the `raw` cap — `packages/contracts/src/run-events.ts`;
- `toAgentFrames`, the Claude adapter's mapping from a classified SDK message onto frames, with
  `Classified` (`packages/core`'s `ClassifiedSdkEvent`) as its input type;
- `upgradeLegacy`, the event-read path's upgrade of a `run_events` row recorded before ENG-03;
- `decode` / `toAgentEvent`, the SDK's validating parser.

Two modelling choices carry the proofs:

1. **`toAgentFrames` is `nonEmptyOr (fallbackFrame c) (mappedFrames c)`.** The never-dropped
   guarantee is therefore structural — one lemma about `nonEmptyOr`, not a property of nine
   branches — and `agent.native` / `agent.malformed` are visibly the one place it is implemented.
2. **`toolFrames` maps over data it read**, rather than filter-mapping straight to frames. "Every
   frame an assistant turn contributes is a call, and every frame a user turn contributes is a
   result" is then an induction over a `map`, which is what makes tool pairing provable without the
   mapping remembering anything between messages.

`Events.AgentEvent` — the Claude-shaped projection every client used to re-derive — is **deleted**,
and the four theorems that described it are restated over the frames in
`Theorems/{WellFormed,Invariants,Refinement}/AgentFrames.lean`. Nothing was weakened: the stream now
carries the neutral vocabulary itself, so the properties are about a codec and a mapping in the
runner rather than a projection in the SDK.

`Events.Resume` gains the sub-index: a cursor is `(sequence, subIndex?)` because one stored row can
serve several frames. `Theorems.Invariants.EventsSse.invalid_header_blocks_query_fallback` is
restated over `parseFrameId`, the parser `cursor.ts` actually calls.

## Theorems

- **T0** — the model's vocabulary is the contract's, in the contract's order; every frame name
  satisfies `EVENT_NAME_PATTERN` and none is `error`; the neutral and pre-ENG-03 vocabularies are
  disjoint; the codec round-trips over a witness per arm; an oversized `raw` is truncated with the
  marker and never rejected; only a spoken assistant turn becomes a chat message.
- **T2** — nothing is dropped (universally, over every `Classified`); a call frame comes only from an
  assistant turn and a result frame only from a user turn (universally, over any content), with a
  paired real exchange as the witness and an orphan result as the negative; resuming inside a row
  loses and repeats nothing (universally); a row's positions are a range; the `(sequence, sub-index)`
  ids of a mixed log are strictly increasing.
- **T4** — replaying a legacy row equals a fresh run of the message it stored; the upgrade is a
  function of the stored row alone; a row that is not the relay's envelope is reported as
  `agent.malformed`, not guessed at.

## Declared gap

The refinement's one hypothesis is that a stored message is the **JSON round-trip** of what the SDK
produced — the runner wrote it with `JSON.stringify`, the relay read it with `JSON.parse`. Lean cannot
discharge a property of a third-party serialiser. The argument is stated in
`Theorems/Refinement/AgentFrames.lean`: `classify` reads only `type` and `subtype`, JSON preserves
strings and objects, and a value JSON drops can only make a discriminant *absent*, which classifies as
`malformed` — the same answer as before it was dropped. `apps/web/formal/legacy-frames.test.ts` and
`apps/web/server/runs/store.test.ts`'s PostgreSQL-backed case exercise it against real rows.

`agent.message.delta` is modelled and no engine emits it: enabling the Claude Agent SDK's partial
messages is out of scope for ENG-03 and is recorded as S-24 in `docs/sdk/04-api-specification.md` §8.

## Replay and coverage

`Vectors/AgentFrames.lean` emits five files, replayed by three suites:

| File | Suite | Against |
| --- | --- | --- |
| `vocabulary.json`, `mapping.json` | `apps/runner/formal/agent-frames.test.ts` | the mapping the runner streams (`packages/core`'s `toAgentFrames`) |
| `legacy.json`, `resume.json` | `apps/web/formal/legacy-frames.test.ts` | the event-read path (`apps/web/server/runs/agent-frames.ts`) |
| `parser.json` | `tests/formal/sdk-agent-event.test.ts` | the SDK's parser (`packages/sdk/src/events/agent-event.ts`) |

`mapping.json` and `legacy.json` compute both sides — the upgraded frames and the frames a fresh run
of the same message produces — rather than writing an expectation out, so an upgrade that began to
drift fails instead of agreeing with a stale literal.
