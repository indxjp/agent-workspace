# W2-CP-07 — `listSessionSummaries` is left unimplemented because only `claude.ts` may compute it

Status: accepted
Date: 2026-09-05
Task: W2-CP-07 (sub-wave 2b-1)
Scope: `apps/runner/src/session.ts`, `apps/web/server/sessions/transcript.ts`

## Context

The SDK's `SessionStore` has six members: `append` and `load` required, and `listSessions`,
`listSessionSummaries`, `delete` and `listSubkeys` optional. This task implements five.

`listSessionSummaries` is the one left out, and not for effort. R-01 §7 records how it has to be
maintained:

> `listSessionSummaries` must be maintained inside `append()` via the exported `foldSessionSummary`
> helper, skipping batches whose key has a `subpath`; concurrent `append()` calls for one session
> must be serialised.

and what the value it produces is:

> `data: Record<string, unknown>` — opaque SDK-owned state — **persist verbatim, never interpret**.

So the summary cannot be computed from the entries by this platform. It is computed by
`foldSessionSummary`, which is exported from `@anthropic-ai/claude-agent-sdk`. Spec §42 makes
`packages/engine-claude-agent-sdk/src/boundary.ts` the only file in `apps/` and `packages/` that may import that package,
and `tests/no-sdk-import.test.ts` enforces it over the whole tracked tree — including, per its own
header, the emitted `.d.ts`, so a type that travels out on an exported signature is caught too.

## Decision

**Do not implement it, and do not reach through the boundary to make it possible.**

* `TranscriptStore` (`apps/web/server/sessions/transcript.ts`) declares four members and not this
  one, with the reason at the declaration site.
* `createHttpTranscriptMirror` (`apps/runner/src/session.ts`) returns an object with no
  `listSessionSummaries` property. `session.test.ts` asserts its **absence**, so adding it by any
  route that does not go through `claude.ts` turns a test red rather than passing quietly.

## What this costs, exactly

R-01 §7 states the two consequences, and neither is hypothetical:

* *"Without `listSessions`, `continue: true` throws and `listSessions({sessionStore})` throws unless
  `listSessionSummaries` exists."* `listSessions` **is** implemented here, so `continue: true` works
  and the standalone `listSessions({ sessionStore })` helper does not. Nothing in this platform calls
  that helper today; §20's *List sessions* is served by `GET /api/sessions`, which reads this
  platform's own store.
* A summary-based listing — the SDK's `SDKSessionInfo` with `summary`, `customTitle`, `firstPrompt`,
  `gitBranch` — is not available. Spec §19.5's *Recent* list is served from the `sessions` table's
  own `title` column instead, which is what `packages/core/src/db/schema/sessions.ts` says it is for.

## The one-line change that would close it

`packages/engine-claude-agent-sdk/src/boundary.ts` re-exports the helper under a platform name, keeping the SDK's types off
the exported signature the way it already does for `TranscriptMirror`:

```ts
// in claude.ts, beside the existing SDK imports
import { foldSessionSummary as sdkFoldSessionSummary } from '@anthropic-ai/claude-agent-sdk';

/** R-01 §7's summary fold. `data` is SDK-owned: persist it verbatim, never interpret it. */
export function foldTranscriptSummary(
  previous: TranscriptSessionSummary | undefined,
  key: TranscriptKey,
  entries: TranscriptEntry[],
  options?: { mtime?: number },
): TranscriptSessionSummary {
  return sdkFoldSessionSummary(previous, key, entries, options);
}
```

`TranscriptSessionSummary` is already declared in `claude.ts` and already carries the "store
verbatim" note. With that in place, `session.ts` folds the summary inside `append()` and the control
plane stores it beside the transcript — a `summary jsonb` column, or a `summary.json` beside
`main.jsonl`.

`packages/engine-claude-agent-sdk/src/boundary.ts` is not this task's file. The change is written out here so that whoever
owns it next can make it without re-deriving any of the above.

## Consequences

* Five of six members is a **complete** store for everything this platform does, and the sixth is
  absent by name rather than by omission.
* A reviewer can tell the difference between "not built" and "not buildable here", which is the
  distinction [ADR-0031](0031-a-static-gate-cannot-be-complete-so-undecidable-must-mean-refused.md)
  asks for in a different setting: state the limit; never imply completeness.
