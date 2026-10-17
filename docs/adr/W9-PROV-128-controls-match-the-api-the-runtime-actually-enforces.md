# W9-PROV-128 — Edit/rotate/remove controls are shown to any signed-in workspace member, matching what `/api/model-connections` actually authorises today

Status: accepted
Date: 2026-09-11
Decided by: W9-PROV-128 (implementer)
Scope: `apps/web/components/models/provider-detail.tsx`, `apps/web/components/models/models-screen.tsx`

## Context

This task's card carries a Verifier attack (the Wave 9 plan §W9-PROV-128) reading:

> Sign in as **Builder**, open the Models area, and assert edit/rotate/delete controls are absent;
> then issue `PATCH` and `DELETE` with that cookie and assert the server refuses both.

The card's own `Deliberately not built` section, in the same breath, reads: _"No change to any
API, route or server file."_ These two sentences cannot both be satisfied by this task: the second
half of the attack — the server refusing a Builder's `PATCH`/`DELETE` — is not something a change
to `apps/web/components/models/**` or `apps/web/app/(shell)/admin/models/**` can produce.

Tracing the actual runtime confirms this is not a misreading. `apps/web/instrumentation-node.ts`'s
`installModelsApi` wires the models runtime's `resolveActor` from `resolveWorkspace` (workspace
membership only) plus `identifyActor` (`root.resolveMembership`, which does carry a `role`) — and
then discards the role:

```ts
async resolveActor(request) {
  const resolution = await resolveWorkspace(request);
  if (resolution.kind !== 'workspace') return resolution;
  const actor = await identifyActor(request);
  if (actor === null) return { kind: 'forbidden', reason: '...' };
  return { kind: 'workspace', workspaceId: actor.workspaceId, userId: actor.userId, userLabel: actor.userLabel };
  // no `role` field, and nothing downstream ever asks `decide()` about it
},
```

None of the four `/api/model-connections*` route files call `apps/web/server/rbac/http.ts`'s
`authorise()` — the one call that consults `permissions.ts`'s `POLICY` table (which *does* grant
Admin/Owner `MANAGE` and everyone else `none` for the `model-connections` resource; see
`permissions.ts` lines 241 and 267–287). W9-PROV-126's Owns glob is
`apps/web/server/models/**, apps/web/app/api/model-connections/**,
packages/core/src/db/repositories/model-connections*.ts, apps/web/instrumentation-node.ts` — the
exact files a role check would need — and its own card never lists wiring `authorise()` in its
Minimum implementation. The gap is real and predates this task; it is not something this task's
diff introduced.

## Decision

**Read the card's own "no server file changes" as controlling, and the Verifier attack's
server-refusal half as a known, separately-declared gap rather than something this task fakes a
fix for.** Concretely:

1. Edit, rotate and remove controls in `ProviderDetailPanel` and `ModelsList` are shown to **any**
   signed-in workspace member — the same population the API already allows to call `PATCH`,
   `POST .../credential` and `DELETE` today. This is not a regression this task introduces: the
   Add-Provider screen already shows its "+ Add Provider" link and full create form to every
   signed-in member, with no role check, and has since before this task.
2. The panel does **not** hide itself behind an invented `role === 'builder'` check. Issue #128's
   own acceptance criterion — _"Unsupported capabilities are shown as verified server data, not
   hardcoded guesses"_ — cuts the other way from a client-side guess about a permission the server
   does not actually enforce: hard-coding a `role` gate the API itself ignores would assert a
   restriction that is not real, which is a worse dishonesty than showing a control the API
   currently allows.
3. Every mutating request already goes through `formatApiError`, which renders whatever `4xx`/`5xx`
   problem body the server returns, so **if** a future task wires `authorise()` into these routes,
   a `403 forbidden` response is already handled accessibly (an `role="alert"` region with the
   server's message) with no further change to this task's code.

This is declared as gap **G-6** in the PR body: the Builder-refusal half of this card's Verifier
attack cannot pass until a task inside `apps/web/server/models/**` /
`apps/web/instrumentation-node.ts` (outside this card's Owns glob) wires role-based authorisation
into the models runtime.

## Alternatives considered

- **Hide the controls for any role except `admin`/`owner`, read from a guessed source.** Rejected:
  there is no capability, session, or `/api/model-connections` field that tells the client the
  caller's role today (`ModelConnectionResource` carries no such field, and `GET /api/memberships`
  itself denies Builder under the very `permissions.ts` POLICY table that would be needed to derive
  it — a caller who cannot ask "am I an admin" cannot honestly gate a control on the answer). Any
  source available inside this task's Owns glob would have to be scraped from the shell's rendered
  DOM (`apps/web/components/shell/identity.ts`'s `roleLabel`) — fragile, undocumented coupling to a
  sibling task's markup, and still would not make the underlying API call actually refused.
- **Widen this task's Owns glob to `apps/web/server/models/**` /
  `apps/web/instrumentation-node.ts` and wire `authorise()` in.** Rejected: both are W9-PROV-126's
  declared Owns glob for this wave (the Wave 9 plan §W9-PROV-126, landed on `main` already),
  not files this task introduces or that are unclaimed — widening onto a sibling's already-merged
  glob is exactly what the execution protocol calls an undeclared-scope escalation, not a declarable
  extra glob under ADR-0018's precedent (that precedent is for a file *no* task claims).
- **Do not build the remove/rotate/edit UI at all until server-side RBAC exists.** Rejected: the
  card's Minimum implementation is explicit about building these three flows now, and the rest of
  issue #128's acceptance criteria (editable fields, write-only rotation, guarded removal, accessible
  error states) are fully buildable and independently valuable without the RBAC gap being closed
  first.

## Consequences

- The client and the server agree on who can act, today — a Builder who tries these controls
  succeeds, exactly as a Builder who calls the routes directly with `curl` already does. Nothing in
  this diff narrows or widens who can mutate a model connection.
- The verifier's Builder-refusal scenario reads as a legitimate open gap (G-6) rather than a defect
  this task tried and failed to fix, and it names exactly which files a future task must touch to
  close it.
- When a later task wires `authorise()` into `apps/web/server/models/**`, this task's UI needs no
  follow-up change for the *forbidden* path (already handled via `formatApiError`); it would still
  benefit from a follow-up to hide the controls once a real capability signal exists.

## Related

- `docs/adr/W9-PROV-126-atomicity-within-owns-globs.md` — the same "the sibling file the fix needs
  is not in this task's Owns glob" shape, decided the same way: narrow to what is buildable, declare
  the rest as a gap rather than reaching across a wave boundary.
