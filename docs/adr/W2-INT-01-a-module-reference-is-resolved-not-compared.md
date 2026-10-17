# W2-INT-01 — A module reference is decided by resolving it, never by comparing its text

Status: accepted
Date: 2026-09-04
Decided by: W2-INT-01 (Wave 2 invariants)
Scope: `tests/no-sdk-import.test.ts`

## Context

Spec §42 says all SDK-specific translation is concentrated in one small module, and the
programme states it as an absolute: `apps/runner/src/claude.ts` is the only file that may reach
`@anthropic-ai/claude-agent-sdk`, and `tests/no-sdk-import.test.ts` enforces it.

Until this change that gate answered the question with **text**. It found candidate references
with a regular expression over raw source (`STATIC_SPECIFIER`), captured the characters between
the quotes, and asked whether those characters were the package name — after first expanding them
through an alias table the gate assembled itself from `compilerOptions.paths`, a package
manifest's `imports` map, and dependency values that named a directory.

Four rounds of verification built six escapes against that shape. Each was answered by teaching
the table the spelling it had just been shown, and the next round produced another spelling:

1. a bare specifier through a `compilerOptions.paths` alias;
2. `@/../../…` — the same alias, used to climb back out of the directory it points at;
3. a dynamic `import()` whose argument is a variable;
4. a unicode escape inside the specifier: `'\u0040anthropic-ai/claude-agent-sdk'` is the SDK's
   real name to node and to `tsc`, and a different string to a regular expression;
5. a whitespace-free `import'…';`, which is valid ESM the `\bimport\s+` alternative cannot match;
6. a relative path through the pnpm symlink under `node_modules/`, needing no configuration
   change at all;

plus a `paths` block in an `extends` target whose extension is not `.json` (`tsc` loads that file
verbatim), and `compilerOptions.baseUrl`, which makes a bare specifier resolve with no `paths`
entry in existence.

ADR-0030 names what those six have in common, and this record is that decision applied to this
gate: **a module specifier is not a string. It is an input to a resolution algorithm.** A gate
that compares specifier text is maintaining its own model of a resolver it does not have, and a
model can only ever be enumerated. TypeScript is already a dependency of this file's own suite,
and it implements the algorithm.

## Decision

**1. Candidate references come from the TypeScript AST.** `ts.createSourceFile` and a walk over
`ImportDeclaration`, `ExportDeclaration`, `ImportEqualsDeclaration`, `ImportTypeNode` and the
call forms. The AST hands over the **cooked** specifier, so escape 4 arrives as
`@anthropic-ai/claude-agent-sdk`, and the parser has no opinion about the spacing that defeated
escape 5. Text scanning survives in exactly one place — finding `src`/`href` attributes and
`<script>` bodies in markup — and it decides nothing there either.

**2. Every reference is resolved with `ts.resolveModuleName`,** against the options of the nearest
`tsconfig.json` above the importing file, parsed by `ts.getParsedCommandLineOfConfigFile`. That is
the API `tsc` itself uses, so `paths`, `baseUrl`, an `extends` chain through a file of any
extension, package `exports`/`imports` and symlinked workspace packages are the compiler's
business. The gate is not told any of them exist.

**3. The answer is the resolved absolute path,** canonicalised through `realpathSync` so a
reference through `apps/runner/node_modules/@anthropic-ai/…` and one through the pnpm
content-addressed store are the same module. Whether that path is the SDK is decided by walking
up to the `package.json` that owns it and reading `name`, which is the identity a resolver uses.
Whether it is a research probe is decided by path containment under `docs/research/fixtures/`.

**4. A reference that resolves nowhere fails the gate, naming the file.** ADR-0015 on the one
branch a resolver leaves open. It covers escape 3 — a resolver call whose argument is not a
string literal is refused before resolution is even attempted — and it covers a specifier that
resolves to nothing at all.

**5. A failure prints the mapping, not just the file.** ADR-0030's consequence list asks for it:
once the answer is a resolution, a specifier and the file it names need not look alike, so both
set assertions print `file: specifier -> resolved path` for every reference that put a file in
the detected set.

**6. The alias table is deleted.** `collectAliases`, `PathAlias`, `aliasExpansions`,
`expandThroughAliases`, `aliasTargetPath`, `aliasTargets`, `pathDependencyAliases`,
`pathDependencyTarget`, `PATH_DEPENDENCY_PROTOCOLS`, `classifyAliasSource`, `unreadAliasSources`,
`namesSdk` and `namesResearchFixtures` are gone, together with the assertions that exercised
them. They were the model, and the model was the bug.

### Two resolution arms beyond "resolve it from its own file", each narrow on purpose

* **A relative specifier TypeScript declines** is joined onto the importing file's directory and
  accepted when that exact file exists. The reference in the tracked tree that needs it is
  `import './globals.css'` in `apps/web/app/layout.tsx` — an extension TypeScript's resolver has
  no rule for, on a file that is really there. This is the definitional arm of relative resolution; it introduces no alias, and it
  can only ever name a file this repository already contains.
* **A bare specifier that resolves nowhere from its own file is resolved once more from
  `apps/runner/src/claude.ts`,** the file inside the one package that declares the confined SDK.
  The committed probes are why. `docs/research/fixtures/agent-sdk/README.md` tells a reader to
  copy a probe out of the repository, install the SDK beside it and run it under node, so a
  probe's `@anthropic-ai/claude-agent-sdk` genuinely resolves to nothing *in this tree* — pnpm
  installs the SDK for `apps/runner` and for nothing else. Without this arm the three probes that
  import the SDK would each be a hard failure, and the §42 permit would be unusable. The arm is
  over-eager, which is the safe direction: it can only ever *add* a file to the detected set, and
  an `apps/web` file importing the SDK is named as an importer rather than as an unresolvable
  reference.

### Markup is a URL arm, and it is declared as one

ADR-0030 binds the module-specifier question. A `src`/`href` in an HTML document is not a module
specifier: a browser resolves it as a URL against the document's URL, and no `ts.resolveModuleName`
exists for `https://cdn.example/…`. So markup references are resolved with
`new URL(reference, documentUrl)` — the algorithm a browser really uses — and then decided. A
`file:` result gets the same path comparison every other reference gets. A result on another
origin is compared by the **resolved URL's path segments** against the package name, because that
is the only thing available for an origin this gate cannot resolve against. That comparison is
the one place a name survives in this file, it is stated here rather than hidden, and it is listed
under declared gaps below.

## Evidence

Every spelling above was planted in the tree and the gate was run against it. The reproductions
are `bash` scripts kept outside the worktree; each applies its edit, runs
`npx vitest run tests/no-sdk-import.test.ts`, and restores the tree. Baseline before and after
every run: `Tests 60 passed (60)`.

| # | spelling | what turns red |
| --- | --- | --- |
| 1 | a bare specifier through a `paths` alias | §42 set equality names the new importer |
| 2 | `@/../../apps/runner/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` | §42 set equality |
| 3 | `import(name)` where `name` is a variable | "found no module reference it cannot decide" |
| 4 | `import '\u0040anthropic-ai/claude-agent-sdk';` | §42 set equality |
| 5 | `import'@anthropic-ai/claude-agent-sdk';` | §42 set equality |
| 6 | `import '../../runner/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';`, no config change | §42 set equality |
| 7 | a `paths` block in an `extends` target named `tsconfig-shared.txt` | §42 set equality |
| 8 | `compilerOptions.baseUrl` pointing into `apps/runner/node_modules/@anthropic-ai` | §42 set equality |

Spellings 4, 5 and 8 are the three the round-3 revision of this gate passed. Run against that
revision the same three reproductions reported `Tests 57 passed (57)`, and for spelling 4 node
loaded the module (`NODE LOADED IT: 1`) from the very file the gate had just called clean.

Spelling 7 is worth a note. Written with the `paths` block *also* declared in the child config,
`extends` semantics replace the whole `paths` object and the alias never exists — so the escape
does not work, and the gate still went red, on the hard refusal of clause 4 rather than on §42.
Written with the child declaring no `paths` of its own, the alias is live and the §42 equality
names the importer. Both outcomes are the gate refusing to pass; the table records the second.

Two of the same properties are asserted inside the file as units, so they hold without a human
re-running a script: `honours a baseUrl and a paths block reached through an extends of any
filename` builds three throwaway projects in a temporary directory and checks that the two
specifiers resolve where the configuration says and resolve nowhere where it does not, and
`hands over the cooked specifier, not the text it was written with` asserts the escape and the
whitespace-free form produce the identical specifier string.

## Declared gaps

* **A remote markup reference is decided by its URL path, not by a resolver.** A
  `src="https://cdn.example/@anthropic-ai/claude-agent-sdk/sdk.mjs"` is detected because the
  resolved URL's segments name the package; a CDN that serves the SDK from a path spelled any
  other way is not. What would make this wrong: a page in `ui/` loading a real module from a
  remote origin. None does today. The distinct `src`/`href` values in `ui/*.html`, derived with

  ```sh
  grep -ohE '\b(src|href)\s*=\s*"[^"]*"' ui/*.html | sed -E 's/.*="//; s/"$//' | sort -u
  ```

  are 43 lines: relative sibling pages, `assets/app.css`, `assets/app.js`,
  `../docs/spec.md`, nine `#` fragments, and four absolute URLs — `docs.claude.com`, `fonts.gstatic.com` and two on
  `fonts.googleapis.com`.
* **An HTML import map is not read.** It is a resolution table for a browser, and this gate
  resolves markup references as plain URLs. A separate assertion fails if any tracked markup file
  contains the string `importmap`, so one cannot arrive unnoticed.
* **Resolution depends on the tree being installed.** `ts.resolveModuleName` answers against
  `node_modules` as it stands, so the gate must run after `pnpm install`; CI installs and builds
  `packages/core` before `pnpm test`. A missing install does not make the gate quiet — every
  unresolvable reference is a named failure — but it does make it loud for a reason that is not
  a §42 violation.
* **The nearest `tsconfig.json` is taken to be the file's project.** That is the search an editor
  and type-aware ESLint perform, and it is not the same question as "which project's `include`
  covers this file". For a file that belongs to no project — a probe under `docs/` — the nearest
  config is the repository root's, which is the over-eager direction. What would make it wrong: a
  file whose real project is *not* its nearest ancestor config, which would need a config
  including a directory outside its own subtree.
* **An alias that is declared and never used is no longer reported at declaration time.** The
  previous file asserted "the SDK is named by no path alias declared anywhere in the tree", which
  failed on the day such an alias was written rather than on the day something imported through
  it. Resolution can only answer about references that exist. The trade is deliberate: that
  assertion was built on the alias table, and the table is what the six escapes were against.
* **A dependency declared but not installed is invisible.** The "declared as a dependency by
  exactly one package" assertion still reads the tracked manifests directly, so a second package
  adding the SDK to its `dependencies` fails that assertion whether or not anything imports it.
* **An untracked file is invisible**, unchanged from before: `git ls-files` decides what is
  scanned, and `git add` is what puts a file inside the boundary.

## Alternatives considered

* **Teach the alias table about `baseUrl`, escapes and whitespace.** This is what rounds 1–3 did,
  three times. Rejected by ADR-0030: the table is a model of a resolver, the model is enumerable,
  and each enumeration ends one round later.
* **Build a full `ts.Program` per project and read its resolved module graph.** It answers the
  same question and would also type-check, but it costs a program per config for a gate that
  needs one function, and it would not cover the `.mjs` probes under `docs/` that belong to no
  project at all. `ts.resolveModuleName` is the part of the program that answers this question.
* **Treat an unresolvable specifier as "reaches nothing".** Rejected — that is the fail-open
  shape ADR-0015 exists to forbid, and it would have passed escape 3 outright.
* **Keep a name comparison as a second arm beside resolution, "just in case".** Rejected: it
  brings back the thing that produced six escapes, and it would fire on the prose control in
  `packages/core/src/config.ts`. The one surviving name comparison is the remote-URL arm above,
  where no resolver exists, and it is declared.

## Consequences

* The gate no longer has a table to keep in sync with a resolver. A future `paths` block, a
  `baseUrl`, a workspace package or a package `exports` map arrives already handled.
* A reference the compiler cannot place is a build-stopping failure naming the file. That is
  louder than the previous behaviour and is the intended cost of clause 4.
* Because the walk is over a syntax tree, a specifier written inside a string literal in this
  file is a string and not a reference. The fixtures below the assertions are therefore written
  out in full rather than assembled from joined fragments, and the §42 set equality — which this
  file would fail if any of them were read as a reference — is what holds that claim up.
* This record adds a row to `docs/adr/README.md`, which is generated by
  `docs/adr/regenerate-index.sh` and which [ADR-0017](0017-manifests-belong-to-their-package-the-lockfile-is-generated.md)
  treats as a generated file arriving from several branches. The branch declares it in its `Owns`
  globs for that reason; the row is regenerated, not written.
