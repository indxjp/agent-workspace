# W2-CP-07 — The two wiring lines this task does not own, written out rather than reached for

Status: accepted
Date: 2026-09-05
Task: W2-CP-07 (sub-wave 2b-1)
Scope: declaration only — this record changes no code

## Context

Session resume is now built end to end and demonstrated against a real process kill
(`apps/web/server/sessions/acceptance/resume.acceptance.ts`). It is **not reachable in a
deployment**, because two files have to say so and neither is this task's:

| file | owner | what is missing |
| --- | --- | --- |
| `apps/web/instrumentation.ts` | W2-DB-02 | nothing calls `installSessionApi()`, so every session route answers 503 |
| `apps/runner/src/index.ts` | W1-COMP-01 | `startAgentInThisContainer` calls `startLocalAgent(request)` with no `deps`, so no run mirrors its transcript |

This is the same situation W1-CP-04 was in for a whole wave, and it was resolved the same way:
*"Three tasks each declared that and each correctly declined to fix it, because none of them owned a
file that could"* (`apps/web/instrumentation.ts` header). ADR-0017 rule 5 makes cross-cutting wiring
a task of its own.

## Decision

Declare both, with the exact change each needs, and change neither.

**`apps/web/instrumentation.ts`** — beside the existing `installRunApi(…)`, under the same
`DATABASE_URL`/`SESSION_SECRET` conditions that already decide what this deployment can do:

```ts
import { installSessionApi } from './server/sessions/environment';
import { FileTranscriptStore } from './server/sessions/file-store';

// … only when a transcript root is configured; no root means no mirror, and the session routes
// keep answering 503 rather than silently accepting state they cannot keep.
const root = process.env.AW_SESSION_TRANSCRIPT_ROOT;
if (root !== undefined && root.trim().length > 0) {
  installSessionApi({
    authenticate: authenticateFromSessionCookie,   // the one installRunApi is already given
    store: new FileTranscriptStore(root),
  });
}
```

The authenticator is the composition root's existing one — `SessionPrincipal` is `{ userId,
workspaceId }`, structurally the `Principal` it already builds for `installRunApi`.

**`apps/runner/src/index.ts`** — in `startAgentInThisContainer`:

```ts
import { createHttpTranscriptMirror, readMirrorConfig } from './session.js';

const config = readMirrorConfig();
if (config.kind === 'invalid') throw new Error(`[runner] ${config.reason}`);   // refuse to start
const deps = config.kind === 'configured'
  ? { sessionStore: createHttpTranscriptMirror(config) }
  : {};
return startLocalAgent({ ...request, env: { ...base, ...request.env } }, deps);
```

`readMirrorConfig` already has the three arms this needs: `configured`, `absent` (no mirror asked
for — the run is honestly not durable, and `claude.ts`'s `sessionDurability()` says so), and
`invalid` (a half-configured mirror, which must stop the runner rather than run without one).

## Why this is not "just one line, take it"

Because the last time an agent in this repository reached outside its globs to finish something, the
wave paid for it. The rule is [ADR-0018](0018-the-declared-owns-line-is-the-ownership-boundary.md):
the declared `Owns globs:` line is the boundary, and its first condition — disjointness from every
sibling at the same stack level — is the only property that makes four parallel tasks safe.
`apps/runner/src/index.ts` is not disjoint from anything this task can promise; it is a file another
wave's task wrote and a later wave's task will edit.

The alternative that was considered and rejected is worse than either: making
`apps/runner/src/session.ts` install itself — a module that reads the environment and mutates a
global on import. That is a service locator, §53 forbids it, and it would make importing a module
change how every run behaves.

## Consequences

* Until both lines land, `GET|POST|DELETE /api/sessions/**` answer `503 session_api_not_configured`
  in a real deployment, and no run mirrors anything. Both are the honest answer, and both are what
  the 503's message says in full sentences.
* The acceptance harness makes the runner-side line **visible rather than hidden**: its child driver
  is the shipped runner plus exactly that `{ sessionStore }` argument, and nothing else.
* Whoever adds the two lines inherits a suite that already covers the behaviour behind them — the
  files under `apps/web/server/sessions/**` and `apps/runner/src/session.test.ts`, plus the
  credential-gated acceptance run. Derive the count rather than reading one here
  ([ADR-0016](0016-measured-numbers-do-not-live-in-prose.md)):
  `npx vitest run apps/web/server/sessions apps/runner/src/session.test.ts`.
