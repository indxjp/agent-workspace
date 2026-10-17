# W9-UI-120 — Full-navigation switching, session recovery in the shell, and create is not Owner-gated

Status: accepted
Date: 2026-09-12
Decided by: W9-UI-120 (implementing agent)
Scope: `apps/web/app/(shell)/layout.tsx`, `apps/web/app/(shell)/workspaces/**`,
`apps/web/components/shell/**`, `ui/workspaces.html`, `ui/index.html`,
`tests/screen-declarations/W9-UI-120.ts`

## Context

Issue #120 asks for a workspace switcher, a create/settings surface, and — its hardest acceptance
criterion — "a switch cannot display cached records from the previous workspace", including "during
the transition, and … after pressing Back", plus a recoverable route when the current workspace is
removed or archived out from under an open session. `#119` (`GET/POST /api/workspaces`,
`GET/PATCH /api/workspaces/:id`) and `#118` (`POST /api/auth/workspace`) are already landed; this
task owns no API route (`apps/web/app/api/workspaces/**` and `apps/web/app/api/auth/**` are on no
W9.6 Owns line for this card) and must build entirely on what they already do.

## Decision

### 1. Switching is a real `<form method="post" action="/api/auth/workspace">`, not a `fetch`

Each item in the sidebar's menu (`components/shell/workspace-switcher.tsx`) is a
`<button type="submit" form="…">` associated — via the HTML `form` attribute, not by nesting — with
one hidden `<form>` the switcher renders once. Activating it is an ordinary browser form submission:
the page unloads, `POST /api/auth/workspace` re-reads membership and mints a fresh session, and the
`303` response lands on a freshly rendered `/`. Before submission, the switcher synchronously
conceals the tenant document so records from the old workspace cannot remain visible while the
browser is navigating. A `pageshow` listener reloads a history entry restored from the back-forward
cache; the reload is evaluated under the current workspace cookie instead of reviving the old
tenant DOM. No React tree, `useState`, or Next.js router cache is reused as the new workspace's
page — the simplest possible proof that no tenant-scoped client cache survives switching or Back.
The alternative (a `fetch` plus
`router.push`) would need its own audit of every `useState`/`useEffect` on every tenant-scoped
screen to prove none of them keeps yesterday's fetch result around after the workspace id changes;
a full navigation makes that audit unnecessary by construction.

### 2. The item already active stays a live submit button, not a disabled row

Resubmitting the current slug is a harmless no-op re-mint (`route.ts`'s `match` still succeeds). A
disabled "current" row would need its own focus-management and announcement rules for no behavioural
benefit, so the current item stays in the roving-tabindex sequence, marked `aria-current="true"` and
a "Current" label.

### 3. The shell's own session-recovery redirect is a separate, exported pure predicate

`apps/web/app/(shell)/layout.tsx` already re-reads the caller's membership every request
(`resolveIdentity`); this task adds acting on a `null` it returns for the right reason — the
caller's own membership (or the workspace it names) is genuinely gone, not merely that the RBAC
runtime is unwired (`apps/web/server/rbac/runtime.ts`'s own declared gap, a different task's). That
distinction is `components/shell/session-recovery.ts`'s `shouldRecoverSession`, a pure function
directly unit-tested, rather than inline logic in a Server Component this repository's own test
idiom cannot render (`(shell)/layout.test.ts`'s header: "`ShellLayout` itself is a Server Component
this suite does not render"). `layout.tsx` — an exact filename in this task's `Owns`, not a glob —
cannot gain a sibling test file, so the logic that needs a test lives in the one directory that can
carry one.

Recovery also applies while the shell is already open. Every response boundary that can discover
session loss — the switcher's directory GET, the `/workspaces` directory GET and create POST, and
the shared rename/archive/restore PATCH — routes an API `401` or the fail-closed `500
authorisation_undecidable` through `recoverWorkspaceSession`. That boundary first clears the
component's tenant state, then conceals the document, then performs the same full navigation.
Other directory failures stay visible because treating every transient fetch failure as session
loss would be fail-open recovery logic. Both positive branches, the refusal of unrelated failures,
and the clear/conceal/navigate sequence are isolated in pure functions and mutation-tested. The
native workspace-switch POST remains a separate boundary: its server route owns the stale-selection
redirect, while the form conceals the document before submission.

Recovery redirects to `/signin?error=session_expired` — the exact vocabulary
`apps/web/app/api/auth/workspace/route.ts`'s own stale-selection branch already redirects to, which
`apps/web/app/signin/page.tsx` already renders as "That sign-in attempt expired. Start again." One
explanation for one underlying condition, not a second one this task invents. A dedicated
"workspace membership was removed" screen was considered and rejected: it would need its own route
(none of `apps/web/app/**` outside `(shell)/layout.tsx` and `(shell)/workspaces/**` is this task's
`Owns`), and `/signin` already leads back to the real multi-membership selection screen
(`GET /api/auth/workspace`) for an identity that still has other memberships, through the landed
OIDC callback path — a genuine route back to selection, not a dead end.

### 4. The workspace's archived state is read from `GET /api/workspaces`, never invented at the shell layer

`apps/web/server/rbac/directory.ts`'s `UserMembershipSummary` — what `(shell)/layout.tsx`'s
`resolveIdentity` reads — carries no `archivedAt` field; that port belongs to `#118` and is not this
task's to widen. The switcher fetches `GET /api/workspaces` (client-side, already carries
`archivedAt` per `#119`'s `serialiseMembershipView`) and matches the session's own slug against the
returned rows to show the persistent "This workspace is archived" banner and the per-item badge in
the menu — the one path to that fact that stays inside this task's `Owns`. Successful create,
rename, archive and restore operations publish a shell-local directory-change event so the banner
and menu immediately refetch instead of waiting for a page reload.

### 5. `CreateWorkspaceForm` gates on nothing; `WorkspaceSettingsPanel` gates on `role === 'owner'`

The card's own words: "rename and archive are Owner-only `PATCH`; there is no separate capability
object". `POST /api/workspaces` carries no role check at all —
`apps/web/app/api/workspaces/route.ts`'s own header, "#119 puts no role gate on who may create a
workspace or list their own memberships" — so the create control is never hidden; hiding it would
tell a non-Owner caller their own request would fail when it would not. This is the opposite
resolution from `docs/adr/W9-PROJ-123-no-client-side-role-gate-on-create-and-edit.md`'s declared
gap, and deliberately so: that task had no client-visible role signal to gate on at all, while this
one's `GET /api/workspaces` item literally is "my role in this workspace" (issue #119's whole
surface is member-scoped to the caller). Rename, archive and restore read
`canAdministerWorkspace(item)` (`role === 'owner'`) and are **absent**, not merely disabled, for
every other role; a `403` that arrives anyway (a role changed between load and submit) is rendered
with the server's own `error.detail`, never swallowed.

The renewed pre-flight corrected the earlier verifier premise in
`W9-PLAN-workspace-create-follows-the-landed-collection-policy`: a Builder must be able to create
through both UI and API and becomes the new workspace's sole Owner, while direct rename/archive
requests against another member's workspace remain refused. The UI follows that amended card and
does not carry a contradictory client-side role table.

### 6. Membership rows and mutation responses have deliberately different parsers

`GET /api/workspaces` includes the caller's role; successful `PATCH /api/workspaces/:id` responses
describe the workspace resource and do not. The directory client validates those two wire shapes
separately, then carries the already-validated membership role forward after a mutation. Reusing
the membership parser for `PATCH` would turn a successful rename/archive/restore into a false
"malformed response" error.

Those parsers treat this first-party API as a closed contract at every layer: the list/item wrapper,
the membership or role-free resource, and the error envelope all reject undeclared keys. IDs must
be UUIDs, roles belong to the four-value server role set, flags are booleans, and `archivedAt` is
either null or the same canonical UTC millisecond timestamp `Date.toISOString()` emits. The
timestamp grammar and Gregorian-calendar check are separate positive assertions so neither a
timezone/fraction variant nor JavaScript's normalisation of an impossible date can reach rendering.
This is the complete sibling-site repair required by ADR-0048: both consumers share these parsers,
and every owned workspace fetch found by enumerating `.json()` calls in the shell/workspaces paths
passes through one of them.

### 7. Narrow screens stack the shell, wrap status, and scroll only the wide directory table

The shell becomes a vertical layout below the existing medium breakpoint. The workspace table
keeps readable columns in an internal horizontal scroll region rather than expanding the document
or crushing the main panel. The workspace slug is repeated beneath the visible name so the active
database identity remains readable without relying on a clipped column. The top bar also stacks at
the small breakpoint and its runtime status link may shrink and wrap; that link remains fully named
and reachable without widening the whole document.

## Alternatives considered

- **A dedicated `role` prop threaded from `(shell)/layout.tsx` into the sidebar**, computed once
  server-side, instead of a client-side `GET /api/workspaces` read in the switcher. Rejected: the
  session's own role in its own workspace is already shown correctly by the existing sidebar footer
  (`resolveIdentity`); the switcher additionally needs every OTHER membership's role and archived
  state, which only `GET /api/workspaces` answers, so a second, narrower SSR value would not remove
  the client fetch, only duplicate part of what it already returns.
- **Gate `CreateWorkspaceForm` on Owner anyway**, matching the pre-amendment verifier premise.
  Rejected: it would hide a control that a Builder or Viewer's own click actually succeeds at and
  contradict `W9-PLAN-workspace-create-follows-the-landed-collection-policy`.
- **A `fetch` + client-side cache invalidation for switching**, giving a "smoother" no-reload
  transition. Rejected outright by the card itself: "the simplest correct answer" it names is a full
  navigation, and every alternative reopens the exact auditing problem decision 1 describes.

## Consequences

- The disclosure menu requires JavaScript, so the shell does not offer workspace switching when
  JavaScript is disabled. Once rendered, each switch is a native form submission rather than a
  client-side fetch. Wave 9's supported browser baseline includes JavaScript; sign-in remains the
  recovery route if the shell cannot run.
- A caller whose current membership vanishes is told to sign in again rather than being kept on a
  dedicated in-app recovery screen; this is judged the honest capability of the landed auth surface,
  not a gap this task could close without a route outside its `Owns`.
