# W1-CP-05 — The route inventory compares three sets, and the specification is one of them

Status: accepted
Date: 2026-09-03
Decided by: W1-CP-05 (Control Plane)
Scope: `tests/route-inventory.test.ts`; binding on every task that adds an HTTP route to
`apps/web/app`

## Context

Plan §9.1 names "a route-inventory test asserting the API surface equals §34" as one of the
programme's mechanical gates, and W1-CP-05's acceptance line requires that the implemented surface
equal the §34 subset for this wave with no extra routes. Spec §34's own instruction is "expose a
very small control-plane API", and the way that instruction is lost is never one big decision: it is
a search endpoint, then a bulk endpoint, then a count endpoint, each defensible on its own.

Four questions had to be settled before the gate could be written, and none of them is answered in
the plan.

1. What is the expected set compared *against* — a list in the test, or the specification?
2. How does a **sibling branch's** routes reach the list, when that branch cannot edit this file?
3. What does the gate do when it cannot read what it is supposed to read?
4. Which files on disk *are* route handlers?

Question 4 was answered wrongly in the first version of this gate and is why this record has been
amended. The answer given was a hand-written set of filenames — `route.ts`, `route.tsx`,
`route.js`, `route.mjs` — introduced by a comment asserting it was "exactly the set Next.js turns
into route handlers". It was wrong in both directions. Under the default `pageExtensions`,
`route.jsx` **is** served and was not read, so `apps/web/app/api/agents/sneaky/route.jsx` was a
sixth agent route that Next.js served (`next typegen` emitted `"/api/agents/sneaky"`) while the
gate stayed green; `route.mjs` is **not** served and was read. A gate whose blind spot is a
filename is not a gate, and a hand-written list next to a claim of completeness is how that blind
spot gets made.

## Decision

**1 — Three sets, compared in order: specification, declaration, filesystem.**

* `specRoutes()` parses the `` ```text `` block under `# 34. API Design` out of `docs/spec.md` at
  test time. It is never transcribed, so amending §34 moves the gate with it.
* `EXPECTED_ROUTES` is the only hand-maintained list: one entry per route, each naming its owning
  task and whether it has landed.
* the filesystem walk reads every route handler under `apps/web/app` — Decision 4 says what
  counts as one — and derives `METHOD /path`.

Every declared route must be a member of the parsed §34 set, so a route can be declared only after
the specification names it. The landed subset must then equal the filesystem exactly. A new route
file with no entry fails; an entry with no route file fails.

**2 — A sibling's routes are listed with `landed: false`.**

W1-CP-04 owns `POST /api/agents/:id/runs` and `GET /api/runs/:id/events` and cannot edit this file:
it is in W1-CP-05's `Owns` globs, and the two branches are siblings at the same stack level. Both
routes are listed here with `landed: false`, which means "§34 names it, it is not on this branch,
and the merge that brings it in flips this flag". The test fails until the flag is flipped, and the
failure message names the entry and the one-word edit.

**3 — Every reader in the gate throws rather than under-reporting.**

A missing §34 heading, a missing code fence, a fence that yields no routes, a missing
`apps/web/app`, a route file that exports no HTTP method, a segment shape the mapper does not
recognise, handlers re-exported with `export { GET }`, a missing or ambiguous Next config, a
`pageExtensions` this reader cannot interpret, and a file named `route.<ext>` for an extension the
application does not serve — every one of them throws with its reason. None returns an empty set,
and none is a silent skip. ADR-0015's rule is the whole point of the file: an inventory that
silently found nothing, or silently found less, would make every membership assertion pass
vacuously, which is exactly how a surface gate stops being a gate. How many such readers there are
is deliberately not written here — `tests/route-inventory.test.ts` is the list, and a count in
prose is a number that rots (ADR-0016).

**4 — Which files are route handlers is derived from `apps/web/next.config.ts`, not written down.**

Next.js serves `route.<ext>` for every `<ext>` in the application's configured `pageExtensions`,
and that setting is a knob. The gate therefore imports `apps/web/next.config.ts`, reads
`pageExtensions` off the default-exported object, and falls back to Next's documented default
`['tsx', 'ts', 'jsx', 'js']` only when the config declares none. Loading it rather than
pattern-matching the file matters: a `pageExtensions` computed in the config would defeat a regular
expression, and a regular expression that matched nothing would fall back to the default set and be
wrong the moment someone narrowed it.

The classifier that uses the derived set is total and its fall-through rejects. A file whose name
does not begin `route.` is ignored; a file named `route.<ext>` for a configured `<ext>` is a route;
**anything else named `route.something` throws**. The reader cannot tell whether such a file is
dead weight or a route it is failing to see, and the case it cannot decide must not be decided in
favour of "not a route".

The behaviour this rests on was established by experiment against the pinned Next, not from memory.
With an empty `NextConfig`, `next typegen` put `route.ts`, `route.tsx`, `route.jsx` and `route.js`
into `AppRouteHandlerRoutes` and left `route.mjs` and `route.test.ts` out; with
`pageExtensions: ['tsx', 'ts', 'mjs']` it put `route.mjs` in and left `route.js` out. That second
result is what makes reading the config load-bearing rather than decorative.

## Alternatives considered

* **A hardcoded expected list, with no reference to `docs/spec.md`.** Rejected: it makes the gate a
  test of a list rather than of the specification, and a route invented in the list would pass.
* **Deriving the expected set entirely from §34, with no declaration list.** Rejected for the
  opposite reason: §34 prints the *whole* control-plane API, most of which lands in Waves 2–4, so
  the gate would fail from the day it was written until the last wave closed, and would be disabled
  long before that.
* **Importing the route modules to read their exports** instead of reading source text. Rejected:
  a route file may import framework-only modules, so the gate would break for reasons unrelated to
  the surface, and it must keep working without a bundler. The cost of reading text is that a
  re-export is invisible — which is why a re-export is rejected outright rather than ignored.
* **Adding `route.jsx` to the hand-written list.** Rejected, although it was the one-line fix the
  verification round offered. It corrects this instance and leaves the mechanism — a list of
  filenames maintained by hand, beside a comment claiming it is complete — exactly as it was. The
  next person to set `pageExtensions` in `next.config.ts` would reopen the same hole.
* **Shelling out to `next typegen` and reading `.next/types/routes.d.ts`.** This is the most
  faithful oracle available: it is Next.js's own answer. Rejected for now because it makes a unit
  test depend on a build step, a `.next` directory and a several-second run. It is the right
  escalation if `pageExtensions` ever grows logic this reader cannot follow, and the classifier
  throwing on the case it cannot decide is what will surface that day.
* **Warning instead of failing on an undeclared route.** Rejected. `--max-warnings 0` is the house
  style for a reason, and a warning on the one assertion this file exists to make is a decoration.
* **Letting W1-CP-04 own the two entries by splitting the file.** Rejected: two inventory files
  cannot assert "no route outside the union", which is the only assertion that matters. A
  repository-wide invariant needs a single owner, and this task has it for Wave 1.

## Consequences

* **The wave integrator has a mandatory, mechanical step**: merging `aw/w1-04-run-api` requires
  flipping two `landed` flags in the same commit. The test tells them so by name. If they merge
  without it, CI is red on the integration branch — which is the intended place for that
  conversation, and is why this is recorded rather than left as a surprise.
* **W1-CP-04's PR is green without those entries**, because its base branch does not contain this
  file. The gate genuinely does not run over that branch; nobody should read its green CI as
  evidence about the route inventory.
* **Adding an endpoint is now visibly deliberate.** It requires a specification amendment, an entry
  here, and a route file — in that order. That friction is the product of the gate, not a side
  effect.
* **`page.tsx` is out of scope.** Only route handlers are read. Screens have their own gate in
  plan §9.1, and conflating the two would make both harder to read.
* **Setting `pageExtensions` in `apps/web/next.config.ts` now has a second consequence**: it changes
  which files this gate reads. That is the intended coupling and the reason the setting is read
  rather than mirrored. Removing the default export from that config, or adding a second
  `next.config.*`, fails the gate loudly rather than falling back to a guess.
* **A colocated `route.test.ts` under `apps/web/app` would fail the gate**, even though Next.js does
  not serve it. Accepted: this reader cannot distinguish it from a route it is missing, and the fix
  (name it something else, or put it beside the module it tests as every other test in this
  repository does) is cheaper than the blind spot.
* **Later waves inherit a growing hand-maintained list.** If it becomes unwieldy, the fix is to move
  the `landed` flag onto a per-wave grouping — not to relax the equality assertion.
