# ADR-0158 — A session share publishes a chosen selection of the session's own turns

Status: accepted
Date: 2026-10-19
Decided by: Owner decision D8 (2026-10-19), engineering audit #1356, unit RF-103 (W3-7)
Scope: `packages/contracts/src/shares.ts`, `packages/sdk/src/resources/shares.ts`, `packages/core/src/db/repositories/runs.ts`, `packages/core/src/db/repositories/runs/{rows,types}.ts`, `apps/web/server/shares/**`, `apps/web/server/composition/wiring/projects.ts`, `apps/web/app/api/shares/route.ts`, `apps/web/app/p/[token]/page.tsx`, `apps/web/components/shares/**`, `apps/web/components/run/run-view.tsx`, `apps/web/components/composer/home-chat.tsx`
Related: RF-103 in `docs/architecture/refactoring/claude-agent-workspace-refactoring-plan.md` (this ADR settles its transcript part; `subjectLabel`, `snapshot` and `definition` stay with RF-103); ADR-FORMAL-P1-share-subject-is-a-typed-reference

## Context

The share dialog sent the conversation on screen as `transcript`, an array of whatever the browser
built. The route masked secrets in it and stored it as the share's `snapshot`, while
`PublishShareCommand` in `@indx-workspace/contracts` said the command never carries a transcript and
the SDK dropped the field. So the only client that publishes a session share used a field the
contract denied, and what it stored was text any caller could write: a user could publish made-up
"assistant" turns under a real session id, and the public page showed them as that session.

D8 decides that a share publish may carry a transcript chosen by the client. The question left is
what the client may supply. The server already holds every turn of a session: each run stores the
prompt it started with (`runs.prompt`) and, once completed, its final answer (`runs.output.text`).
The run view never edits text before sharing it; it shares turns as they ran. Nothing in the product
needs edited text, so the client only has to choose turns, not supply them.

## Decision

- **`transcript` is a selection by reference.** On a session share the command may carry
  `transcript: { runIds }`: 1 to `SHARE_TRANSCRIPT_MAX_RUNS` (100) distinct run ids. Each names one
  turn of the shared session. The client never sends text.
- **The server copies the turns from the stored runs.** For each id the route reads the run in the
  caller's workspace and requires `run.sessionId` to be the share's subject. An unknown id, a run of
  another session are refused as `400 invalid_share` with the same sentence
  (`transcript.runIds[i] is not a run of this session`), so the answer does not say which runs
  exist elsewhere. The schema refuses a duplicate id. Turns are published in the order the runs were created, whatever order the client
  sent.
- **A turn is text only.** `{ prompt, answer }`: the prompt as the user sent it, and the final answer
  text, or `null` when the run did not complete. No tool calls, tool arguments, events, attachments,
  files, token usage, model names, run ids or the user's identity are published.
- **Stored shape.** The share's `snapshot` is
  `{ kind: 'session-transcript', version: 1, turns: [...] }`, written once at publication and never
  rewritten. A later edit to the session does not change a published share.
- **Validation.** The contract schema is strict (`ShareTranscriptSelectionSchema`). Before storing,
  the server refuses with `400 invalid_share` a snapshot whose JSON exceeds
  `SHARE_TRANSCRIPT_MAX_BYTES` (1 MiB of UTF-8) and one that carries a NUL or an unpaired surrogate
  (`unstorableTextPath` from `apps/web/server/sessions/transcript.ts`, the rule the session store
  applies), so `jsonb` never answers with a raw database error.
- **Redaction.** The turns pass through `createSessionSnapshot` with the workspace's secret values,
  the same masking every share snapshot has had: secret values and internal URLs become
  `[REDACTED]`/`[REDACTED_URL]`. The session store keeps runs verbatim; a share is where masking
  happens, as before.
- **Who may publish.** Unchanged, in this order: the route resolves the session's ownership and
  decides it with RBAC (`requireResourceAccess`) before any run is read, so only the session's owner
  or a role the policy lets act on another member's session gets as far as reading its runs. The run
  check then holds the selection to that session. The workspace sharing policy (whether public
  sharing is enabled) runs after the reads, in `ShareService.publish`, before anything is stored; a
  refusal there stores nothing and returns nothing the reads found. (Amended for #1595: an earlier
  wording said the policy check ran before any read.)
- **No new problem code.** Every refusal is caller-correctable by sending a valid command, which is
  what `invalid_share` already means (the refactoring decisions register).
- **Old clients.** A raw transcript array is refused (`invalid_share`). The only client that sent
  one is the web share dialog, which ships with this change.
- **Public page.** A version-1 transcript is rendered as a conversation under the line "Copied from
  the session's stored record when it was shared. Secret values are masked." Any other session
  snapshot, which can only be one published before this ADR from client-supplied text, is shown
  under "Provided by the person who shared it; not checked against the session's record."
- **Client.** The share dialog publishes through `browserClient().shares.publish` from
  `share-dialog-model.ts`, and the run view passes the ids of the runs it showed.

## Alternatives rejected

- **Client-supplied text, masked and labelled.** It works without reading runs but lets anyone
  publish fabricated turns under a real session id, which RF-103 exists to stop. A label helps a
  careful reader but not a screenshot.
- **Always publish the whole session.** Simpler, but D8 asks for a chosen transcript, and a session
  resumed from elsewhere can hold turns the person did not mean to share.
- **The engine's own transcript (`session_messages`).** It exists only for engines that mirror one,
  holds tool traffic and SDK internals, and its entry ids are not something the browser sees.

## Consequences

- RF-001's register row for RF-103 drops `transcript`: the request contract rejects a
  caller-authored transcript now. `subjectLabel`, `snapshot` and `definition` remain.
- `RunRecord.prompt` is set by `get()` only, like `outputSchema`, so list pages stay small.
- Publishing reads at most 100 runs, one query each.
