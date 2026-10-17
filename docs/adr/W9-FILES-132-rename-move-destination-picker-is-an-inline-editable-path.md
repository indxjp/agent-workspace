# ADR-W9-FILES-132 — The rename/move "destination picker" is an inline editable path field, not a folder-tree modal

Status: accepted
Date: 2026-09-11
Decided by: W9-FILES-132 agent
Scope: `apps/web/components/resources/resource-screens.tsx`'s `FileTable` (the `renaming` prop) and
`FilesScreen`'s `saveRename`

## Context

The card's minimum implementation asks for "Rename/move with a destination picker." Issue #132's own
proposed changes describe this only as "destination pickers" in the plural, with no further detail on
what picking a destination looks like, and `PATCH /api/files/:id`'s contract (`server/files/handlers.ts`)
already takes exactly one thing either way: `{"newPath": "new/relative/path"}` — the same field
serves a same-folder rename (`contracts/a.pdf` → `contracts/b.pdf`) and a cross-folder move
(`contracts/a.pdf` → `archive/a.pdf`) identically, because the API itself does not distinguish them.
The Simplicity Mandate directs building the card's minimum and nothing beyond it.

## Decision

Clicking "Rename" on a row replaces that row, in place, with a single-row form: one text input
(pre-filled with the item's current full path) plus Save/Cancel — see `FileTable`'s `renaming` prop.
Editing the filename portion renames within the same folder; editing the folder portion moves it
elsewhere; editing both does a move-and-rename in one request. This is "a destination picker" in the
literal sense the API itself defines a destination: a path string. It requires no new component, no
folder-browsing modal, and no duplicate of the breadcrumb/navigation machinery `FilesScreen` and
`FilePicker` already share through `useFileBrowser`.

## Alternatives considered

- **A modal that re-renders the folder tree so the user clicks a destination folder rather than
  typing one.** Rejected as beyond this card's minimum: nothing in the issue's Acceptance Criteria
  requires browsing to choose a destination rather than naming one, and a second, modal-hosted copy of
  the same browsing UI this task already built once (for `FilesScreen` and `FilePicker`) is exactly
  the kind of elaboration the Simplicity Mandate asks this task not to add.
- **`window.prompt()`.** Rejected, not for scope but for testability and accessibility: a native
  `prompt()` call cannot be asserted against in this file's static-render test harness at all (there
  is no DOM node to inspect), which would have left the one genuinely new interactive control this
  task adds with no component test covering it, contrary to the issue's own "Component tests for …
  action visibility" testing note. An inline, labelled `<input>` is also a real focusable,
  screen-reader-addressable control in a way a browser-native dialog is not represented in the page's
  own accessibility tree.

## Consequences

A user who wants to move a file into a folder they have not yet located must know or copy that
folder's path rather than click their way to it. This is stated as the real limitation it is, not
softened: adopting a richer destination-folder browser later, if `#133` or a future task wants one, is
additive to this shape (the input could gain a "browse" affordance that fills it in) rather than a
rewrite of it.
