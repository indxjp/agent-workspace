# W1-RN-01 — The SDK boundary yields `ClassifiedSdkEvent` and nothing else

Status: accepted
Date: 2026-09-03
Decided by: W1-RN-01 (Runner)
Scope: `apps/runner/src/claude.ts`, and every later runner change that touches the event stream

## Context

Spec §42 makes `apps/runner/src/claude.ts` the only file that may import
`@anthropic-ai/claude-agent-sdk`. That sentence is only worth something if the *types* stop there
too: a boundary that imports the SDK privately and then hands an `SDKMessage` to its caller has
moved the import site, not removed it — every consumer still needs the SDK's declarations to read
what it was given, and the next task adds the dependency "just for the types".

W1-CORE-01 had already defined the union to hand over instead: `ClassifiedSdkEvent`, produced by
`classifySdkEvent(raw: unknown)` in `packages/core`. It has seven arms, and the split that matters
is between **unknown** (`system-unknown`, `result-unknown`, `unknown`) and **malformed**. R-01 §4
records that the `SDKMessage` union grows in patch releases — probe 2 received
`system/thinking_tokens` from a run that set no thinking options — so an unrecognised discriminant
is the expected case and is forwarded opaquely. An event that is not an object, or whose
discriminant is not a string, is a different thing and gets its own arm with a reason attached.

What was left open was where the classification happens, what else crosses the boundary with it,
and what the boundary does about the run-level facts (cost, durability, cancellation) that are not
events.

## Decision

**1. Normalisation happens inside the boundary, on every message, with no escape hatch.**
`startRun()` returns `events: AsyncGenerator<ClassifiedSdkEvent, void, void>`. The raw `SDKMessage`
is not exposed, not re-exported, and not offered as an option. `ClassifiedSdkEvent.event` carries
the original body as `SdkEventEnvelope` — an index-signature type declared in `packages/core` — so a
consumer that needs a field the platform does not model reads it from a `Record<string, unknown>`
and parses it, rather than from an SDK type it would have to import.

**2. The classifier is not re-implemented here.** `classifySdkEvent` stays in `packages/core`
where `tests/sdk-surface.test.ts` and `packages/core/src/schemas.test.ts` already exercise it
against the shipped `sdk.d.ts`. This file calls it. There is exactly one classifier.

**3. `malformed` is yielded, not thrown.** A single unparseable frame must not take down a run that
is otherwise producing output, and — more importantly — must not be silently skipped. Yielding it
puts the decision in the consumer's hands with the reason already written; §36's audit log and
§19's run view both want to record that it happened.

**4. Cancellation is `AbortController`, not `Query.interrupt()`.** `interrupt()` is a control
request and the SDK supports control requests only in streaming-input mode. Spec §5's own example
passes a string prompt, and this boundary does the same, so `interrupt()` would be a method that
compiles and fails at run time. `ClaudeRun.abort()` calls `AbortController.abort()`, which is passed
to `query()` as `options.abortController`. Spec §14.3's `POST /interrupt` maps onto that.

**5. The boundary is stricter than `CompiledSdkOptions` about two keys.** `tools` and `skills` are
optional in W1-CORE-01's type and **required** by `toSdkOptions`, which throws by name when either
is absent. Both defaults are permissive in the direction that matters:

- omitting `tools` gives the run the SDK's default tool surface rather than the agent's configured
  one, and R-01 §10 established that `allowedTools` does not restrict, so `tools` is the only field
  that does;
- omitting `skills` does **not** give a tenant no skills. R-01's contradiction 6 is that
  `settingSources: []` still loads the bundled Claude Code skills, so an absent `skills` key
  silently grants them to the model-invoked path as well as to the user-typed one. What an
  explicit `skills` value does and does not close is a separate decision with its own live
  evidence: `W1-RN-01-the-skill-surface-is-narrowed-not-closed.md`.

ADR-0015: a check that cannot run must fail. "The compile step did not say" is not "the compile step
said none", and this is the last place that distinction can still be made.

**6. The same rule applies to every exported signature, not just the stream — and a gate reads the
emitted `.d.ts` to prove it.** *(Added in verification round 1; the first version of this record
argued the principle in its Context and then failed to apply it two functions over.)*

The Context above says a boundary that hands an `SDKMessage` to its caller has moved the import
site rather than removed it. That is true of any SDK type on any exported signature, and the first
version of this file left two: `toSdkOptions` returned the SDK's `Options`, and
`SdkOptionOverlay.sessionStore` — reachable from the exported `startRun` through `RunDeps` — was
the SDK's `SessionStore`. `tsc --declaration --emitDeclarationOnly` proved it, writing
`import { type Options as SdkOptions, type SessionStore } from '@anthropic-ai/claude-agent-sdk';`
into `claude.d.ts`. Every consumer of the module would have needed the package to type-check,
which is the §42 failure this record exists to prevent.

The exported surface now carries platform-owned types only:

- `TranscriptMirror`, `TranscriptKey`, `TranscriptEntry` and `TranscriptSessionSummary` restate the
  SDK's `SessionStore` family field for field. They are not merely *compatible* by inspection:
  `instrumentSessionStore` takes its parameter through a private conditional alias that resolves to
  `TranscriptMirror` when the two types are assignable in **both** directions and to `never`
  otherwise, so a divergence — a required method added to `SessionStore` in a patch release, or a
  narrowing of the platform type that would reject a legitimate adapter — stops this file compiling
  rather than drifting quietly.
- `TranslatedSdkOptions` is `Readonly<Record<string, unknown>>`. Nothing outside the boundary may
  call `query()`, so nothing outside it needs a value assignable to `Options`; what a caller or a
  test wants is to read the keys the translation produced. The compiler still checks the real
  shape, on the module-private `buildSdkOptions`, which *is* annotated with the SDK's type.

The proof is a test, not a reading: `tests/no-sdk-import.test.ts` runs the compiler over
`apps/runner/tsconfig.json` with `--declaration --emitDeclarationOnly`, asserts the emit actually
happened and carries the exported names, and asserts that no emitted `.d.ts` names an SDK module.
It also asserts that its own detector goes red on a declaration file that *does* leak, so the
assertion cannot pass because the matcher stopped matching. Restoring the SDK type on
`toSdkOptions` fails that test with `emitted declarations that name the SDK: [ 'claude.d.ts' ]`.

## Alternatives considered

- **Yield `SDKMessage` and let each consumer classify.** Rejected. It makes the SDK's declarations
  part of every consumer's type surface, which is §42's failure mode dressed as a convenience, and
  it guarantees that the `default` branch R-01 §4 requires is written once per consumer and
  forgotten in at least one of them.
- **Define a runner-specific event union (`RunnerEvent`) wrapping the classified one.** Rejected as
  a second vocabulary for the same facts. The one thing it would have carried that
  `ClassifiedSdkEvent` does not — "the mirror dropped a batch" — already arrives as
  `system/mirror_error`, and the run-level answer to it belongs in a verdict, not in the stream
  (see `W1-RN-01-session-durability-is-a-verdict.md`).
- **Throw on `malformed`.** Rejected: it converts a data problem into a run failure, and it loses
  the frame. R-01 §4 also records that the SDK emits fields the `.d.ts` does not declare, so
  "unexpected shape" is not rare enough to be fatal.
- **Re-export `query()` and let callers assemble options.** Rejected outright — it is §42 inverted.
- **Re-export the SDK's `SessionStore` type from the boundary** so a caller has something to
  implement. Rejected: a re-export is the import, moved. The whole point of restating the type is
  that a caller can write an adapter against the platform's declarations alone, and the live probe
  is the demonstration — its store is a plain object literal in a file that imports nothing from
  the SDK.
- **Keep `Options` on `toSdkOptions` and simply stop exporting the function.** Rejected as a
  smaller version of the same trade: it would fix the `.d.ts` and remove the only handle a future
  unit test has on the translation, which declared gap 1 already names as this task's biggest hole.

## The honest downside

`ClassifiedSdkEvent` deliberately models almost nothing. A consumer that wants the assistant text,
the `modelUsage` record or `system/init`'s `mcp_servers` list reads it out of an index-signature
type and must parse it itself. That is more work per consumer than a fully-typed event union would
be, and the first two or three consumers will each write a small reader. The trade is deliberate:
R-01 §4's live evidence covers only 5 of the 40 declared leaf types, so a fully-typed union built
now would be 35 arms of transcription that nothing has ever exercised, and the transcription is the
thing that goes stale in a patch release. `packages/core` can add typed readers later, one at a
time, each backed by a fixture — and none of them needs to import the SDK to do it.

A second, smaller cost: because `malformed` is yielded rather than thrown, a consumer that ignores
the arm silently drops the frame. The union makes that a visible omission in a `switch`, but only
for a consumer that switches exhaustively.

## Evidence

One live run against the real API, through `startRun()`, on 2026-09-03 (Windows 11, Node v24.19.0,
one OAuth account, SDK 0.3.258 / Claude Code 2.1.258). The probe imports `startRun` and nothing
from the SDK; it is reproduced in full in `W1-RN-01-session-durability-is-a-verdict.md`.

```
KINDS_YIELDED: ["system","rate_limit_event","assistant","result"]
EVENTS: ["system/init","rate_limit_event","system/thinking_tokens","system/thinking_tokens",
         "assistant","assistant","result/success"]
ASSISTANT_TEXT: "PONG"
```

Two facts worth naming. `system/thinking_tokens` arrived again from a run that set no thinking
options, exactly as R-01 §4 warned, and was forwarded through the `system` arm rather than throwing.
And no `malformed` arm was produced in any of the three live runs — which is evidence that the
happy path is normal, **not** evidence that the malformed arm works; that arm's coverage is
`packages/core`'s unit tests, and it has never been observed on the wire.
