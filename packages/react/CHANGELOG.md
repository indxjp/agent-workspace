# Changelog — `@indx-workspace/react`

One heading per release, newest first. Released in lock-step with `@indx-workspace/contracts` and
`@indx-workspace/sdk`, with the same version; the deprecation rule is theirs.

## 0.6.13 — unreleased

### Added

- `ApprovalPrompt` shows the tool call a run paused on (ADR-0145) with Approve and Reject and an
  optional comment, in English and Japanese. `approvalProblemMessage` in `run-model` words the
  three approval refusals for the reader.
- `AttachmentChips` and `ToolTrace`, with `AttachmentChipsProps` and `ToolTraceProps`: the
  attachment chips and the tool trace `<Chat/>` draws, exported as parts so another chat draws the
  same ones. `AttachmentChips` takes `{ id, name }` items and a remove callback, draws no wrapper,
  and takes class names, a glyph and a title for a host's own look. `<Chat/>`'s markup is
  unchanged.
- `prepareAttachment(file)` is exported: it shrinks a large photo before an upload, as the hosted
  chat does, so an app's channel composer (issue #1519) uploads the same files.
- `sendsOnEnter(event)` is exported: whether a composer's keydown should send, as `<Chat/>` decides
  it (Enter sends, Shift+Enter adds a new line, an Enter that confirms IME input never sends), so
  another chat's composer behaves the same.
- `Run.blocked` and `withBlockedTool` in `@indx-workspace/react/run-model`, with the `BlockedTool`
  type: the tool calls an engine refused without asking anyone, each recorded once by its call id.
  `beginRun` starts it empty.

### Changed

- `ApprovalPrompt` shows a `Bash` call whose only arguments are `command` and `description` as the
  command alone, with the full canonical call in a closed `<details>` (class
  `aw-approval-full-call`). Any other call is pretty-printed in full; text that is not this tool's
  canonical call is shown as it arrived. `ApprovalPromptStrings.approvalFullCall` labels the
  disclosure and is optional ("Full call" when left out); `surfaceStrings` has it in English and
  Japanese.
- `AttachmentChips` draws a read-only row when it is given no `onRemove`: each chip is its name
  alone, with no remove button. `onRemove` and `removeLabel` are now optional, and a remove button
  is drawn only when both are given. Existing callers, which pass both, render unchanged.

## 0.6.12 — unreleased

No changes to this package. Released in lock-step with the 0.6.12 storage proof release.

## 0.6.11 — unreleased

No changes to this package. Released in lock-step with the 0.6.11 storage and Builder release.

## 0.6.10 — unreleased

### Added

- `<Chat/>` offers a native file input when the surface sets `parts.attachments` (ADR-0146,
  #1308). Images are downscaled in the browser (2048 px long edge) before they are uploaded with
  the session token to `POST /api/sessions/:id/attachments`; the message then starts the run with
  `attachments: [{ fileId }]`.
- `<AssistantProse text/>`, and `<Chat/>` renders assistant replies through it as Markdown
  (headings, emphasis, lists, code blocks, links, GFM tables) with `react-markdown` and
  `remark-gfm` (ADR-0141, #1131). Raw HTML is dropped, images are not rendered, unsafe link
  schemes are emptied and links open in a new tab with `rel="noopener noreferrer nofollow"`.
  Visitor messages stay literal. Style it through `.aw-prose` in `styles.css`.
- The chat shows a localized notice (English and Japanese) once a run has handed the conversation to a person. The reason never reaches the visitor: the server omits it from a session-scoped stream, so the turn model's `handoff.reason` is `null` there.

### Changed

- `<Chat/>`'s composer sends on Enter and adds a newline on Shift+Enter; an Enter that confirms an
  IME composition (Japanese input) does not send (BH061-036). A replaced `components.Composer` is
  unaffected.
- A session request that gets no readable answer, which is how a browser reports an origin the
  surface does not allow, shows the visitor "The assistant could not be reached" (in the surface's
  language, the new `unreachable` string) instead of `Failed to fetch`, and logs the page's origin
  and the `allowedOrigins` fix to the console (BH061-016).
- The `react` peer range is `^18.3.0 || ^19`: the chat uses no React 19-only API, and the `^19` range
  refused an install on React 18 with ERESOLVE (BH061-038).

## 0.6.9 — 2026-10-14

No changes to this package. Released alongside the install-live harness fix (#1128) so the gallery use cases are verified live against the published packages.

## 0.6.8 — 2026-10-14

No changes; released in lock-step with the other packages.

## 0.6.7 — 2026-10-13

No changes; released in lock-step with the other packages.

## 0.6.6 — 2026-10-13

No changes; released in lock-step with the other packages.

## 0.6.5 — 2026-10-13

No changes; released in lock-step with the other packages.

## 0.6.4 — 2026-10-13

No changes; released in lock-step with the other packages.

## 0.6.3 — 2026-10-12

No changes; released in lock-step with the other packages.

## 0.6.2 — 2026-10-12

No changes; released in lock-step with the other packages.

## 0.6.1 — 2026-10-11

0.6.0 was cut as platform images only and its packages were never published to npm, so its entries ship in 0.6.1.

### Changed

- `./locale` strings for the `aw dev` try page (UX-E, issue #760), in English and Japanese:
  `tryKeyHeading`, `tryModelHeading`, `tryGetKey`, `tryKeyThenRun`, `tryKeyOrPaste`, `tryEmbed`,
  `tryCopy` and `tryCopied`. `tryLead` is removed: the try page is now the surface's own chat, not
  a host page for the widget loader (the `./locale` module is internal to the hosted app).

## 0.5.0 — 2026-10-06

### Added

- `@indx-workspace/react/styles.css` (issue #699): the default look of `<Chat/>` as plain CSS driven
  by the theme's custom properties, so the chat renders styled outside the hosted app. The hosted
  surface page imports the same file. Under `aw dev` the local draft of a surface also admits
  `http://localhost:*` and `http://127.0.0.1:*` origins when it lists no `allowedOrigins` of its own
  (never a production surface).

## 0.4.0 — 2026-10-05

### Added

- `./locale` gains `tryModelKeyFix(secrets)`, `tryModelReachFix` and `awDevModelFix` (issue #661),
  in English and Japanese: the `aw dev` fix line for a missing or rejected model key, naming the
  variables to set, and for a provider that could not be connected to (`model_connection_failed`),
  which the widget shows as its generic sentence.
- The package (issue #623): `<Chat/>`, whose `MessageList`, `Message`, `Composer` and `ToolResult`
  are replaceable through `components` and whose props types are exported; the headless
  `useConversation()`; and `SURFACE_DEFAULTS`. `./theme` and `./locale` are the look's defaults
  and the surface's strings, which the hosted app's server routes read. `./run-model` is internal:
  the control plane's console shares the conversation model through it, and it is outside the
  public surface and may change in any release.
- `baseUrl` on `<Chat/>` and `useConversation()` (issue #623): the Agent Workspace to talk to, or a
  proxy of it, instead of the page's own origin. The package joins the lock-step release list.
