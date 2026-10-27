# ADR-0146 — Attachments are file-store references on the grant path, not inline bytes

Status: accepted
Date: 2026-10-18
Decided by: the Owner, approving issue #1306 on 2026-10-18 (un-parks #542; amends ADR-0108); review round 1 of PR #1339 settled limits, authority, privacy, abuse limits, delivery and reporting
Scope: `packages/contracts/src/runs.ts`, `packages/contracts/src/surfaces.ts`, `packages/sdk/src/define/surface.ts`, `apps/web/server/runs/api.ts`, `apps/web/server/compose/run-preflight.ts`, `apps/web/server/compose/resource-loader.ts`, `apps/web/server/rbac/decide.ts`, `apps/web/server/sessions/retention.ts`, `formal/AgentWorkspace/Contracts/Runs.lean`, the surface upload route; amends spec §16 and §34 in the units named under Decision 8

## Context

Issue #542 (S2-05f) was parked: #611 left attachments out because no customer had asked for them.
Six use cases in the SDK gallery now need a visitor or a caller to hand a file to a run, so the
reason for parking is gone. The Owner approved un-parking it on 2026-10-18.

[ADR-0108](0108-the-frontend-is-a-four-rung-ladder-and-a-configuration-agent-edits-it.md) accepted
attachments only if the feasibility unit S2-05e (issue #541) found them to be size S. #541 found
that they were, but with a design this record does not keep:

- The bytes travelled inline, as `contentBase64` in `StartRunRequest`, capped at four attachments
  and 384 KiB in total. That figure is `floor((1 MiB - 512 KiB) × 3 / 4)` under the runner's 1 MiB
  `/run` body limit (`apps/runner/src/http-io.ts`). 384 KiB is too small for a PDF, a spreadsheet or
  a screenshot, which are what the gallery use cases attach.
- It rejected a surface upload route as size M to L, because `PUT /api/files` (64 MiB) is
  workspace-wide and a browser token does not reach it today.
- It granted the files `read-write`, to avoid the shell loss described under Decision 3.

The platform already decides which files a run may see. An agent or project assigns a file by
`fileId`; `loadFiles` in `apps/web/server/compose/resource-loader.ts` resolves the id to its
catalogue row and reads the bytes from the workspace object store; the run request carries the file
as a `RunFileResource`; the runner's `materializeRunResources` writes it into the working directory
at its store path (read grants as `0o444`) and removes revoked ones. The grant also decides the
engine's deny rules (`applyFileGrantPolicy`). One fact limits that path today: `RunFileResource`
carries the bytes as `contentBase64` inside the `/run` body, so the runner's 1 MiB body limit bounds
every granted file, assigned or attached, together. Non-local targets additionally receive the
persistent workspace through the runner's `POST /files` tar hydrate, whose archive cap is 128 MiB
(`maxFileArchiveBytes`).

## Decision

1. **The contract.** `StartRunRequest` gains an optional `attachments`: a list of `{ fileId }`, one
   to ten entries, with unique `fileId`s, strict like the rest of the request. The Zod schema in
   `packages/contracts/src/runs.ts`, the hand parser in `apps/web/server/runs/api.ts`
   (`START_RUN_KEYS`, `parseStartRunBody`) and the Lean `startRunRequest` in
   `formal/AgentWorkspace/Contracts/Runs.lean` all gain the same key and the same predicate. Their
   agreement stays pinned by `apps/web/server/sdk-conformance.test.ts`, `formal/Vectors` and
   `tests/formal/contracts-runs.test.ts`. No bytes are in the request.
2. **The grant path, and how the bytes reach the sandbox.** Compose turns each attachment into a
   `read` file grant for that run, the same grant an assigned file takes: the same resolution by
   `fileId`, the same read-only modes in the runner, the same deny rules. The runner, the drivers and
   the engines do not change, and there is no second file channel and no inline bytes in
   `StartRunRequest`.
   - **Where the file appears.** At its file-store path, relative to the session's working
     directory (`<workspaceRoot>/<workspaceId>/<sessionId>/`). A visitor's upload is
     `.attachments/<sessionId>/<uploadId>/<name>` (Decision 6), so the agent reads
     `.attachments/<sessionId>/<uploadId>/<name>`. A member's attachment of an ordinary workspace file
     appears at that file's own path. The user turn names every attached path, as issue #1307's plan
     has it: "Attached (read-only): <path>".
   - **Filename rule.** The name is the file's last path segment as stored. The upload route admits a
     name only if it is one segment accepted by the existing path grammar
     (`W2-CP-04-file-path-admission-grammar`), at most 255 bytes, with no leading dot. A visitor
     cannot choose a directory: the route chooses `.attachments/<sessionId>/<uploadId>/`, where
     `<uploadId>` is a server-generated UUID.
   - **Name collisions.** Two uploads with the same name never collide, because each has its own
     `<uploadId>` directory. A visitor's file never collides with an assigned file, because
     `.attachments/` is reserved (Decision 6) and no assigned file can live under it. The remaining
     case is a member attaching a file the agent also has assigned: both name the same path, so they
     are the same file. The attachment grant is appended after the assigned grants, and `loadFiles`
     lets the later grant for a path win, so the file ends the run `read`. An attachment never
     widens an assignment and never leaves a file `read-write`.
   - **Carriage, and a correction to #541's premise.** The `/run` body limit bounds `contentBase64`,
     so inlining an attachment through `RunFileResource` would cap it at the 384 KiB this record
     rejects. Attachment bytes therefore do not travel in the `/run` body. The server unit delivers
     them through the runner's existing `POST /files` hydrate (128 MiB archive cap), written
     `0o444`, and still derives the deny rules and the "Attached" lines from the `read` grant of each
     path. The `local` driver is not hydrated today because its `/files` endpoint is not
     session-scoped (`apps/web/server/runs/launcher.ts`); the server unit must make that carriage
     session-scoped for `local` or refuse an attachment there, and records which in its PR. It may not
     raise the runner's body limit.
   - **Relation to #1258 and #251.** The per-key lock of #1258 is not needed: an attachment is
     written once to a key nobody else writes (`<uploadId>` is unique), never overwritten, and the
     run only reads it. The upload route uses the upload path as #1258 leaves it (the bounded body
     reader and the store `put`), so P7-2 (#1308) lands after #1258 as its plan says, but this record
     does not rely on the lock for correctness. Presigned transfer (#251, unit 19) is not used: the
     route relays at most 10 MiB, which the relay carries, and the browser receives a `fileId` either
     way. If #251 lands, the route may hand out a presigned PUT without changing `attachments`.
3. **Read-only, with its consequence, and the run says so.** An attachment is read-only: the run
   cannot change what the caller supplied. A `read` grant removes `Bash`, `BashOutput` and
   `KillShell` for the whole run, in every engine (`applyFileGrantPolicy`,
   `claudeReadOnlyGrantDenials`, and the matching rule of the other engines). So a run with an
   attachment has no shell. That is accepted. Narrowing the denial to the attachment paths is a
   possible later change, not part of this decision. **The run start reports it.** When the grant
   removed the shell, the platform appends one durable platform event `run.warning`, beside
   `run.status`, with `data: { code: 'attachments_removed_shell' }`, before the run's first agent
   frame. It is not an agent frame and does not enter `AGENT_FRAME_NAMES`. The SDK event model and
   the React run model learn the name in the contract unit. The caller and the page can then show why
   the agent has no shell; the agent learns it from the same "Attached (read-only)" turn text, which
   also states that no command can be run.
4. **Refused for an agent that cannot read files.** If the agent's effective permissions do not
   include `readFiles`, the start is refused with `422 run_attachments_unreadable`, raised from the
   start preflight (`apps/web/server/compose/run-preflight.ts`) before anything is composed or
   launched. An attachment is never silently dropped.
5. **Who may attach, and the concealed 404.** Attaching needs two permissions, each judged by
   `decide()` and neither standing in for the other: `agents: run` on the agent (already needed to
   start the run) and `files: read` on every attached file, for a member or an API key. A session
   proves identity, RBAC proves permission and the repository scope proves the tenant.
   - **Members and browser sessions.** A member holds the `files: read` that §21 gives the role (a
     Builder for files it owns or may read, an Admin for any). A Viewer holds none and cannot attach.
   - **API keys.** A workspace API key authenticates as the role it was minted with, so a key whose
     role holds `files: read` can attach, by the same check as a member. This is the permission:
     `files: read`. No new scope is added.
   - **A2A and other endpoint-scoped keys.** An `a2a-agent` or `mcp-project` key cannot attach. Their
     scope grammar in `TOKEN_SCOPE_GRAMMAR` has no `files` cell (`a2a-agent` has only `agents: run`),
     so `files: read` falls outside it. A2A v0.3 file parts are not mapped to attachments by this
     record.
   - **A surface visitor.** A visitor holds a session-scoped browser token. Its authority is the
     authority of the token's minter (the surface's publisher, ADR-0105) narrowed by the session scope
     grammar, never widened. The session grammar gains exactly one cell, upload to
     `sessions/:id/attachments` for the token's own session, and gains no `files` cell. So the token
     never holds `files: read`, and `agents: run` never stands in for it.
   - **The outside-the-prefix check.** A surface visitor is not a member, and the prefix rule is what
     bounds a non-member: for a session token, an attached `fileId` must resolve to a file under
     `.attachments/<tokenSessionId>/`. This is a row fact checked where the file row is read (as
     `runs/feedback.ts` checks a run's session), not a `decide()` cell. A member or an API key is
     not subject to it; their check is `files: read` (above), and they may not attach anything under
     another session's prefix (the 404 below).
   - **The 404.** A `fileId` that does not exist, belongs to another workspace, is not readable by
     the caller under `decide()`, lies outside the session's prefix (for a session token), or lies
     under another session's `.attachments/` prefix (for anyone) answers the same 404 with the same
     body, `file_not_found`. The caller cannot tell a foreign id from a missing one.
6. **A surface upload route, its limits and the visitor's privacy.**
   - **The route.** `POST /api/sessions/:id/attachments`, a raw body with the file name in the
     `name` query parameter. It answers `201 { fileId, path, size }`. It lives under `/api/`, not
     `/p/`: spec §34 keeps `/p/` for requests whose authenticity is answerable by the path prefix, and
     every other route a session token calls is under `/api/` and admitted by exact shape at the edge
     (ADR-0105, amendment 80-16). #1308's plan text, which writes `POST
     /p/s/<name>/sessions/:id/attachments`, is replaced by this path. The edge proxy admits this exact
     shape for a browser token, CORS answers it for the served surfaces' origins like the other
     visitor routes, and `decide()` gets its one cell, which also requires the path's session id to
     equal the token's.
   - **Not `PUT /api/files`.** A visitor's session token cannot reach `PUT /api/files`, and this
     record does not open it: that route is workspace-wide read-write, so opening it would hand a
     visitor the whole file store. The upload route stores the file under
     `.attachments/<sessionId>/<uploadId>/<name>` and returns its `fileId`. `.attachments/` is a
     reserved prefix: `PUT /api/files`, create and rename refuse it with `reserved_path`, so only the
     upload route writes there.
   - **Size.** At most 10 MiB per file, smaller than the file store's 64 MiB `PUT /api/files` limit.
     It exceeds the 384 KiB that rejected #541's design and fits the gallery's PDFs, spreadsheets
     and screenshots. A larger body answers `413 request_body_too_large`, from the same bounded
     reader the file routes use. A run's attachments total at most 25 MiB; a start over that answers
     `422 run_attachments_too_large` from the preflight.
   - **Abuse limits for anonymous uploads.** Per visitor session: at most 20 files and 50 MiB stored
     in total; the upload that would pass either answers `413 attachments_quota_exceeded`. At most
     10 uploads a minute per session; one more answers `429 surface_rate_limited` with
     `Retry-After`, the code and counters ADR-0105 already defines for turns and ratings, with the same
     per-process caveat. Upload requests also count against the existing per-client limit, keyed by
     `AW_TRUSTED_PROXY_HOPS`. A session that is over a limit keeps its earlier files.
   - **Retention and cleanup.** `.attachments/<sessionId>/` lives as long as its session. The
     session retention pass (`apps/web/server/sessions/retention.ts`, the `AW_SESSION_TRANSCRIPT_RETENTION_DAYS`
     cutoff, 30 days by default, under the same lease) deletes the prefix of each session it purges,
     object and catalogue row together, and so does deleting the session. No separate schedule or
     setting is added. A file a member has promoted (below) is no longer under the prefix and is
     kept.
   - **Visitor privacy.** A visitor upload is readable by that session and its run only. Builders and
     Admins do not read it by default: listing, reading and downloading under `.attachments/` answer
     the concealed 404 to every member, because the visitor may have uploaded personal data. A
     member can **promote** a file explicitly: they rename it out of `.attachments/` to an ordinary
     path with the existing rename route. This needs `files: write` over that file (its owner or an
     Admin), and after it the file is an ordinary workspace file, readable under §21 and exempt from
     the session's cleanup. Rename out of `.attachments/` is the only operation the reserved prefix
     admits. The session's transcript names the attached path, so a member can see that a file was
     attached and ask to promote it.
7. **`parts.attachments`.** `SurfacePartsSchema` gains a boolean `attachments` that turns the
   composer's file input on. `packages/sdk/src/define/surface.ts` and its test stop refusing it, and
   `packages/contracts/src/surfaces.test.ts` stops expecting the refusal.
8. **Spec amendments.** This record changes no spec text. The units that build it amend
   `docs/spec.md`:
   - **§34 (API design), run request.** Unit P7-1 (#1307) states that `POST /api/agents/:id/runs`
     takes `attachments` and names `run_attachments_unreadable` and `run_attachments_too_large`.
   - **§16 (File Management), files.** Unit P7-1 (#1307) states the reserved `.attachments/` prefix,
     that attached files are granted `read`, and the concealed-404 rule. Unit P7-2 (#1308) adds the
     visitor privacy rule, the 10 MiB / 20 file / 50 MiB limits, retention with the session and
     promotion by rename.
   - **§34 (API design), surfaces.** Unit P7-2 (#1308) prints `POST /api/sessions/:id/attachments`
     beside the `/p/s/` routes and notes that a session token may call it.

This record changes no code. Later units build it in this order: the contract, the SDK and the Lean
model (Decision 1 and 7); the server (Decisions 2 to 5, and the `run.warning` event); the surface
route and the web composer (Decision 6).

## Amendment (2026-10-25): attachment limits per session, not per run

Decided by: the Owner, answering Q-6 on #1616 (2026-10-21); landed by issue #1686. The 25 MiB
per-run total in Decision 6 is replaced by the storage design's size table (§04): at most 20
attachments and 50 MiB in total per session, counting the files the session stored earlier, and
10 MiB per file. A start that would pass either total answers `422 run_attachments_too_large`; the
check runs before the run is queued, as before, and is check-then-save, so concurrent requests can
overrun it by at most what is in flight. The limits come from `SURFACE_ATTACHMENTS_MAX_FILES`,
`SURFACE_ATTACHMENT_MAX_BYTES` and `SURFACE_ATTACHMENTS_MAX_TOTAL_BYTES` in
`packages/contracts/src/surfaces.ts`; `MAX_RUN_ATTACHMENTS_TOTAL_BYTES` and the
`MAX_RUN_ATTACHMENT_BYTES` alias are gone.

## Alternatives rejected

- **Inline base64 (#541's design).** It repeats the file channel, and its 384 KiB ceiling comes from
  the runner's request body, not from any limit anyone chose. It cannot carry the files the gallery
  needs. Raising the runner's body limit would make every `/run` request pay for it.
- **Claude document or image content blocks.** The engines' read tools already read PDFs and images
  from the working directory, so a file on the grant path is read without a second representation.
  Content blocks would also exist for one engine only.
- **Opening `PUT /api/files` to browser tokens.** See Decision 6: the route has no principal finer
  than the workspace.
- **`read-write` attachments (#541).** It avoids the shell loss, but it lets a run change a file the
  caller supplied and the file store keeps the changed bytes. Read-only is what the Owner decided.
- **Visitor uploads readable by every Builder and Admin.** Visitor files may hold personal data, and
  a visitor who attaches a file to a conversation has not agreed to staff browsing it. The privacy rule of
  Decision 6 costs one rename to share a file, so the broad read is not needed.
- **Amending ADR-0108's text in place.** It would erase the S2-05e condition. ADR-0108 keeps its
  history and gains a dated amendment that points here.

## Consequences

- A run with an attachment has no shell (Decision 3), and the run's events say so with `run.warning`.
  An agent that depends on `Bash` and receives attachments loses it for that run. The later units'
  documentation must say so.
- The upload route is a new write path for a browser token. It needs its own cell in the
  authorisation decision table (`apps/web/server/rbac/decide.ts`, the session grammar and a
  declared `attachments` sub-resource of `sessions`), the edge filter (`apps/web/proxy.ts`), the Lean
  token-scope model, the size and quota limits above, and the reserved prefix in the file handlers.
  #541 sized this M to L; this record accepts that size and does not pretend it is S.
- `.attachments/<sessionId>/` accumulates files that belong to no agent or project until the session
  is purged. The retention pass gains one step: delete the purged session's prefix.
- The files list, get and download routes hide `.attachments/` from every member. A test shows that
  an Admin gets the concealed 404 for a visitor's file, and that promotion by rename makes it
  readable.
- The server unit adds the `decide()` check of Decision 5: each attached `fileId` needs
  `files: read` for the caller, beside `agents: run`. A test shows that a principal holding
  `agents: run` but not `files: read` (a Viewer, or the `a2a-agent` token scope) gets the concealed
  404 `file_not_found`, and that a session token gets it for a file outside its own prefix.
- Attachment bytes leave the `/run` body (Decision 2). That is the one place this record extends the
  grant path rather than reusing it, and it follows from the runner's body limit, not from a choice.
  If the server unit finds that it cannot carry 10 MiB per file through `POST /files` for some
  driver, it must lower that driver's cap in its PR and say so, never inline the bytes.
- `StartRunRequest` changes in three places that must move together: the Zod schema, the hand parser
  and the Lean model. The conformance test and the formal vectors fail if they drift.
- `run_attachments_unreadable`, `run_attachments_too_large` and `attachments_quota_exceeded` are new
  stable error codes, and `run.warning` is a new platform event name. They join the SDK's and the
  CLI's tables when the server unit lands. The earlier unit text's `run_attachment_not_found` is
  replaced by the existing `file_not_found`.
