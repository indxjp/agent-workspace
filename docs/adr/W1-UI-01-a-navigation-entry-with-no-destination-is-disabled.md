# W1-UI-01 — A navigation entry with no destination is visibly disabled, not a link

Status: accepted
Date: 2026-09-03
Decided by: W1-UI-01 (UI)
Scope: `apps/web/components/shell/navigation.ts`, `apps/web/components/shell/sidebar-nav.tsx`

## Context

Spec §44 fixes the main navigation at fourteen entries in two groups, and the mockups' shell
(`ui/assets/app.js`) renders all fourteen as links. (It was thirteen when this was decided; Storage
joined the Administration group with STO-508.) Wave 1 builds one screen inside the shell: the home
chat at `/` (W1-UI-02, spec §19.5 and §45). The other twelve destinations of the time — Projects,
Agents, Files, Skills, Connectors, Runs, and the six administration screens — are Wave 2 and later.

So the shell had thirteen entries and one route. The question is what the other twelve do when
clicked.

## Decision

An entry carries `href: string | null`. `null` states that the destination does not exist, and the
sidebar renders that entry as a `<span aria-disabled="true">` with the design system's own
disabled treatment — `opacity: .62` and `cursor: not-allowed`, the values `.choice.disabled`
already uses in `ui/assets/app.css` for an option that cannot be chosen. It is not a link, it has
no hover state, and it cannot be reached by keyboard as a link.

The list of inert entries is derived from the table, never written in prose:
`navigation.test.ts` asserts that exactly one entry resolves, that it is `home` → `/`, and
enumerates the twelve inert ids. An entry that gains a route and forgets to say so, or an entry
§44 does not list, changes one of those two lists and fails the test by name. Every entry has a
route now, so the inert list the test pins is empty.

`activeNavId()` and `crumbsFor()` both parse the pathname before comparing it and return
`null` / `[]` for anything that is not a path they recognise. Neither falls back to the first
entry (ADR-0015: the malformed case is rejected explicitly, not left to a comparison that happens
to be false).

## Alternatives rejected

**Link all of them and let Next.js answer 404.** It matches the mockup exactly and it is one less
branch in the component. It is also the quiet dishonesty §43 exists to prevent: the row looks
identical to a working one, the click is accepted, and the product answers with an error page that
tells the operator nothing about whether the feature exists.

**Show only the entries that work.** A three-item sidebar is honest and would look tidy, and it
throws away the thing §44 is for — the shape of the product. It would also grow item by item over
four waves, so nobody would ever see the navigation the spec describes until the last one.

**Route the twelve to a shared "not built yet" page.** Twelve real routes and a page nobody
designed, to say what a dimmed row says without a click.

## Downside, stated honestly

**The disabled rows carry no reason.** `.choice.disabled` in the mockups is always accompanied by
a sentence saying why (`"Not configured — no task definition registered."`); a sidebar row has no
room for one, and inventing a tooltip is exactly the convenience §43 warns loses the calm. So the
rows are dim and inert and unexplained, and an operator has to infer "not built yet". Adding the
explanation is a decision for whoever builds the first administration screen and can see the
pattern across more than one wave.

**Recent chats are not rendered.** §44 puts them directly under "New chat", capped at about ten,
with a "See all" into Runs, and the mockup shows four. Wave 1 has no session list to draw them
from — W1-DB-01 created the `sessions` table, but reading it needs a query this task does not own,
and the "See all" destination does not exist either. Four invented chat titles would be demo data
shipped as product. The block is therefore absent, which is a visible difference from
`ui/home.html` in this task's own side-by-side, and it is named here rather than left to be found:
**the task that gives `Runs` a destination should add the recent list at the same time.** Since
`apps/web/app/(shell)/layout.tsx` belongs to this task's globs, that task will need to touch it.
