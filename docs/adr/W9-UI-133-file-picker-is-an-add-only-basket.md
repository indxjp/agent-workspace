# W9-UI-133 — The reused `FilePicker` is an add-only basket, not a controlled, pre-populated selector

Status: accepted
Date: 2026-09-12
Decided by: W9-UI-133 (implementing agent)
Scope: `apps/web/components/agents/resource-editor.tsx`'s `FileAssignments`

## Context

The card's Minimum implementation is explicit: "The nested file/folder picker W9-FILES-132 published
is reused here rather than re-implemented." That picker,
`apps/web/components/resources/resource-screens.tsx`'s `FilePicker`, is outside this task's Owns
globs (`apps/web/components/resources/**` belongs to `#132`) and is published exactly as issue #132
built it: it owns its own `selected` state (`useState<readonly FilePickerSelection[]>([])`,
initialised empty on every mount), browses via `useFileBrowser` (which reads and writes the
**browser's own address bar** `?path=` query parameter and pushes history entries on every
navigation — see that file's own `W9-FILES-132-client-side-path-canonicalisation.md`), and reports
the full current pick to `onChange` on every toggle. It accepts no prop for an initial selection and
exposes no way to mark a row as "already assigned elsewhere."

An agent can already have file/folder grants before this editor's `FilePicker` panel is ever opened
— pre-existing assignments loaded from `GET /api/agents/:id/resources`, resolved to their names by
`resolveFileGrants` and rendered in their own list above the picker. `FilePicker` has no way to know
about them.

## Decision

**`FilePicker` is used only to browse for and pick *new* files/folders. Its reported selection is
held in a `pending` basket, separate from the agent's actual assignment list, and only merges into
the real assignments — deduplicated against ids already assigned — when "Add selected" is clicked.**
Managing an assignment already on the list (changing its access mode, removing it) is the job of that
list's own per-row controls, never of re-opening the picker and toggling a checkbox that starts
unchecked regardless of whether the row is already assigned.

This keeps `FilePicker` genuinely unmodified — no fork, no wrapper that reaches into its internal
`useState` — at the cost of one non-obvious UX property: browsing to a folder that already contains
an assigned file shows that file's checkbox unchecked in the picker, even though it is, in fact,
assigned. The existing-assignment list above the picker is the one place that state is visible; the
picker itself is deliberately just a way to find and add something new.

The `useFileBrowser` history-URL side effect (browsing inside the picker rewrites the agent detail
page's own `?path=` query string and pushes a history entry) is inherited unchanged for the same
reason: it is `#132`'s own published behaviour for this exact reuse, not a defect this task
introduces or is positioned to fix.

## Alternatives considered

- **Fork or wrap `FilePicker` to accept an `initialSelection` prop.** Rejected: it is not this task's
  file to edit (`apps/web/components/resources/**` is `#132`'s Owns glob), and a wrapper that reaches
  into a component's internal state via effects to force a checked state on mount is a fragile
  coupling to an implementation detail (`useState`'s initial value) that the published component
  makes no contract about.
- **Re-implement a second, agent-scoped file picker that does accept pre-population.** Rejected
  outright by the card itself: "reused ... rather than re-implemented" is not a suggestion.
- **Merge every `onChange` from `FilePicker` into the assignment list immediately, with no explicit
  "Add" step.** Rejected: `FilePicker`'s own `onChange` reports the *full current pick*, including a
  row the user unchecked a moment after checking it while still browsing — merging on every change
  would either need to reconcile removals against the real assignment list (reintroducing exactly the
  "does the picker know what's already assigned" problem this decision avoids) or would let an
  accidental click briefly, silently add and remove a real assignment before the explicit "Add" the
  card's own UX distinction between adding and managing calls for.

## Consequences

- A person managing an already-large assignment list who also wants to add one more file sees two
  separate lists while the picker is open: what is assigned (above) and what is about to be added
  (inside the picker, until "Add selected"). This is judged an acceptable, explicit two-step flow
  rather than a single unified tree, given the constraint that the reused component owns its own
  selection state.
- Browsing inside the picker on the agent detail page changes that page's own URL query string and
  adds browser history entries, inherited unchanged from `#132`'s `useFileBrowser`. A user who
  presses the browser Back button while the picker is open with a folder open navigates the picker's
  folder history rather than leaving the agent detail page — the same behaviour the Files screen
  itself already has, extended here by reuse rather than introduced.

## Related

- [W9-FILES-132-client-side-path-canonicalisation](W9-FILES-132-client-side-path-canonicalisation.md)
- [W9-FILES-132-rename-move-destination-picker-is-an-inline-editable-path](W9-FILES-132-rename-move-destination-picker-is-an-inline-editable-path.md)
