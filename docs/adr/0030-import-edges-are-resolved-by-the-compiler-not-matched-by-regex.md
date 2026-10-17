# ADR-0030 — A gate that reasons about import edges resolves them with the TypeScript compiler; it does not match them with a regex

Status: accepted
Date: 2026-09-04
Decided by: orchestrator, after the same bypass class was found in four consecutive rounds
Scope: `tests/no-sdk-import.test.ts`, `packages/core/src/db/repositories/database-reachability.test.ts`,
`apps/web/server/runs/store.test.ts`, and any future gate that asks "does this file import that one?"

## Context

Three gates in this repository decide a security property by asking whether one module imports
another: spec §42's SDK boundary, the database-layer reachability gate, and the run-store gate. All
three answer it by scanning module **text** with regular expressions and comparing the captured
specifier as a string.

Over four verification rounds, verifiers walked past them **six times**, each with a different
spelling and each with a running counter-example:

| Round | The spelling that got through |
| --- | --- |
| 2 | a bare specifier resolved through a `tsconfig` `paths` alias — the scan saw only relative paths |
| 3 | `@/../../packages/core/dist/db/client.js` — the same, in the reachability gate |
| 3 | a dynamic `import()` whose argument is a variable, not a string literal |
| 4 | `import '@anthropic-ai/claude-agent-sdk'` — a string escape; the raw captured text does not equal the cooked specifier |
| 4 | `import'…'` with no space — the pattern requires whitespace after `import` |
| 4 | `../../node_modules/@agent-workspace/core/dist/db/client.js` — through the pnpm workspace symlink, **with no configuration change at all** |
| 4 | a `paths` block in an `extends` target whose extension is not `.json` — tsc loads it verbatim |
| 4 | `compilerOptions.baseUrl`, which makes a bare specifier resolve with no `paths` entry |

Each round fixed the spelling it was shown and each round was walked past by the next one. That is
not six mistakes by six authors. It is one mistake made once: **a module specifier is not a string,
it is an input to a resolution algorithm**, and every gate that treats it as a string is
approximating a resolver it does not have. The approximation can only ever be enumerated, and the
enumeration is what the last four rounds were.

The tool is already present. `database-reachability.test.ts` imports `typescript` and uses it to
*parse* — `ts.isStringLiteralLike` — while hand-rolling the resolution that the same library
implements exactly.

## Decision

1. **A gate that decides whether module A reaches module B resolves the specifier with
   `ts.resolveModuleName` (or the program's own resolved module graph), against the real
   `tsconfig.json` for that file, and compares the RESOLVED absolute path.** No comparison of
   specifier text against a layer root. No alias table maintained by the gate.
2. **The compiler's answer is the answer.** `paths`, `baseUrl`, `extends` of any filename, package
   `exports` and `imports`, symlinked workspace packages and string escapes are all handled by
   the resolver, which is the component whose job that is and which is what tsc, Next.js and Node
   actually use at build time.
3. **A specifier the resolver cannot resolve is a HARD FAILURE naming the file**, not a skip. This is
   [ADR-0015](0015-gates-decide-on-positive-assertions.md) applied to the one branch a resolver still
   leaves open, and it also covers the dynamic-`import()`-with-a-variable case: a reference the gate
   cannot decide is a reference it must refuse.
4. **Text scanning remains correct for finding *candidate* references** — locating every `import`,
   `require`, `export … from` and dynamic `import()` in a file. What it must not do is decide where
   one points. Find with the parser, decide with the resolver.
5. **The three gates are converted as part of this wave**, on their existing branches, and each
   conversion is proved by re-running the six counter-examples above and watching every one go red.

## Alternatives considered

* **Fix the six spellings.** Rejected: that is what rounds 2 and 3 did, and round 4 found three more.
  There is no reason to believe the eighth does not exist; percent-encoding, `node:`-prefixed
  specifiers, and a `browser` field are all untried.
* **Declare the residuals as gaps and land.** Rejected for these specifically. Two of them are live
  tenant-isolation bypasses reachable from a real Next.js route handler with tsc, eslint and the
  gate all green, and one needs **no configuration change whatsoever** — a single committed file. A
  gate that a one-file diff walks past is not a gate, and spec §25 is what it is standing in front of.
* **Ban `node_modules` paths and string escapes with a lint rule.** Rejected: it treats each spelling
  as the problem again, and a lint rule is another text scan with the same blind spots.

## Consequences

* The gates get slower — a resolver call per candidate reference rather than a regex test — and they
  gain a real dependency on `typescript` at test time, which is already a dependency of every package
  here.
* A gate's failure message must now print both the specifier and its resolved path, because the
  interesting information is the mapping between them.
* This closes the class, not the instances. If a seventh spelling is found after the conversion it is
  a bug in the resolver call, which is a bounded thing to fix; today it is a bug in a model of module
  resolution that this repository should never have been maintaining.
* Round 4 exists because of this ADR, after I said round 3 was the last. That is a reversal and it is
  recorded as one: the commitment was to stop chasing an unbounded rule
  ([ADR-0029](0029-a-narrowing-is-a-defect-only-when-a-counter-example-exists.md)), and these
  findings arrived with the counter-examples ADR-0029 asks for. Fixing them is what that record says
  to do; another enumeration round is what it forbids, and this is not one.
