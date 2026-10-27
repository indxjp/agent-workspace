# ADR-W9-UI-136 — The `user` filter control is shown from a real probe response, never from a role table

Status: accepted
Date: 2026-09-12
Decided by: W9-UI-136 (implementing agent)
Scope: `apps/web/components/run/history.ts`, `apps/web/components/run/history-screen.tsx`

## Context

The task card: _"The `user` filter control is shown only when the server accepts it (an
`invalid`/`403 user_filter_forbidden` answer hides it, never a client-side role table)."_
`GET /api/runs`'s own grant-to-filter mapping
(`apps/web/server/runs/list-query.ts`'s `parseRunListQuery`) is: the `user` parameter is honoured only for
a caller whose `runs` grant is `any` — today, Owner alone
(`docs/adr/W9-PLAN-the-run-list-card-assumed-an-admin-grant-the-policy-does-not-give.md`) — and any
other grant answers `403 user_filter_forbidden` for `?user=` naming _any_ id, including the
caller's own. This screen has no access to `principal.role` or to `permissions.ts`'s policy table
(both are server-only, and reading the role in a `'use client'` component would be exactly the
role table the card forbids), so it needs a way to ask the server "would you honour this filter for
me" without guessing.

## Decision

**A harmless probe request decides it.** `USER_FILTER_PROBE_ID` is a syntactically valid UUID
(`00000000-0000-0000-0000-000000000000`) that names no real user. `parseRunListQuery` checks the
caller's grant _before_ it checks whether the named id is real, so:

- a grant of `any` answers `200` with an empty page (nobody has this id) — `classifyUserFilterProbe`
  reads this as `'available'`;
- any narrower grant answers `403 user_filter_forbidden`, the exact response the caller would get
  for any other id too — read as `'unavailable'`.

`history-screen.tsx`'s `useUserFilterAvailability` fires this once per screen load
(`GET /api/runs?limit=1&user=00000000-0000-0000-0000-000000000000`), and the filter's `<select>` is
rendered only once the probe answers `'available'`. Nothing about the result is shown to anyone;
it exists only to toggle one boolean.

`classifyUserFilterProbe` fails closed: a response that is neither a clean `200` nor the named
`403` (a `500`, a network error, an unexpected body) is `'unavailable'`, per ADR-0015 — a control
this screen cannot positively confirm the server will honour is not offered.

## Alternatives considered

- **Read `role` from a session/claims endpoint and consult a table mirroring `permissions.ts`.**
  Rejected outright — the task card's own words, and the exact drift risk
  `docs/adr/W9-PLAN-the-run-list-card-assumed-an-admin-grant-the-policy-does-not-give.md` already
  demonstrates happened once at the _planning_ level for this very policy.
- **Show the control always, and only report the `403` inline after a real filter attempt fails.**
  Rejected: it lets a caller believe the filter is available, choose a person, and then be told the
  choice never worked — worse than not offering it, and it also means every OTHER filter combined
  with a still-just-added `user=` would 403 the _whole_ request rather than only failing the one
  facet a person changed.
- **Infer availability from whether the loaded run list already shows more than one distinct
  `initiatingUserId`.** Rejected: it is silent in the common, and very plausible, case of a
  workspace (or a filtered view) where only one person has run anything yet — an `any`-grant caller
  in that state would never see the control, which is a false negative this probe does not have.

## Consequences

- One extra, cheap request per screen load (`limit=1`, matches nothing). Acceptable against the
  cost of either drifting from `permissions.ts` or offering a control that always 403s.
- When issue `#165` widens Admin's grant to `runs: any`, this screen shows the `user` filter to
  Admin too, automatically, the next time the probe runs — no code here changes.
