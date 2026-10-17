# W2-INT-01 — The §42 research-probe permit is derived by shape, and `docs/research/fixtures/` is a sound boundary only because nothing consumes it

Status: accepted
Date: 2026-09-04
Decided by: W2-INT-01 (Wave 2 invariants)
Scope: `tests/no-sdk-import.test.ts`

## Context

Spec §42 says all SDK-specific translation is concentrated in one small module, and the
programme states it as an absolute: `apps/runner/src/claude.ts` is the only file that may reach
`@anthropic-ai/claude-agent-sdk`, and `tests/no-sdk-import.test.ts` enforces it.

That gate has always had a second permitted set beside the boundary file — a research note's
committed probe scripts, which import the SDK because executing it is the evidence. Until this
change the set was a constant named `RESEARCH_PROBES` holding literal paths. The history of that
constant is the argument against it:

Pinned to the commit before this change, because this change is itself an entry in that history:

```
$ git log --oneline -S RESEARCH_PROBES 6c89902^ -- tests/no-sdk-import.test.ts
13f0445 W1-RN-01: close the §42 gate over the whole tree, and stop the SDK ty...
4e96932 W1-RN-01: the single SDK translation file, and the gate that keeps it...
```

Both entries are the gate's owner, editing the list after the research had landed — never the
research PR itself. When R-06's note shipped probes that import the SDK, R-06's PR (#39) went red
on a file R-06's `Owns` globs do not cover. R-06 escalated instead of editing it, which
[ADR-0027](0027-a-partition-that-lists-its-members-has-not-been-partitioned.md) records as the
correct move and the standard. ADR-0027 clause 4 assigns the repair here.

The literal had a second defect that is easy to miss. It named the probes that *did* import the
SDK, not the probes that were *allowed* to — `extract-options.mjs` sits in the same directory,
is a probe by every other measure, and imports only `node:fs`:

```
$ sed -n '11p' docs/research/fixtures/agent-sdk/extract-options.mjs
import fs from 'node:fs';
```

So the constant was a list of observed importers wearing the name of a permit, and it went stale
on exactly the event it was supposed to tolerate.

## Decision

**1. Membership is derived from the tracked tree by shape.** A tracked file under
`docs/research/fixtures/` is a research fixture; `git ls-files` decides that, as it already
decides everything else this gate reads. No path is named in the gate.

**2. The shape rule is a classifier with two arms and an `else` that rejects by name.** A fixture
is a `probe` (executable evidence, permitted to import the SDK) or a `capture` (a recorded
artefact or the prose around it, which cannot name a module and needs no permit). Anything else
is `unrecognised`, carrying a reason, and the assertion on that set is that it is empty. This is
ADR-0027 clause 2 and [ADR-0015](0015-gates-decide-on-positive-assertions.md): a file at the
right path with the wrong shape is a hard failure naming the file, never a silent drop.

**3. The probe arm is `.mjs`, narrower than "module source".** The permit exists because a probe
is evidence a reader re-runs by hand, and the fixture README is explicit about how:

```
$ sed -n '20,22p' docs/research/fixtures/agent-sdk/README.md
mkdir probe-r01 && cd probe-r01
npm install @anthropic-ai/claude-agent-sdk@0.3.258
node <path-to-this-dir>/extract-options.mjs        # writes options.json
```

`.mjs` is ES-module source to `node` wherever it is copied. A `.js` there is ESM only because
the repository-root manifest says `"type": "module"`, and becomes CommonJS in the scratch
directory those instructions create, where the `import` on its first line is a syntax error. A
`.ts` probe is worse: no `tsconfig` in this repository includes `docs/`, so it would be committed
TypeScript that no typecheck and no lint reads, holding a §42 permit. The shape is the shape that
runs. Widening it is an edit to `PROBE_EXTENSIONS` with the reason beside it, which is a decision
someone makes rather than a default.

**4. The capture arm is derived from the gate's existing file classifier, not a second table.**
A fixture whose `classifyFile` verdict is `inert` or `structured-data` is a capture, because
those are precisely the kinds this gate has already decided cannot reference a module. `markup`
is deliberately not a capture: an HTML fixture names modules through `src`/`href`, so the day one
is committed somebody decides what it is, rather than this function deciding by silence.

**5. The permitted set and the inspected set fail in opposite directions, and the code says so.**
Dropping a file from the **permitted** set (`researchProbes`) makes the gate *stricter* — the
file becomes an unexpected importer and the §42 equality names it. Dropping a file from the
**inspected** set (`scanned`) makes the gate *fail open* — it is never read. Nothing in this
change touches `scanned`; it is still every module-source and markup file in the tracked tree,
with no directory exclusion. An assertion states that every derived probe is inside `scanned`,
because a permit for a file the gate never reads would be invisible.

The opposite direction — "no capture is scanned" — is asserted on the *classifier*, over a list
of names, and not over the tracked tree. The tree-level form was written first and withdrawn:
`classifyResearchFixture` returns `capture` only where `classifyFile` returned `inert` or
`structured-data`, and `scanned` is built from the files where it returned `module-source` or
`markup`. Those two arms of one classifier share no verdict, so a capture arm that grew a
scanned kind would not show up in a filter over the tree. Adding `markup` to the capture arm and
running the file is what settled it: the name-level assertion goes red, and the fixture tree
carries no `.html`/`.htm` file for the tree-level one to have caught it with.

**6. Failure output prints the derived set** (ADR-0027 clause 4), because a reader can no longer
recover it by reading a literal.

**7. Every alias table in the tracked tree is read, or the file that declares one is named.**
`collectAliases` used to test each tracked file's basename against `package.json` and
`/^tsconfig(\..+)?\.json$/` and `continue` on no match — a filter, and the fail-open kind:
a `compilerOptions.paths` block in a JSON file reached through `extends`, or a `jsconfig.json`,
declared aliases that neither the §42 alias assertion nor specifier expansion could see. It is
now a classifier with three verdicts — `tsconfig`, `package-manifest`, `neither` — and `neither`
is not a skip: a tracked JSON file that carries either alias table under such a name is reported
by name with what to do about it. `packageManifests` is derived from the same rule, so the gate
has one answer to "what is a package manifest".

**8. Names come from `git ls-files`; contents come from the working tree.** The gate asks git
which files exist and reads each from the checkout, consulting neither the index nor a commit.
An uncommitted edit to a tracked file therefore fails the gate while a person can still act on
it; an untracked file is invisible to every assertion here, including one dropped under
`docs/research/fixtures/`. That second half is the boundary being drawn on purpose — the permit
is a statement about what this repository carries, and `git add` is what puts a file inside it —
and it is now stated in the gate's header rather than left to be discovered.

**9. A dependency installed from a path is read as the alias it is.** Added in round 3, from a
counter-example built and run rather than argued: `"probes": "file:../../docs/research/fixtures"`
in `apps/web/package.json` links that directory into `node_modules/probes`, after which a bare
`probes/…` specifier in an `apps/web` route resolves into the permit tree. No
`compilerOptions.paths` entry and no `imports` map is involved, so neither table `collectAliases`
read could see it, and the specifier's own text names no path, so the text arm could not either.
pnpm 11 installs that shape even against a directory carrying no manifest of its own — the
install output names it `fixtures 0.0.0`, a name and version that directory never declared — and
node resolves the subpath:

```
$ cat app/package.json
{ "name": "app", "version": "1.0.0", "type": "module",
  "dependencies": { "probes": "file:../fixtures" } }
$ pnpm install --ignore-workspace
+ probes <- fixtures 0.0.0
$ ls -l node_modules
probes -> .pnpm/fixtures@file+..+fixtures/node_modules/fixtures
$ node main.mjs                 # main.mjs names 'probes/probe.mjs'
RESOLVED 1
```

`collectAliases` now reads the same four dependency blocks the "declared by exactly one package"
assertion reads — one list, `DEPENDENCY_BLOCKS`, so the gate has a single answer to where a
dependency is declared — and turns each `file:`, `link:`, `portal:` or bare-relative value into
two aliases, the key itself and `key/*`, because the target is a directory. `workspace:` is not
one of them; it resolves by package *name*, and the gap that leaves is declared below. A
dependency value that is not a string throws rather than being passed over.

## Why `docs/research/fixtures/` is a sound boundary, and what would make it unsound

Widening a §42 permit from three named files to a directory is a security-relevant change, and
"they are only docs" is not an argument — it is the shape of the argument that ends with a
directory exclusion and a gate that no longer covers the tree it claims to.

The permit is sound because a probe is inert with respect to the product, and that rests on three
independent facts:

* **It is not compiled.** No `tsconfig` in the tree includes `docs/`. Checked by planting a `.ts`
  file at `docs/zz-probe.ts` and another inside the fixture tree, then asking each tracked config
  which files it would actually compile:

  ```
  $ for f in $(git ls-files '*tsconfig*.json'); do \
      printf '%s -> %s docs/ files\n' "$f" \
        "$(npx tsc -p $f --noEmit --listFilesOnly | grep -c '/r3-probeset/docs/')"; done
  apps/runner/tsconfig.build.json -> 0 docs/ files
  apps/runner/tsconfig.json -> 0 docs/ files
  apps/web/tsconfig.json -> 0 docs/ files
  packages/cli/tsconfig.build.json -> 0 docs/ files
  packages/cli/tsconfig.json -> 0 docs/ files
  packages/core/tsconfig.build.json -> 0 docs/ files
  packages/core/tsconfig.json -> 0 docs/ files
  packages/gateway/tsconfig.build.json -> 0 docs/ files
  packages/gateway/tsconfig.json -> 0 docs/ files
  packages/runtime/tsconfig.build.json -> 0 docs/ files
  packages/runtime/tsconfig.json -> 0 docs/ files
  tests/tsconfig.json -> 0 docs/ files
  tsconfig.json -> 0 docs/ files
  tsconfig.root.json -> 0 docs/ files
  ```

  An earlier revision of this bullet argued it from the `include` arrays instead, and said "each
  workspace member's `tsconfig.json` includes its own `src`". That was false —
  `apps/web/tsconfig.json` includes `["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"]`
  — and it was the wrong evidence anyway: what matters is the file list a config resolves to.
* **It is not shipped.** `.dockerignore` excludes `docs/` from the build context, under the
  heading `# 2 — not needed to run the product`.
* **It is not imported.** This is the one that could change without anyone noticing, so it is the
  one the gate now checks. `reachesResearchFixtures` decides a specifier in three arms: a
  relative path, joined onto the importing file's directory; a specifier whose own text spells
  the fixture path; and a bare specifier expanded through the alias table `collectAliases`
  derives — `compilerOptions.paths`, an `imports` map, and a dependency installed from a path —
  with each expansion resolved against the directory of the config that declared it. A file whose
  specifier reaches the tree by any of the three is reported by name.

The third is what makes the first two hold in future. A probe that `apps/` imports is not
evidence any more — it is a dependency with a §42 permit stapled to it, and the SDK has re-entered
the product through a directory the gate was told to trust.

The alias arm is the repair recorded here rather than the original design. The first version of
this control had the first two arms only, and a review of it reproduced the hole: one key added
to the `paths` block `apps/web/tsconfig.json` already carries —
`"@probes/*": ["../../docs/research/fixtures/*"]` — plus `import '@probes/agent-sdk/…'` in an
`apps/web` route, and the gate stayed green. The same held for a `paths` entry in
`packages/core/tsconfig.json` and for an `imports` entry in `packages/core/package.json`. Each of
those three reproductions now turns the consumer assertion red, and the arm carries a positive
control that is red when the expansion is removed: its specifiers are bare names whose own text
does not contain the fixture path, and it asserts the same names are innocent against an empty
alias table.

That arm has two halves, and round 3 found only the first of them controlled. Every alias target
in that test spells the fixture path out in its own text, so `namesResearchFixtures(expansion.target)`
answered before `aliasTargetPath` was ever consulted, and deleting the resolution half left the
whole file green at 54 passed. A separate test now pins that half: its alias target is
`./fixtures/*`, declared in a config at `docs/research/tsconfig.json`, so the target text names
nothing and only the join onto the declaring config's directory can decide the specifier — while
the same target text declared in `apps/web/tsconfig.json` stays innocent. Deleting the resolution
half turns that test red, and so does making `aliasTargetPath` ignore `declaredIn`.

What would make the boundary unsound, in the order it is likely to happen:

1. **Something ships out of the fixture directory.** A build step, a `COPY docs/` in an image, a
   route that serves fixtures as sample data. The import check does not see a copy performed by
   Docker or by a script; a `.dockerignore` edit is the earliest visible signal and is not gated
   here. If fixtures ever become a shipped asset, this permit must be withdrawn, not narrowed.
2. **The probe arm widens to a kind that belongs to a project.** `.ts` is the case to refuse:
   adding it to `PROBE_EXTENSIONS` makes the permit cover files that a later `tsconfig` change
   could pull into a build without touching this gate.
3. **A note commits a probe that is really a library** — imported by a sibling probe today and by
   product code tomorrow. The import check catches the second step, which is the step that
   matters.
4. **An alias mechanism the gate does not read.** The consumer check is only as wide as
   `collectAliases`, and that reads `compilerOptions.paths` from a tsconfig, `imports` from a
   package manifest, and a dependency installed from a path. This is the family the round-3
   counter-example came from, so it is the one to attack next. See the declared gaps below for
   what is outside it.

## Declared gaps

Each of these is a place where a listing is narrowed and the narrowing is judged correct, with
what would make it wrong. ADR-0028's enumeration for `tests/no-sdk-import.test.ts` is in the
pull-request body; these are the ones that are decisions rather than mechanics.

* **`collectAliases` reads alias tables out of JSON only** — a tracked file whose `classifyFile`
  verdict is not `structured-data` is not examined for one. Correct because an alias a *module
  resolver* consults is JSON in this repository: `compilerOptions.paths` for TypeScript,
  `imports` for node, and a path dependency for the package manager.
  What would make it wrong: a bundler alias written in a JavaScript or
  TypeScript config — Vite/Vitest `resolve.alias`, a webpack `resolve.alias`, a Next `webpack()`
  hook. A grep for `resolve:` and the word `alias` over the tracked `.ts`/`.tsx`/`.mjs`/`.js`/
  `.cjs` files, this gate's own source excluded, returns prose and a local variable of that name
  in `tests/sdk-surface.test.ts` — no resolver configuration. Adding one is the event that
  requires this gate to grow a reader for it.
* **A `workspace:` dependency is not read as a path.** `pathDependencyTarget` returns `null` for
  it, because it resolves by package *name* against the workspace members rather than by a path
  written in the manifest. What would make it wrong: `docs/research/fixtures/` becoming a
  workspace member — which takes three separate edits (a `package.json` inside the fixture tree, a
  `pnpm-workspace.yaml` glob covering it, and the dependency itself), at which point the fixture
  tree is a package and this permit is a decision to retake rather than a gap to patch. Today
  `pnpm-workspace.yaml` lists `apps/*` and `packages/*`, and nothing else. Every
  path-shaped dependency value in the tracked tree today is `workspace:*`, twice — read out of
  every tracked manifest's four dependency blocks:

  ```
  apps/runner/package.json dependencies @agent-workspace/core = workspace:*
  apps/web/package.json dependencies @agent-workspace/core = workspace:*
  ```
* **`collectAliases` follows no `extends` chain.** It reads each config in isolation and pools
  every alias it finds, which is wider than any single project's view and therefore the safe
  direction. The chain matters only for a config whose *name* the classifier does not accept, and
  that case is no longer silent: such a file is reported by name. What would make it wrong: a
  tsconfig extending a preset that lives outside the tracked tree — under `node_modules/` — whose
  `paths` would be neither read nor reported. A grep for `"extends"` over the tracked `.json`
  files returns relative paths to `tsconfig.json` and nothing else.
* **A probe importing a sibling probe is not a consumer.** `fixtureConsumers` skips files inside
  the fixture tree. Correct because evidence citing evidence is still evidence, and it is the
  outward direction that converts a permit into a dependency. What would make it wrong: nothing
  in the gate — it is the case listed as unsoundness 3 above, and it is the *second* step that
  this check catches.
* **The import check sees module specifiers, not subprocesses.** A probe run as
  `execFileSync('node', ['docs/research/fixtures/…/probe.mjs'])` is a runtime dependency on a
  probe and names no module, so `fixtureConsumers` cannot see it. Unsoundness 1 above is the same
  family: a `COPY docs/` in an image, or a build step that reads the directory.
* **An untracked file is invisible** — see decision 8. What would make it wrong: nothing, so long
  as CI runs the gate against the commit, which is a checkout where the tracked names and the
  working-tree contents agree.

## Alternatives considered

* **Keep the literal and have the gate's owner extend it each round.** Rejected by ADR-0027; it
  is the enumeration with a human step, and it means no research branch is green on its own.
* **Exclude `docs/**` from the scan.** Rejected for the reason the gate's header already gives:
  an excluded directory is a directory this gate no longer covers, and an SDK importer dropped
  into `docs/` would stop failing anything. The permit is deliberately narrower than an
  exclusion — a fixture is still scanned, still classified, and still has to be a recognised
  probe.
* **Permit any tracked file under the directory.** Rejected: that is derivation without
  classification, ADR-0027 clause 3's fail-open shape. It would have permitted a `.ts` or a `.js`
  without anyone deciding to.
* **Keep one set equality over the whole `importers` array.** Rejected because a probe is
  permitted to import the SDK, not obliged to, so the probe half of such an equality can only be
  written against the probes that were observed importing — which is the literal list again, in a
  derived costume. The equality is stated over the tree *outside* the fixture directory, where it
  keeps both of its original directions (a new importer fails it, and so does the boundary file
  disappearing), and the fixture half is stated as "every importer here is a recognised probe".

## Consequences

* A research note ships its probes with its own PR and touches no gate. That is the property
  ADR-0027 is buying, and it is what unblocks #39.
* Deleting every probe from the tree turns this gate red: the derivation asserts it resolved
  against a non-empty set, because every other assertion about the permit is quantified over it
  and would otherwise pass vacuously. Removing the last probe is a deliberate act and should
  require a deliberate edit here.
* A new fixture kind — an HTML page, a `.wasm`, a captured binary — fails the gate until someone
  classifies it. That is the intended cost.
* This record adds a row to `docs/adr/README.md`, which is generated by
  `docs/adr/regenerate-index.sh` and which [ADR-0017](0017-manifests-belong-to-their-package-the-lockfile-is-generated.md)
  treats as a generated file arriving from several branches. The branch declares it in its `Owns`
  globs for that reason; the row is regenerated, not written.
