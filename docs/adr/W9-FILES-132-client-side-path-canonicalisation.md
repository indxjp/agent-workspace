# ADR-W9-FILES-132 — The client canonicalises the current folder path itself, independently of the server's own guard

Status: accepted
Date: 2026-09-11
Decided by: W9-FILES-132 agent
Scope: `apps/web/components/resources/resource-screens.tsx`'s `canonicalizeFolderPath` and `useFileBrowser`

## Context

`packages/core/src/storage/key-safety.ts` already refuses a traversal, an absolute path, and a
percent-encoded dot-segment server-side — it is, by its own header, "a filter, never a rewriter":
every one of those forms comes back as a `400` from `GET /api/files?path=…`. That is sufficient for
the request to fail safely. This task's card carries a verifier attack that asks something stronger
of the screen this task builds, though: hand-editing the URL to `a/b/../../../etc`, `/absolute/path`,
`a/b/%2e%2e/`, or a path naming another workspace must be "either canonicalised to something inside
the workspace or shown as not found, and **no request leaves with a traversal in it**." A client that
forwards the hand-edited string verbatim and lets the server's `400` be the only defence satisfies
"shown as not found" (a `400` becomes an error message) but not the second clause — the string that
reaches the network, and that a screen-share or a browser history entry would show, still contains
the traversal.

Neither the issue nor the plan says how the client should behave here; it is silent on this exact
point, so a reading had to be chosen.

## Decision

`canonicalizeFolderPath` runs on every value the current folder is set from — the initial
`?path=` query parameter read on mount and every subsequent call to `navigateTo` — before it is ever
used to build a `GET /api/files?path=…` URL. It is a **resolver**, not a filter, and deliberately the
opposite shape from the server's guard:

- each segment is percent-decoded once (a segment that is not valid percent-encoding is kept as the
  literal text it is, never treated as licence to interpret it some other way);
- an empty or `.` segment is dropped;
- a `..` segment pops the last accepted segment, clamping at the root rather than going negative or
  throwing;
- the result is always a plain relative path with no leading `/` and no `.`/`..` segment left in it,
  by construction — see `resource-screens.test.ts`'s "never returns a path containing a `.` or `..`
  segment, for a battery of hostile inputs" for the property this claims.

Because the canonical form is what is stored in component state and in the URL bar, a hand-edited
`?path=a/b/../../../etc` is rewritten to `?path=etc` before any `fetch` is issued — the server's own
guard is still exercised on every request (defence in depth, unchanged), but it never actually has
anything to refuse in the traversal-shaped cases this attack names, because the string reaching it is
already inside the workspace.

## Alternatives considered

- **Forward the raw value and rely on the server's `400`.** Rejected: satisfies "shown as not found"
  but not "no request leaves with a traversal in it" — the literal string in the address bar and in
  the outgoing request would still contain `../../../etc` for as long as the user has not been told
  their input was rejected.
- **Refuse client-side the same way the server does (throw / show an error) instead of clamping.**
  Rejected as unnecessarily unfriendly for what is, on this side of the boundary, an ordinary
  navigation event rather than a security decision: a stale bookmark or a partially-typed URL is far
  more likely than an actual attack, and clamping to the workspace root (or the nearest valid
  ancestor) is a strictly safe interpretation that costs the user nothing when their intent was
  innocent, while still never producing an outbound request that names anything outside the
  workspace.
- **Import `packages/core/src/storage/key-safety.ts`'s guard directly instead of writing a second
  function.** Rejected: it is a filter (throws or returns the input unchanged, by its own contract)
  and this task needs a resolver (turn a possibly-bad string into a definitely-safe one) — the two
  are different jobs, and the module lives under `apps/web/server/files/**` besides, which this task's
  Owns globs (`apps/web/components/resources/**`, `apps/web/app/(shell)/files/**`) do not reach and
  the card's own "Minimum implementation" explicitly leaves untouched.

## Consequences

A folder path that canonicalises to something a workspace member is not permitted to see (a path
belonging to another workspace) is still refused — that refusal is entirely the server's, unchanged
by this task, because per-workspace scoping happens at `withWorkspaceObjectStore`'s
`access.principal.workspaceId`, not from anything in the path string. This function only ever
narrows what a hand-edited URL can make the client *send*; it grants no additional reach and takes
none away. A folder that canonicalises to a path with nothing under it renders as the ordinary empty
folder state (see `W9-FILES-132-a-canonicalised-folder-with-nothing-under-it-is-just-empty.md`) rather
than a distinct "not found" one, which is a second, separate decision this ADR does not make on its
own.
