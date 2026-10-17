# W2-INT-02 — A fixture runs from its own installation, so the gate classifies the package instead of refusing it

Status: accepted
Date: 2026-09-05
Decided by: W2-INT-02 (Wave 2 sub-wave 2a integration)
Scope: `tests/no-sdk-import.test.ts`

What [ADR-0032](0032-an-unresolvable-bare-specifier-inside-a-research-fixture-is-a-verdict-not-a-refusal.md)
cost in the gate, what each clause is proved by, and — per
[ADR-0031](0031-a-static-gate-cannot-be-complete-so-undecidable-must-mean-refused.md) clause 2 —
where the new verdict's reach ends.

## The failure this started from

On the union of the six sub-wave 2a branches, `tests/no-sdk-import.test.ts` was red on exactly one
assertion, with 31 entries:

```
FAIL |tests| no-sdk-import.test.ts > the §42 boundary gate can actually run
     > found no module reference it cannot decide
AssertionError: module references this gate cannot resolve; it refuses to pass over them:
  expected [ …(31) ] to deeply equal []
Tests  1 failed | 85 passed (86)
```

The 31 are nine R-06 probe files importing five subpaths of `@modelcontextprotocol/sdk`, which no
`package.json` here declares and which is absent from `node_modules`. Neither branch is defective;
ADR-0032's Context has the diagnosis and ADR-0019 has the reason it is fixed at this level.

## What was built

One new classification in the gate, reached only when three conditions hold together, plus the
named set it produces.

* **`packageNameOf(specifier)`** — the package a *bare* specifier names, or `null`. Every `null` arm
  is a positive rule with its reason beside it: relative, absolute, `#`-prefixed subpath import,
  scheme-carrying URL, and a lone `@scope` with no name. This is where clause 2 lives.

* **`namesPackage(text, packageName)`** — does a README name this package? A containment test *with
  boundaries*: a match is rejected when the character before or after continues a package name, so
  `@modelcontextprotocol/sdk-experimental` does not document `@modelcontextprotocol/sdk`, while
  `…/sdk@1.30.0` (a version pin) and `…/sdk/client/stdio.js` (a subpath) both do. A plain
  `includes` here would have been the fail-open shape clause 3 exists to close.

* **`researchFixtureReadme(file)`** — the nearest tracked `README.md` at or above a fixture. The
  climb is bounded at **both** ends: a file outside `docs/research/fixtures/` gets `null` before the
  walk starts, and a file inside it stops at the fixture root rather than continuing into `docs/`.
  The lower bound was added because the assertion below found it missing — the first version
  returned the research README, a research-note checklist with nothing to say about anybody's
  installation, for a path that is not a fixture at all.

* **`decideUnresolvedReference(file, reference, readmeFor)`** — two verdicts and no third path:
  `refused` (the ADR-0031 hard failure, with the reason naming which condition failed and the ADR
  clause it comes from) or `undeclared-package` (the ADR-0032 classification, carrying the package
  and the README it rests on). The README arrives through a **parameter** rather than being read
  inside, which is what lets the clause-3 red proof run against a stub instead of editing a
  committed README.

* **`PACKAGES_A_FIXTURE_INSTALLS_FOR_ITSELF`** — the literal the classified set is compared against,
  today `['@modelcontextprotocol/sdk']`, with the R-06 install line quoted beside it.

Nothing else changed. No directory exclusion was added, no dependency was declared, and no fixture
was modified — ADR-0032 rejects all three with reasons.

## Each clause, proved by something that was run

Every proof below was run in the worktree by planting a real tracked file or editing a real README,
watching the gate go red, and reverting. The committed assertions use constructed fixture paths, the
way the shape rule above them is already exercised, so nothing plants a file under a tree a parallel
worker may be walking ([ADR-0019](0019-repo-wide-gates-belong-to-the-integration-level.md) clause 4).

**Clause 1 — the set cannot grow silently.** A tracked `probe-tenth.mjs` importing
`@modelcontextprotocol/server-filesystem/index.js`, *with the package named in the README* so that
clause 3 was satisfied and clause 1 was isolated:

```
× names every package a fixture imports that this repository does not declare
+   "@modelcontextprotocol/server-filesystem",
    expected [ '@modelcontextprotocol/sdk', …(1) ] to deeply equal [ '@modelcontextprotocol/sdk' ]
Tests  1 failed | 92 passed (93)
```

A documented, correctly classified tenth package still fails the gate by name. That is the whole
difference between this and a directory exclusion, which would have said nothing.

**Clause 2 — a broken relative import in a fixture is still refused.** A tracked
`docs/research/fixtures/R-06-mcp/probe-broken-relative.mjs` containing
`import './no-such-sibling.mjs';`:

```
× found no module reference it cannot decide
+   "docs/research/fixtures/R-06-mcp/probe-broken-relative.mjs: an import declaration names
     \"./no-such-sibling.mjs\", … A relative or absolute reference points at a file this repository
     contains wherever it is written, so one that resolves nowhere is a broken link and is refused
     here exactly as it is everywhere else (ADR-0032 clause 2)."
Tests  1 failed | 92 passed (93)
```

**Clause 3 — the README is what the verdict rests on.** The package name replaced throughout
`docs/research/fixtures/R-06-mcp/README.md` (`grep -c` went to 0), nothing else touched:

```
× found no module reference it cannot decide
× names every package a fixture imports that this repository does not declare
× reads a README name as a name, not as a prefix of a longer one
+   "…: an import declaration names \"@modelcontextprotocol/sdk/client/index.js\", … and
     docs/research/fixtures/R-06-mcp/README.md does not name @modelcontextprotocol/sdk, so the
     verdict rests on nothing. Name the package in that README, beside the install command a
     reader runs, or stop importing it here (ADR-0032 clause 3)."
```

All 31 classifications turn back into refusals the moment the documentation goes away. The verdict
is not a property of the directory; it is a property of somebody having written the package down.

**Clause 4 — `fixtureConsumers` is untouched and still bites.** It was not edited, and it **passes**
on the shipped tree. It is independent of resolvability — it fires on references that resolve
perfectly well — which the proof shows: a tracked `apps/runner/src/consumes-probe.mjs` importing
`../../../docs/research/fixtures/R-06-mcp/probe-wire.mjs`, a path that resolves:

```
× permits the fixtures because nothing consumes them, and checks that rather than assuming it
+   "apps/runner/src/consumes-probe.mjs",
Tests  1 failed | 92 passed (93)
```

Its failure message also shows the other half of the safety, unchanged by this work: the R-06
probes' `@anthropic-ai/claude-agent-sdk` imports still resolve through the confined-package arm to
`node_modules/.pnpm/…/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, so §42 still sees every probe that
reaches the SDK. The new verdict took nothing out of the detected set.

## Where this verdict's reach ends

Stated as limits, not as coverage. ADR-0031 clause 2: a security gate that overstates itself is
worse than one honest about its edge, because the overstatement is what stops the next reader
looking.

* **It says nothing about what the package is or does.** The gate never resolves, downloads or
  inspects `@modelcontextprotocol/sdk`. It records that a fixture names a package this repository
  does not declare and that a README names it too. Whether the package a reader installs is the one
  the README names, whether the install line still works, and whether that package is safe are all
  outside it.

* **The README check is prose matching.** `namesPackage` compares text with name boundaries. A
  README that names a package in a sentence saying "we do *not* use it" satisfies clause 3 just as
  well as an install line does. The clause buys *a human wrote this down*, not *a human wrote this
  down correctly*.

* **It rests on the fixture tree being imported by nothing**, and that is not assumed here — it is
  `fixtureConsumers`, which is a separate assertion with its own control. If the fixture permit is
  ever widened, that is the assertion to read first, not this one.

* **The classification is bounded by a hand-maintained literal**, so it is exactly as current as the
  last person to edit it. It cannot go silently stale in either direction — that is the set equality
  — but a stale entry is a red gate, not a wrong answer, and somebody has to act on it.

* **`@anthropic-ai/claude-agent-sdk` reaching this verdict would be a silent §42 hole**, because a
  classified reference is not a detected one. It cannot happen today: the SDK resolves through the
  confined-package arm. The gate asserts by name that the SDK is not in the classified set, with a
  message saying to repair that arm rather than the literal — that control is the reason this
  clause is safe, and it is the first thing to check if §42 ever goes quiet.

* **Unchanged from before, and still true:** an untracked file under `docs/research/fixtures/` is
  invisible to all of this, `eval` and `new Function` are outside the gate's reach entirely, and a
  specifier arriving through a parameter or a computation is not seen. This work narrowed none of
  those and widened none of them.

## Result

`Tests 93 passed (93)`, from `1 failed | 85 passed (86)`. Seven assertions added, one behaviour
changed, no fixture or README edited, no dependency declared, no directory excluded.
