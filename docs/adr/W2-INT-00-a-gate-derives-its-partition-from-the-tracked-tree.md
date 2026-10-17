# ADR-W2-INT-00 — A gate derives its contributing set from the tracked tree by shape, and the shape rule is a classifier

Status: accepted
Date: 2026-09-04
Decided by: W2-INT-00 (repairer, verification rounds 1–3)
Scope: `tests/route-inventory.test.ts`, `tests/screen-inventory.test.ts`, `tests/inventory-support.ts`

## Context

[ADR-0025](0025-the-route-inventory-is-partitioned-by-owner.md) split `EXPECTED_ROUTES` into one
declaration file per owning task so that Wave 2's parallel tracks would not collide on one array. Its
stated consequence is that *"`tests/route-inventory.test.ts` becomes an integration-owned file that
no wave task edits again — the partition means it no longer needs to be edited to add a route"*, and
it rejected the alternative in writing: *"each track's CI would be red until the very last branch —
so no track would ever be green on its own, which is the property the stack is for."*

The first implementation of that split falsified its own consequence in the same commit. Two
assertions in the route gate, and two more in the screen gate, enumerated the gate's own inputs as
literal lists of member paths:

* `tests/route-inventory.test.ts` listed the two `tests/route-declarations/*.ts` files that existed,
  and the five route files that existed. Five of Wave 2b's six tracks add a declaration file and a
  route file; both are inside that track's `Owns` globs, and `tests/route-inventory.test.ts` is
  inside none of them, so every one of those branches was red on a file it could not edit.
* `tests/screen-inventory.test.ts` listed the nine `tests/screen-declarations/*.ts` files, which
  blocked the migration that
  [W2-INT-00-the-screen-inventory-declares-mockups-by-owner.md](W2-INT-00-the-screen-inventory-declares-mockups-by-owner.md)
  decision 5 and `tests/screen-declarations/W2-INT-00.ts`'s own header both instruct a later wave to
  perform; and it compared the derived `unplanned` set against a hard-coded three-element literal,
  three lines under a comment claiming the set *"shrinks by itself as waves claim these screens"*.

A second failure of the same family sat next to it. The screen gate's mockup rule,
`/^ui\/[a-z0-9-]+\.html$/`, was applied to `git ls-files -- ui` with `Array.filter`. A tracked
`ui/agent_detail.html` or `ui/AgentDetail.html` therefore fell out of the mockup set and the gate
passed with an undeclared mockup in the tree — the fail-open the file's own header says cannot
happen, and the specific attack the task brief asked for. The same restriction appeared in the
plan-mention scanner and in the `ui/index.html` link parser, so such a file was invisible to all
three of the gate's sets at once. The route gate did not have this defect: `classifyAppFile` throws
on `route.<unknown-ext>` rather than skipping it. The difference between the two is one `else`.

The verification round found this shape on three gates by three authors and recorded it as ADR-0027.
This ADR records what W2-INT-00 did about it, because ADR-0027 is a programme-level rule and this
repository's `docs/adr/` holds one file per decision that was taken here.

## Decision

1. **A gate derives its contributing set from the tracked tree by shape.** `git ls-files -- <dir>`
   plus a filename rule, never a literal list of member paths. `declarationOwner` is that rule for
   both declaration directories, and `filterRouteFiles`/`filterPageFiles` are that rule for the app
   directory.

2. **A shape rule is written as a classifier that ends in rejection.** A file at the right path
   whose name does not match the shape is a hard failure naming the file. Named one at a time, each
   with a test that causes its rejection: `declarationOwner` throws on a `README.md`, a `types.ts`
   and a file in a subdirectory; `classifyUiFile` throws on any `.html` under `ui/` that is not a
   top-level kebab-case mockup; `classifyIndexHref` throws on an `href` to an `.html` that is not
   one; `classifyPageFile` throws on `page.<unknown-ext>` as `classifyAppFile` throws on
   `route.<unknown-ext>`; `classifyPlanFile` throws on a document filed under the waves directory that
   names a mockup and no wave (decision 7).

   This decision does not quantify over the rules in a file, and the sentence that used to stand
   here did: *"Every such rule is a classifier that ends in rejection, never a filter."* It was
   false in the commit that wrote it — `planSources()` in `tests/screen-inventory.test.ts` selected
   its corpus with a regex used as a filter, in the same file — and a sentence of that shape is a
   measured claim about code, which [ADR-0016](0016-measured-numbers-do-not-live-in-prose.md) keeps
   out of prose. Where a listing is narrowed and not converted, it is declared by path and line in
   PR #40's enumeration, not summarised here.

3. **The "did I read them all?" assertion is a second derivation, from a wider pathspec.** The
   failure a literal list was there to catch is real: a `git ls-files` gone narrow satisfies every
   assertion below it by having nothing left to compare. `declarationPaths(dir, wider)` enumerates
   `git ls-files -- tests` and selects what sits under the declaration directory, and the route gate
   derives its route files a second time from `git ls-files -- apps/web`. Both are compared for
   equality against what the gate actually read, and both fail if either is empty.

4. **A gate's failure message prints the derived set**, because a reader can no longer find it by
   reading a literal. Each of the derived assertions carries the derivation and its result in the
   assertion message.

5. **A scanner over prose is widened rather than made a classifier.** `MOCKUP_MENTION` reads
   the development plan, which is not a tracked-tree listing and where throwing would be
   over-reach. There the fail-open direction is *under*-reporting — a task card naming a mockup the
   scanner cannot spell schedules nothing, and the `unplanned` declaration for that mockup then
   passes as honest — so the pattern is deliberately wider than the shape rule. Over-reporting a
   mention turns an `unplanned` declaration red, which is the safe direction.

6. **The two gates share one grammar for the boundary they both claim to name.** `underPrivateFolder`
   and `classifyPageFile` live in `tests/inventory-support.ts` and are called by both. Before this,
   both headers claimed the gates *"divide the app directory between them"* and *"each names the
   other's boundary"* while `trackedPages()` neither skipped `_`-prefixed folders nor rejected an
   unknown page extension — so a `page.tsx` under `apps/web/app/_wip/` had to be declared as a
   `shipped` screen at a URL Next.js serves nothing from, and a `page.mdx` was dropped where a
   `route.mdx` was refused.

7. **The plan corpus is selected by location and dated by a classifier.** Round 1 left
   `planSources()` selecting `git ls-files -- docs` with
   `(file) => file === PLAN || <pattern matching only a top-level Wave N plan file name>`. The Wave 2b plan
   — the sub-wave name [ADR-0023](0023-wave-2-owns-globs-are-derived-and-the-wave-is-split.md) gave
   this wave — and the Wave 6 manifest — the noun W0, W1 and W1a filed their dispatch under —
   were each dropped, and the verifier ran both: the gate stayed at 23 passed with a mockup those
   task cards schedule still declared `unplanned`, while the same bytes under a name the regex
   matched turned it red. The corpus is now the development plan, everything tracked under
   the waves directory, and any tracked document elsewhere under `docs/` whose file name is a wave
   document's; `classifyPlanFile` then decides the wave from that name and refuses a document under
   the waves directory that names a mockup without naming a wave. The location rule is not a classifier
   and PR #40's enumeration declares it: most of `docs/` is not plan prose, and an ADR naming a
   mockup is not a task card scheduling it. `docs/adr/W1-UI-02-mockup-content-is-a-fixture-not-data.md`
   and the landing-page design brief are two that do, and
   `git ls-files docs | xargs grep -lo 'ui/[A-Za-z0-9._-]*\.html'` lists more. The sentence that
   stood here named `docs/spec.md` as a third; that command does not list it and
   `grep -c 'ui/[A-Za-z0-9._-]*\.html' docs/spec.md` answers 0. Commit 4045291 corrected this claim
   in `tests/screen-inventory.test.ts` and left the copy of it here standing.

   The same repair closes the fail-open half of the section rule: `planSchedules` throws when a
   `sectioned` document contains no line matching `### <n> Wave <N>`, because a heading shape this
   parser no longer matches would date nothing, and an undated mockup is one every `unplanned`
   declaration is honest about.

8. **The "this gate plants nothing" scan reads the import graph, and its fs rule is an allowlist.**
   Decision 1 applies to the ADR-0019 §4 assertion as much as to the three inventory sets, and
   round 2's version broke it twice: the files scanned were a two-element array of paths written
   next to the assertion, and the calls looked for were seven mutator verbs. A verifier walked out
   of both — a tracked `tests/inventory-extra.ts` holding `mkdirSync`, imported from
   `tests/inventory-support.ts`, and a pair of `unlinkSync`/`copyFileSync` calls inside
   `inventory-support.ts` itself, each left both gates at 61 passed. `gateModules` now follows each
   gate's relative imports transitively and throws on a specifier it cannot resolve, and
   `nonReadingFsAccess` reports every `fs` binding outside a list of **readers** plus every mention
   of the module in a form it cannot decode. The polarity is the decision: a list of permitted
   readers fails closed on a verb nobody anticipated, a list of forbidden mutators does not. Both
   probes were re-run against the repair and each now fails by name.

   Round 4 widened the traversal, for the same reason a third time. `relativeSpecifiers` read a
   line-start `from` clause and a line-start bare import, so a top-level resolver call on a plain
   relative literal — an expression, not a statement, and matched by neither anchored pattern — put
   the module it named outside the scan: the same planted `tests/inventory-extra.ts`, reached that
   way, kept both gates green again. The reader now also decides the resolver-call form and reads
   either quoting, and the forms it follows are a table in `tests/route-inventory.test.ts` rather
   than a claim in a comment. What is still outside it is declared as a gap on PR #40 — a traversal
   enumerates the shapes somebody thought of, which is why the enumeration is executable.

9. **A route file's exports are decoded by a total classifier, not sampled per method.**
   `exportedMethods` asked one regex question per HTTP method with no `else`, so
   `export const { GET } = handlers;` returned `POST` alone and threw nothing — a shipped route
   invisible to the inventory, the one thing the gate exists to prevent. `exportedBindings` now
   decides every line that starts with `export` and throws on a form it cannot decode; `export type`
   is decided as binding no value rather than falling through. `exportedStringConstant` reads the
   `runtime` and `dynamic` declarations through the same classifier, which closes a second
   fail-open: the substring scan they replaced accepted a route really declaring
   `export const runtime = 'edge'` because the `nodejs` spelling sat above it in a comment.

10. **A section parser is bounded by its section.** `specRoutes()` sliced `docs/spec.md` from the
    `# 34. API Design` heading to end of file and took the first ` ```text ` fence in that slice.
    Retagging §34's own fence and moving its lines into `# 35. Observability` left the gate green
    with §34 printing no route at all. The slice now ends at the next top-level heading, and every
    fence inside the section is read, so neither "which section" nor "which fence" is a question
    this parser answers by position. The same round widened the second-stream rule from the literal
    `new ReadableStream` to the identifier on any line of code, because
    `new globalThis.ReadableStream(…)` in a real route file had passed.

## Alternatives considered

* **Add `tests/route-inventory.test.ts` to every 2b track's `Owns` globs.** Rejected: it makes the
  gate a shared mutable resource again, which is the thing ADR-0025 removed, and six branches editing
  one assertion is ADR-0019's union failure in a new costume.
* **Keep the literal and update it in the integration branch after each track lands.** Rejected: it
  means each track is red on its own branch, which ADR-0025 rejected in writing and which is the
  property the stack exists to provide.
* **Make the second derivation identical to the first.** Rejected as a tautology: comparing
  `filterRouteFiles(trackedFiles(APP_PREFIX))` against itself asserts nothing about the pathspec,
  and the pathspec going narrow is the failure being guarded against. A wider one is the only
  version of that comparison that can fail.
* **Widen `MOCKUP_PATH` so unusual mockup names are accepted.** Rejected: the fix for a filter is an
  `else`, not a looser pattern. Widening keeps a decision — "what is a mockup called?" — but moves it
  where nothing can see it, and the three sets would drift apart again the next time one of the
  three patterns was widened and the others were not.
* **Delete the "did I read them all?" assertions rather than derive them.** Rejected: without them a
  narrowed pathspec makes the whole gate pass vacuously, which is the ADR-0015 shape those
  assertions exist to prevent.

## Consequences

* A Wave 2b track that adds `tests/route-declarations/<TASK-ID>.ts` and a route file under
  `apps/web/app/api/` turns both gates green on its own branch, editing only files inside its own
  `Owns` globs. A track that adds the route file and forgets the declaration is still red, with the
  route named — that half is unchanged.
* A later wave can repartition its rows out of `tests/screen-declarations/W2-INT-00.ts` into its own
  declaration file without touching `tests/screen-inventory.test.ts`, which is what decision 5 of the
  screen-inventory ADR promises.
* An `.html` added under `ui/` with a name outside the mockup shape now fails the screen gate by
  name, where before it passed unnoticed. That is a stricter rule than the repository had, and it is
  the rule the file's header always claimed.
* A `page.tsx` under a `_`-prefixed folder is no longer required to be declared as a screen, because
  Next.js serves nothing from one. The route gate has skipped those folders since W1-INT-02; the two
  gates now agree, by calling the same function.
* Both gates now fail if their `git ls-files` returns nothing under the directory they read, rather
  than reporting an empty inventory.
* A wave dispatched as the Wave 2b plan or the Wave 6 manifest now dates the mockups
  its task cards name, where before those documents were dropped. A document filed under
  the waves directory that names a mockup and whose file name says no wave now fails the screen gate by
  name; the waves README and the wave handoff notes name none, and pass.
* the development plan changing its `### <n> Wave <N>` heading shape now fails the screen gate
  instead of silently dating nothing.
