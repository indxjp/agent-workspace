# B-sdk-runs

`Sdk/Runs.lean` models the public runs client's request shapes, HTTP error classes,
cumulative follow reconnection, and settled-record check. `Events/AgentFrames.lean` (ENG-03, #302) models
platform-frame drops, neutral message/tool order, result usage and cost, and retained raw
result payload. T0, T1, T2, and T4
theorems name the corresponding SDK exports and guide claims. The T4 witness records the
current indeterminate outcome: the server emits `run-failed{status: unknown}` followed by
`done`; `waitForOutcome` then rejects a still-running record as a `ContractViolationError`.

The real replay uses `createClient` through the package's declared export and an in-test recording
fetch double. It checks all run method requests, a nonempty list filter, error envelopes, an
unexpected 201, one-fetch failures, a slow response-header timeout,
`Last-Event-ID` on reconnect, cumulative reconnect budget, caller abort, the
indeterminate/live-record witness, follow-error propagation, and neutral event fan-out.
`packages/sdk/src/testing.ts#fetchDouble` is not exported by the SDK package, so the formal
suite uses a local equivalent at the public `createClient` boundary.

## Verification

The named `Vectors.SdkRuns` target built after byte-for-byte restoration. Family-only vector
generation produced six files. The real public SDK replay passed **40/40** cases, including
generated request, nonempty list, follow, multistep trace, wait, and neutral-event vectors.
Ten first-pass definition mutations all failed
the named theorem build: start status, get path, revoke token body, resume header, unknown problem
fallback, caller abort, reconnect bound, live wait, platform-event drop, and message fan-out order.
Three additional verifier mutations (drop nonempty list status, accept unexpected 201, and map
a result without subtype as success) were repaired and then killed by direct theorem statements.
An independent final pass killed six further fresh definition mutations, restored source hashes,
and repeated the clean SDK vector build and **40/40** replay.
The combined SDK/CLI `lake exe axioms` audit checked 1,563 declarations and `lake exe imports`
checked 32 model import edges. All 38 SDK source citations resolved.
`tests/tsconfig.json`, ESLint, and Prettier passed.

## Model limits

Request paths receive the already encoded segment as an explicit argument. The TypeScript
replay checks the real `encodeURIComponent` behavior, including reserved characters, while
the Lean request model states the resulting method, path, body, headers, and expected status.
`AgentEvent` carries already normalized result accounting, cost, raw data, and tool input through
its neutral projection; extraction from arbitrary provider JSON, other raw payloads, and message
text remain abstract in Lean and are checked with real SDK fixtures. Follow's delay and
headers deadline are represented by their observable abort and retry decisions; real timers
remain in the TypeScript replay.
The Lean request model does not prove the full Unicode percent-encoding algorithm, and the
method-specific successful response schemas are
exercised by the SDK replay but are not reimplemented as Lean codecs.
