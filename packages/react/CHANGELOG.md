# Changelog — `@indx-workspace/react`

One heading per release, newest first. Released in lock-step with `@indx-workspace/contracts` and
`@indx-workspace/sdk`, with the same version; the deprecation rule is theirs.

## Unreleased

### Added

- `<AssistantProse text/>`, and `<Chat/>` renders assistant replies through it as Markdown
  (headings, emphasis, lists, code blocks, links, GFM tables) with `react-markdown` and
  `remark-gfm` (ADR-0141, #1131). Raw HTML is dropped, images are not rendered, unsafe link
  schemes are emptied and links open in a new tab with `rel="noopener noreferrer nofollow"`.
  Visitor messages stay literal. Style it through `.aw-prose` in `styles.css`.

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
