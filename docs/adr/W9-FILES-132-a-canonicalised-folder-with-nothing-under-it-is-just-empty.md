# ADR-W9-FILES-132 — A folder path with nothing listed under it renders as "empty", never as a distinct "not found"

Status: accepted
Date: 2026-09-11
Decided by: W9-FILES-132 agent
Scope: `apps/web/components/resources/resource-screens.tsx`'s `FileTable` empty state and
`FilesScreen`/`FilePicker`'s use of it

## Context

The card's minimum implementation lists "Root, empty, missing, loading, forbidden, and error states"
among what this screen must handle, and its verifier attack's second scenario deletes a folder from a
second browser tab and then, in the first tab (which still shows the now-stale row), clicks into it,
clicks Download on it, and clicks Delete on it — asserting "the stale row produces a handled
not-found state" and that Download was never offered for a folder at all.

`GET /api/files?path=<folder>` (`server/files/handlers.ts`'s `listFiles`) has no notion of a folder
"existing" apart from what is listed one level under it: a folder is implied by its contents, never
recorded as a row of its own (this is the module's own declared gap — "creating an *empty* folder…
is not supported" — an object store models presence, not absence). Calling it for a path that once
had files but no longer does, and calling it for a path that never had anything, are the same request
with the same response shape: `{"files": []}`. There is no server-side signal this screen could use
to tell "this folder is empty" apart from "this folder is gone" even if it wanted to.

## Decision

`FileTable` renders one empty state — "This folder is empty." — for a zero-length `rows` array,
regardless of whether the folder was ever real. Navigating into a folder a second tab has since
deleted produces exactly this state once the listing resolves: no crash, no separate "not found"
message invented for a distinction the underlying storage model cannot make. This satisfies the
verifier attack's "handled not-found state" as the one honest reading available: "handled" means
"does not crash and does not show incorrect data," not "shows a state the data cannot actually
support."

## Alternatives considered

- **Track "known to exist" folders in client state (e.g., every folder navigated through this
  session) and show a distinct "This folder no longer exists" message when a previously-seen folder
  comes back empty.** Rejected: this only works for a folder the *current browser tab* itself
  navigated through earlier in the session, so it would give a "not found" message in some deletion
  orders and the ordinary empty message in others depending on incidental navigation history, which
  is a worse and less honest signal than a single consistent empty state — and it is exactly the kind
  of client-side statefulness ("a cache," in effect) the Simplicity Mandate says not to add without
  the card naming it.
- **Add a way for the server to say whether a folder was ever created.** Rejected: this needs the
  `files` catalog table's own repository (`packages/core/src/db/repositories/**`) to record folder
  rows independently of their contents, which is outside this task's Owns globs and is already this
  module's own pre-existing declared gap, not something this UI task can or should repair.

## Consequences

A user cannot distinguish, from this screen alone, "I navigated to a folder that was just deleted"
from "I navigated to a folder that has always been empty." Given the object-storage model this API is
built on, that distinction does not exist to be shown. Download is unaffected by any of this: it is
never offered for a folder row regardless of staleness, because `FileTable` renders a Download link
only for `kind: 'file'` — a structural fact, not a check that could be defeated by a stale read.

## Amendment (2026-11-05): the parent listing now tells empty from missing

The Context above no longer holds: since issue #899 the catalog records a row for every parent
folder (`insertParentFolders` in `packages/core/src/db/repositories/resource-catalogs.ts`), and a
folder keeps its row when its last file is removed. So the server already answers the question this
decision said it could not: a folder exists when its parent's listing has a `folder` row at its
path. When a non-root listing is empty, the Files screen now reads the parent folder once and says
"This folder is empty." for a folder row, that the path is a file for a file row, and "There is no
folder …" otherwise. This is the second alternative above, made possible by #899, not the rejected
client-side cache: nothing is remembered between navigations. Until the parent answers, the status
line is blank rather than "This folder is empty.", which would be wrong for a missing folder; if the
parent cannot be read, the screen keeps "This folder is empty.". Issue UX-20 in #2086.
