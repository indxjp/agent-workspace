# W2-DB-02 — A module specifier is resolved, not compared as text

Status: accepted
Date: 2026-09-04
Decided by: W2-DB-02 (Persistence), verification rounds 4 and 5
Scope: `packages/core/src/db/repositories/database-reachability.test.ts`,
`apps/web/server/runs/store.test.ts`; applies ADR-0030 to the two import-edge gates this task owns

## Context

Two gates on this branch decide a security property — _does this module reach the database layer_,
and _does this module construct the in-memory run store_ — by asking where an import specifier
points. Until this round both answered by comparing the specifier's **text** against a table of
alias prefixes each gate built for itself out of the tracked `tsconfig` and `package.json` files.

Verification walked past that table again and again, each time with a different spelling and each
time with a counter-example that was built, compiled and run:

| round | spelling                                                                              | why the text comparison missed it                                                                                                                                                                                     |
| ----- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3     | `@/../../packages/core/dist/db/client.js`                                             | the classifier returned `null` for every specifier that did not begin with a dot                                                                                                                                      |
| 3     | a dynamic import of a `const` holding the specifier                                   | the specifier is not in the source at all                                                                                                                                                                             |
| 4     | a `paths` block moved into `apps/web/tsconfig-paths.txt` and pulled in with `extends` | TypeScript uses an `extends` target verbatim when the file exists and appends `.json` only when it does not, so a table that opened every tracked `.json` never saw it                                                |
| 4     | `../../node_modules/@agent-workspace/core/dist/db/client.js`                          | the relative arm joined the specifier onto the importing file's directory and compared the result against the layer roots; the pnpm workspace symlink means that string is `packages/core/…` on disk and nothing else |

Each round fixed the spelling it had been shown. That is not a series of mistakes; it is one, and
[ADR-0030](0030-import-edges-are-resolved-by-the-compiler-not-matched-by-regex.md) names it: **a module specifier is not a string, it is the input to a resolution algorithm.** A gate
that compares specifier text is maintaining its own model of a resolver, and the model can only
ever be enumerated — which is what three rounds of repairs were.

Round 5 put twenty-two spellings through the converted gates and twenty were refused. The two that
were not are the same mistake one layer up: the gates had stopped modelling _how a specifier is
spelled_ and were still modelling **two things the toolchain decides**.

| round | construct                                                                                        | what the gate modelled instead of asking                                                                                                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5     | a tracked `apps/web/server/leak/tsconfig.json` remapping `"@/*"` onto a stub directory           | _project membership._ The gate resolved a file's specifiers under the nearest ancestor `tsconfig.json`, and `tsc -p apps/web/tsconfig.json` and `next build` do not.                                                             |
| 5     | `"./persistence": { "types": "./src/persistence-types.ts", "default": "./dist/persistence.js" }` | _which condition speaks for a subpath's surface._ The surface check read the `types` condition alone, so a hand-written `declare` stub answered for a `default` condition that re-exported the layer — and Node loads `default`. |

The first repair of that first row replaced the directory walk with `parsed.fileNames`, and round 5
walked past that too, with one `exclude` edit and one nested `tsconfig.json`:

| round | construct                                                                                                                                                        | what the gate modelled instead of asking                                                                                                                                                                                                                                                                                                                                                    |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5     | `"exclude": ["node_modules", ".next", "server/leak"]` in `apps/web/tsconfig.json`, plus a nested `apps/web/server/leak/tsconfig.json` claiming the excluded file | _membership again, one level in._ `parsed.fileNames` is a project's ROOT names; the program `tsc -p` builds is those plus everything they import. The gate used the owning projects **exclusively** when there were any, so the attacker's config became the only one consulted while `tsc -p apps/web/tsconfig.json` and `next build` went on resolving the same file into the real layer. |

## Decision

**Both gates resolve every specifier with `ts.resolveModuleName`, against the compiler options of
every TypeScript project whose program contains the importing file — unioned with the widened set
below, never chosen between — and compare the resolved absolute paths.** The alias tables are
deleted; nothing in either gate expands a prefix.

1. **Project membership is asked of the compiler, not of the directory tree, and it is the
   program.** Every tracked `tsconfig*.json` — found by shape out of the `git ls-files` listing each
   gate already reads — is parsed with `ts.getParsedCommandLineOfConfigFile`, and the set of files
   `ts.createProgram(parsed.fileNames, parsed.options).getSourceFiles()` contains is that project's
   membership. **Not `parsed.fileNames`.** Those are the project's _root_ names — what its
   `files`/`include`/`exclude` globs list — and a `tsc -p` program is that set plus everything the
   roots import, each of which resolves its own specifiers through that project's options. Round 5
   reached the layer through exactly that difference, in the round after the gates started reading
   root names: a file dropped out of `apps/web`'s `include` was still in the program
   `tsc -p apps/web/tsconfig.json` builds and still resolved `@/*` through `apps/web`'s `paths`.
   `extends` of any filename, `baseUrl`, `paths`, `exports`, `imports`, `include`/`exclude` globs
   and workspace symlinks are therefore the compiler's answer, given by the library `tsc` itself is
   built out of.

   **The contexts are a union of three sets, never a choice between them**: the projects whose
   program contains the module; the repository root `tsconfig.json` — the options every other config
   in the tree extends, and Node's own `moduleResolution`, Node being what loads a file no project
   compiles; and every tracked project whose configuration file sits at or above the module, because
   a bundler that reaches such a file still resolves through the `paths` declared above it. The last
   two are the gates' choice rather than the compiler's answer, and both file headers say so. They
   are not decoration: this tree tracks `.mjs` and `.js` modules that no project here compiles, so
   they are in no project's program and have no owner to ask.

   Taking the union rather than preferring the owners is the second half of the round-5 correction.
   The first version of this decision returned the owning projects _exclusively_ whenever there were
   any, and round 5 took two refusals away with one `exclude` edit plus one nested `tsconfig.json`:
   the attacker's project became the only one consulted. What the union buys, stated no wider than
   it is true: a configuration file added to the tree adds contexts and removes none, and each
   gate's resolver is monotone in its contexts — one more context can only add a resolution — so **an
   edge a gate already refuses cannot be taken away by adding a configuration file.** That sentence
   is about _edges_. It is deliberately not a claim about the hard failures the gates raise
   elsewhere: a context added to the set can give a resolution to a specifier that previously
   resolved nowhere, and the throw that specifier used to raise would then not be raised.

2. **The comparison is between real paths.** Every resolved path, and each of the layer's own
   roots, is put through `realpathSync` first. This is the explicit choice about symlinks: the pnpm
   workspace link `apps/web/node_modules/@agent-workspace/core` and `packages/core` are one
   directory, so a specifier that reaches the layer through the link reaches the layer.
3. A **path** specifier is also resolved against the filesystem — joined onto the importing file's
   directory — because a bundler loads `import './globals.css'` at exactly the path it spells and
   TypeScript has no type for it. That answer is **added** to the compiler's, not used only when
   every context declines, so that resolution is monotone in the contexts and clause 1's union
   property has no arm in which a context replaces an answer. A path that names no file on disk and
   that no context resolves is a **hard failure naming the file** (ADR-0015): a reference the gate
   cannot decide is one it must refuse. A **bare** specifier the compiler declines names a package
   it cannot find from that file; it reaches no module, and the layer is not reachable through it
   because both layer roots are asserted to exist before any comparison is made.
4. Text is still how _candidate_ references are found, and it is the TypeScript AST rather than a
   regular expression: import declarations, `export … from`, import type nodes, dynamic imports and
   `require` calls. The parser hands back the **cooked** specifier, so a string escape in one is
   the character it denotes. What text no longer does is decide where a reference points.
5. **Every call site leaves the walk with a verdict** (ADR-0031 clause 1). A call, construction or
   tagged template that is neither of the two constructs above is refused when it is handed a string
   that resolves to the protected module by a callee the file does not bind, and otherwise decided:
   at that call site, no string this gate can read names the module. The vouching test is not a list
   of callee names — it is "rooted at an identifier this file declares and does not bind straight to
   another reference", with parentheses and comma expressions unwrapped, and no construction is
   vouched for. What that leaves outside is under _What this does not close_.

Round 4 found a second door that no resolver question would have caught: an export subpath whose
own target sits outside the layer and re-exports from inside it. So the reachability gate also
**reads each declared export subpath's surface with the type checker**, follows every alias to the
declaration it ultimately names, and fails on a name declared inside the layer that the public
`./db` subpath does not also expose.

5. **A subpath's surface is the union of what every declared condition exposes**, not what its
   `types` condition exposes. `tsc` reads `types`; Node reads `default` — measured from `apps/web`,
   where `createRequire(…).resolve('@agent-workspace/core')` answers `packages/core/dist/index.js`
   while the `types` condition of `.` names `packages/core/src/index.ts` — and the consumer, not the
   gate, picks. So the program that block builds carries every condition of every subpath among its
   root files, with `allowJs` on for the compiled halves, and a condition naming a file that is not
   on disk is a hard failure naming the key and the condition (ADR-0015).

## Consequences

- The reachability gate requires every file `packages/core/package.json`'s `exports` names to exist
  — the `dist/` halves included — and fails by name on the first one that does not, because it
  compares resolved paths against the layer's roots and reads a surface out of each condition. The
  runs gate does **not**: it compares resolved paths against `apps/web/server/runs/store.ts` and
  never mentions the layer. Measured with `packages/core/dist/db` moved aside:
  `npx vitest run apps/web/server/runs/store.test.ts` gives `Test Files 1 passed (1)`, while the
  reachability gate gives `Error: packages/core/package.json exports "./db" with "default": …, and
"packages/core/dist/db" does not exist.` The runs gate's only reference to the build output is an
  `existsSync` guard inside its `describe.skipIf(!hasDatabase)` block, which does not run without
  `TEST_DATABASE_URL`. CI builds `@agent-workspace/core` in a step before `pnpm test`.
- Both gates load the TypeScript compiler, parse every tracked `tsconfig*.json` and **build a
  program for each** so that membership is the compiler's answer; the reachability gate additionally
  builds a `packages/core` program for the surface check. `typescript` was already a dependency of
  both files. Building a program per tracked configuration is what the membership question costs,
  and it is now the dominant cost of each gate's run; the run's own duration line is where that
  number lives.
- A specifier written through a mechanism nobody has thought of yet needs no change here **as long
  as it is a specifier the gates read**: they have no opinion about spellings, only about where the
  compiler says a specifier lands. Round 5 falsified the unqualified version of that sentence — the
  gates still had opinions about _which_ compiler question to ask, and both survivors were exactly
  that. What is left is the boundary below, which is about what counts as a reference at all.

## What this does not close

- **A module reference inside a string this gate cannot read.** Both gates now give a verdict to
  every call, construction and tagged template their walk reaches (ADR-0031 clause 1): a call handed
  a string that resolves to the protected module, by a callee the file does not bind, is **refused**
  naming the file and the callee; a call where no readable string resolves there is **decided** —
  at that call site nothing names it. "The file binds it" is not a list of callee names: it is a
  callee rooted at an identifier the file declares and does not bind straight to another reference,
  with parentheses and comma expressions unwrapped first, and no construction is ever vouched for
  because `new Worker(specifier)` loads and runs a module. The indirect spellings verification has
  built are refused; **a specifier that exists only inside the source text handed to `eval`, and one
  inside the body string handed to the `Function` constructor, are not**, because in both the
  specifier is a substring of a string the gate has no reason to read as a specifier. That is where
  a static analysis over a dynamic language stops, and the pull request's declared gaps carry the
  counter-example. (Written without the call syntax on purpose: `tests/no-sdk-import.test.ts` reads
  comments and prose too, and refuses those two constructs wherever it finds them.)

  The blunter rule — refuse _every_ call handed a string that resolves to the protected module —
  was implemented and measured against this tree and rejected: it refuses `path.resolve(…, '..')`,
  `key.split('.')` in `packages/core/src/db/schema/tenancy.test.ts`, `execFileSync('git', ['-C',
'.', …])` and `specifier.startsWith('.')`, because `'.'` and `'..'` resolve to the `index.ts` of a
  directory inside the layer. Resolving those strings must also raise no "unresolvable" verdict:
  `fetch('/api/agents')` in `apps/web/components/agents/agent-form.tsx` is a string, not a reference
  a gate failed to decide, and routing it through the specifier resolver fails the runs gate on that
  component.

- **The `.` barrel.** `@agent-workspace/core` resolves to `packages/core/src/index.ts`, outside the
  layer, so it is not an edge. The surface check constrains which _names_ that subpath may carry:
  a name declared inside the layer is refused unless `./db` exposes the same name. The comparison
  is by exported name, so a layer-declared binding published under a name `./db` happens to use is
  not caught by it. Measured in round 5: a `./persistence` key whose only export is
  `export { createDatabase as openDatabaseRoot } from './db/client.js'` — `openDatabaseRoot` being
  a name `./db` already exposes — leaves the gate green, `Tests 9 passed (9)`.
- **`createRequire`.** Neither gate reads the modules a `createRequire` result goes on to resolve;
  that is one instance of the first bullet. `tests/no-sdk-import.test.ts`, which this task does not
  own, rejects any `createRequire` whose result is not used immediately on a plain quoted string,
  and that is what covers the shape for the SDK — a dependency on a sibling branch's gate rather
  than on either of these.
