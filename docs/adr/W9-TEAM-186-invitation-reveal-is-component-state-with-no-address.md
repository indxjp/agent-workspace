# W9-TEAM-186 — The invitation reveal is component state with no address, and its capability is the decision table again

Status: accepted
Date: 2026-09-14
Decided by: W9-TEAM-186 (implementing agent)
Scope: `apps/web/contracts/invitations.ts`; `apps/web/server/team/**`;
`apps/web/components/team/invitation*.ts(x)`; `apps/web/components/team/team-screen.tsx`;
`apps/web/components/team/model.ts` (one rename); `apps/web/components/team/members-table.tsx`
(that rename); `apps/web/app/(shell)/admin/users/page.tsx`;
`tests/browser/team-invitations.spec.mjs`

## Context

Issue #186 adds pending-invitation management to `/admin/users`: list every invitation state from
`GET /api/invitations`, create, resend and revoke through the routes PR #175 landed, and show each
returned plaintext token **once**, in a dedicated reveal that cannot survive navigation, a reload, a
workspace switch or the next action — and that never reaches the URL, storage, logs, analytics or
error text. Two constraints shape everything below: *"hide unauthorized controls while retaining
server-side refusal as the security boundary"*, and *"no invitation API change"*.

Facts about the tree that constrained the answer:

- `InvitationSummary` (`apps/web/server/rbac/directory.ts`) carries `id`, `email`, `role`,
  `invitedBy`, `expiresAt`, `acceptedAt`, `revokedAt`, `createdAt`. There is **no state field and no
  token field**, so the four states #186 asks for must be derived from timestamps, and the list
  response can never carry a secret.
- The plaintext token is returned **only** by create (`201`) and resend (`200`)
  (`apps/web/server/invitations/handlers.ts`), each with a `warning` sentence saying it is the only
  time it is shown. `createManualLinkInvitationSender` returns the *relative*
  `/accept-invitation?id=…&token=…`, so the link **is** the secret.
- §21 grants `invitations` to Owner and Admin; Builder and Viewer have no entry and fall to the
  `NOTHING` fallback, so all four routes answer them `403`. `resend` is a declared sub-resource
  (`apps/web/server/rbac/declarations/W9-TEAM-121.ts`) and inherits those grants.
- `conferRole` decides which role a permitted caller may name, and it is **reflexive**: a Viewer's
  conferral set is `['viewer']`. So "may invite at all" and "which role" are two independent checks,
  and a form gated on the conferral set being non-empty would be gated on the wrong one.
- A bfcache-restored document preserves React state across a full navigation and back. The shell
  reloads a restored entry from its own `pageshow` handler
  (`apps/web/components/shell/workspace-switcher.tsx`), but that is another component's promise.
- This repository has **no jsdom and no Testing Library**. A component test is one
  `renderToStaticMarkup` pass with no effects, so an async state is testable only as a prop.
- This build has exactly one credential path — the bootstrap administrator, an Owner
  (`tests/browser/harness.mjs`) — so no browser spec can sign in as a Builder or a Viewer.

## Decision

**1. Both team capabilities are resolved on the server, from the same `decide()` and `conferRole`
the routes call, and handed down as props.** `server/team/invitation-capability.ts` asks `decide()`
for `GET`/`POST /api/invitations` (`ownership: 'not-applicable'`) and for
`POST /api/invitations/:id/resend` and `DELETE /api/invitations/:id` (`ownership: 'unknown'`) — the
exact values those four route files pass — and asks `conferRole` which roles this caller may invite.
`invitation-capability.test.ts` compares every cell against `decide()` and `conferRole` themselves
rather than a transcription of §21, so a resolver that stopped asking them fails.

`InvitationCapability` is a **separate contract** from `MembershipCapability`, not extra fields on
it. They are different resources with different grants, and one value answering for both would let a
change to §21's `memberships` clause silently move an invitation control. `team-screen.test.tsx`
pins that by rendering each capability full while the other denies.

**The counterpart of "the invitable set is the server's" is that the form pre-selects nothing.**
`EMPTY_INVITATION_DRAFT` is `{ email: '', role: null }` and the role `<select>` opens on a disabled
`Choose a role` placeholder, so every invitation's grant is an explicit choice. Neither alternative
is available: naming a default role in the browser — `'viewer'` — is the client-side role policy
#186 forbids, and taking the first of `invitableRoles` takes the **most privileged** one, because
`conferrableRolesFor` filters `ROLES = ['owner', 'admin', 'builder', 'viewer']` in that order and
`invitation-capability.test.ts` pins an Owner's set as all four. That default made the screen's
easiest action — type an address into an untouched form, press the already-enabled button — a grant
of workspace ownership, and `createInvitation` restored it after every create, silently replacing a
deliberate "Viewer" before the next invite. `roleFrom` maps the placeholder's `''` back to `null` and
`invitationRequestFrom` refuses a `null` role, so the submit control is inert — and out of the tab
order — until someone picks. `invitation-form.test.tsx` asserts no role option carries `selected` on
a fresh Owner form and that an address alone does not enable the button;
`tests/browser/team-invitations.spec.mjs`'s keyboard scenario chooses a role and asserts the created
invitation carries it.

**2. One session and directory resolution answers both.** `server/team/team-viewer.ts` does
`findUserByEmail` + `membershipsForUser` + the workspace match + `parseRole` once and returns
`{ userId, role } | null`; `server/team/team-capability.ts` composes the two capabilities from it.
Two independent resolvers would double those reads on every render of the same page for an answer
that cannot differ between them — and a second answer that *could* differ, read a moment later,
would be worse than the cost. `resolveMembershipCapability` and `membershipCapabilityFor` are
replaced by `membershipCapabilityForViewer`, which is pure; #185's matrix is unchanged in behaviour
and its resolution paths moved to `team-viewer.test.ts` and `team-capability.test.ts`.

**3. The token lives in one `useState`, in one component, and has no address.**
`components/team/invitations-section.tsx` holds `revealed: RevealedInvitation | null` and nothing
else in the program holds a token: no context, no ref, no module-level cache, no `localStorage`, no
`sessionStorage`, no query string, no `router` call. The response body is not stored either —
`revealIssuedInvitation` destructures it into three strings and the parsed object, `token` field
included, is unreachable the moment it returns.

There is deliberately **no reveal route and no reveal dialog addressed by URL**: to get a secret to
an addressable destination it would have to travel in the URL or in storage, which is the leak
itself.

**4. The link is rendered as text in a `<code>`, never as an `<a href>`.** An anchor is one click
from putting the token in the address bar, in `document.referrer` for the next navigation, and in
browser history — three of the five surfaces #186 names, reached by a control that looks helpful.
`invitation-reveal.test.tsx` asserts the element contains no `href` at all, that the token occurs
**exactly once** in the document, that the occurrence is element text rather than any attribute
value, and that it is inside the reveal.

**5. The reveal is cleared on five events, and each has a named mechanism.** Action completion —
`clearReveal()` runs at the top of create, resend and revoke, so a second action never leaves the
first one's secret behind and two are never on screen. Unmount and client-side navigation — React
destroys the state with the component. Reload and a workspace switch — both are full document
navigations (the switcher submits a form to `/api/auth/workspace`), so no React state survives.
Back into a bfcached document — this screen drops the reveal on its own `pagehide` rather than
depend on the shell's `pageshow` reload. `pagehide` and not `unload`, because registering an
`unload` handler excludes the document from the bfcache entirely, which would hide the case instead
of closing it.

`clearReveal()` also owns where focus goes, because Dismiss is inside the element it removes: when
the focused element is within the reveal, focus moves to the section's `h2` (`tabIndex={-1}`) before
the state is dropped. Otherwise `document.activeElement` would fall to `<body>` and the next Tab
would restart from the top of the page — the failure `team-screen.tsx` already documents for the
removal dialog. Focus that was never inside the reveal, such as the table's own Resend control, is
left where it is.

**6. The four states are derived client-side with a fixed precedence: revoked → accepted → expired →
pending.** The wire row carries timestamps and a row can satisfy several at once, so the answer has
to be stable. The order follows the server's own order of refusal, and revoked beats expired because
revocation is the deliberate act while expiry is the clock — only one of the two tells a person why
nothing can be done with the row. Expiry uses `<=`, matching the accept path, so a row whose expiry
has exactly arrived is not called pending.

**7. An expired invitation is resendable; an accepted or revoked one offers nothing.**
`resendInvitation` has no `expired` outcome and the repository mints a fresh expiry with the fresh
token, and it has to be offered: the pending-uniqueness index is partial on "neither accepted nor
revoked", so a fresh `POST` for the same address is `409 already_invited` while the stale row sits
there. Accepted and revoked rows carry a sentence saying where the person is managed now, rather
than a disabled control.

**8. Every typed refusal is rendered in the server's own words, with exactly one addition.**
`409 already_invited` already ends with *"Resend it, or revoke it before sending a new one"*;
`409 already_accepted`, `409 invitation_revoked`, `403 forbidden_role_conferral`, `400 invalid_field`
and `503 invitations_runtime_not_configured` are all worded by the handlers in prose a person can
act on. The one sentence added is for `404 no_such_invitation`, which PR #175 deliberately made
byte-identical for a foreign id and a nonexistent one — so the server *cannot* say which, while the
client can say the true thing: the row it was showing is gone and the list is stale.

**9. A read the screen cannot parse says so, and quotes nothing.** A malformed list is `null` rather
than an empty table, because an empty table is a claim a malformed response is no evidence for. A
malformed *create* response is the security-relevant case: the body still has a token in it, so the
failure text names no fragment of it and tells the inviter to revoke the invitation and send a new
one — the invitation exists, only its link is gone.

A malformed *resend* response quotes just as little but names the opposite remedy. Nothing was
created: the row already existed and the server minted a replacement token for it, so revoking would
destroy a live invitation over a parse failure, where resending rotates the token once more and
costs nothing. `UNREADABLE_ISSUED` and `UNREADABLE_RESENT` are therefore two sentences, not one
reused.

**10. Copy uses `navigator.clipboard.writeText` on the absolute link, and every failure is one
state.** The absolute link is composed in the browser with `new URL(link, window.location.origin)` —
a client-side composition, not an API change — because a relative path is not something a person can
paste to an invitee. The call is not guarded by a feature test; it is wrapped, because every way it
can fail (no clipboard outside a secure context, an unfocused document, a denied permission) is the
same answer to the person. The rejection value is deliberately **not read**: it is the one error
path here whose message a browser could build from the string it was asked to copy.

**11. `formatJoinedAt` is renamed `formatTeamDate`.** Both tables print a date from an ISO timestamp
and the members-only name would have forced either a second copy of the same four lines or an import
that lies about what it formats. Behaviour-preserving, three call sites.

## Alternatives rejected

- **A client-side role or conferral table** — #186 forbids it, and it would drift from
  `permissions.ts` and `conferral.ts` silently.
- **Pre-selecting a role in the invite form** — the first of `invitableRoles` is the most privileged
  one, and any other choice is a role policy named in the browser. See decision 1.
- **Reusing `MembershipCapability.canChangeRole` as a proxy for "may invite"** — a different
  resource with a different grant. They coincide for Owner and Admin today, which is exactly what
  makes it a trap.
- **A capability probe** — the only probe available is `POST /api/invitations` itself, which creates
  a durable row, mints a token and writes an audit event. #185 rejected a probe for less.
- **A second independent `resolveInvitationCapability()`** — duplicates two directory reads per
  render, and can answer from a moment later than the members half.
- **Folding invitation fields into `MembershipCapability`** — one contract answering for two
  resources with different grants.
- **A dedicated reveal route, or a dialog addressed by URL** — the token would have to travel in the
  URL or in storage to get there.
- **Rendering the link as an `<a href>`, or a mailto** — the URL, referrer and history leak in
  decision 4. A mailto adds the operating system's mail client and its drafts folder.
- **Keeping the whole create/resend response body in state and reading `.link` at render** — the
  `token` field would be in React state, in the component tree, and in any future devtools dump, for
  no benefit.
- **Asking the API for a computed `state` field** — an API change #186 puts out of scope; the
  timestamps are sufficient.
- **Filtering accepted and revoked rows out of the list, or paging** — server-side filtering is an
  API change #186 excludes, and hiding rows the route returned would make the table disagree with
  `409 already_invited`. See the consequences below for the volume this leaves.
- **`beforeunload` or `unload` instead of `pagehide`** — `unload` opts the document out of the
  bfcache, which removes the observation rather than the leak; `beforeunload` does not fire for a
  document entering the bfcache at all.
- **A feature test for `navigator.clipboard` before calling it** — `Navigator.clipboard` is typed
  non-optional, so the test is either a lie to the compiler or a suppression, and the wrapped call
  handles strictly more failures.
- **Showing the raw token beside the link** — a second element carrying the secret, when #186 asks
  for one.
- **Putting the invitations section inside `TeamScreen`** — the state that must be provably held in
  one place would be mixed with the members state, in a file already near the ~500-line review
  threshold.

## Consequences

- No database change, no migration, no new route, no API contract change, no new dependency.
  Rollback is reverting the PR.
- `/admin/users` now issues a second list read on load, and the page resolves two capabilities from
  one directory resolution. Blast radius is that screen; `server/team/membership-capability.ts`'s
  behaviour is unchanged and its matrix test is the guard.
- **The list is unbounded.** `GET /api/invitations` returns every invitation the workspace has ever
  sent, with no paging, and this table renders all of them. A long-lived workspace will render a long
  table. Narrowing it needs either a server-side filter (an API change #186 excludes) or a
  client-side toggle that would hide rows the route returned; the honest version is to show what the
  server sent and record this.
- **`invitedBy` is not rendered.** It is a `users.id`, #186's scope does not ask for an inviter
  column, and resolving it would mean joining ids against the member list in the browser.
- **Every invitation costs one more interaction.** The form cannot be submitted from an address
  alone, and a repeat invite has to pick a role again because the successful create resets it. That
  is the intended trade: the alternative is a grant nobody chose, and the only default available was
  the most privileged one.
- **The reveal cannot be recovered.** That is the requirement, and it has a cost: a person who leaves
  the screen, reloads, or lets an action complete before copying the link has no way back to it. The
  way forward is resend, which mints a new token — the reveal says so, and so does the form.
- **Declared gap 1 (G-10, still open): no email delivery.** `SendInvitation` ships manual-link mode
  only, so the reveal *is* the delivery mechanism and the inviter relays it by hand. The form and the
  reveal both say so rather than implying mail was sent.
- **Declared gap 2: no `/accept-invitation` page exists.** The link the API returns points at a path
  this deployment does not serve; only `POST /api/invitations/:id/accept` exists. This PR reveals the
  link as-is and words it as a manual relay, because #186's scope is the Team screen and its
  Out-of-scope section says a missing contract is a separate prerequisite rather than an expansion of
  this PR. Until that page lands, an invitee cannot redeem the link from a browser.
- **Declared gap 3: Builder and Viewer scenarios cannot be driven through a browser.** One credential
  path exists, and neither `POST /api/users` nor acceptance writes a password, so an unauthorized
  *session* cannot exist here — `team-members.spec.mjs` and `projects-archive.spec.mjs` declare the
  same gap. The equivalent coverage is `server/team/invitation-capability.test.ts` (the UI's answer
  equals `decide()`'s and `conferRole`'s for the whole matrix),
  `server/rbac/authorisation-matrix.test.ts`, `server/rbac/routes.test.ts`, and the two component
  tests that assert no control renders under an all-deny capability. ADR-0035 is the rule this
  follows.
- **Declared gap 4: the browser cannot prove the old token stopped working after a resend.**
  Acceptance requires the dedicated `__Host-aw_invitation_identity` cookie, which no signed-in tenant
  session carries, so both the old and the new token would be refused for that reason rather than for
  rotation. The browser spec proves what it can — the tokens differ, the id does not, and only the
  replacement is on screen — and server-side single-use and rotation are covered against the
  repository by PR #175's own suites. The unauthorized direct call the spec *does* make is the
  cross-tenant one: a session for one workspace is pointed at the other's invitation id, and both
  `resend` and `revoke` answer `404` with bytes identical to a nonexistent id.
- **An API-key refusal is not asserted in the browser.** A fetch from a signed-in page carries the
  session cookie, so `authorise()` builds a session principal and the handlers' `api-key` branch is
  never reached. It is covered in `server/invitations/routes.test.ts`, where it is real.
