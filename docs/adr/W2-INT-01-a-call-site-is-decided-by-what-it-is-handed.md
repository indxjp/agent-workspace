# W2-INT-01 — A call site is decided by what it is handed, not by what its callee is called

Status: accepted
Date: 2026-09-04
Decided by: W2-INT-01 (Wave 2 invariants)
Scope: `tests/no-sdk-import.test.ts`

## Context

[ADR-0030](0030-import-edges-are-resolved-by-the-compiler-not-matched-by-regex.md) fixed where a
module reference *points*: `tests/no-sdk-import.test.ts` stopped modelling module resolution and
started asking the compiler. Recorded here in
[W2-INT-01-a-module-reference-is-resolved-not-compared.md](W2-INT-01-a-module-reference-is-resolved-not-compared.md).

It left the question one step earlier untouched: **is this call site a reference at all?** That was
still answered from three hand-maintained tables of callee names — `RESOLVER_CALLS`, `OPAQUE_CALLS`,
`OPAQUE_PROPERTIES` — and a callee in none of them fell out of the branch with no `else`: neither
collected as a reference nor refused as undecidable. A verifier proved four node module loaders past
it, each by writing a tracked `.cjs` file, running `node` on it and watching the SDK load:

```js
module.require('@anthropic-ai/claude-agent-sdk')
require.main.require('@anthropic-ai/claude-agent-sdk')
process.mainModule.require('@anthropic-ai/claude-agent-sdk')
const load = require; load('@anthropic-ai/claude-agent-sdk')
```

Each printed `query is a function`, and each left the gate at `60 passed (60)`.

[ADR-0031](0031-a-static-gate-cannot-be-complete-so-undecidable-must-mean-refused.md) is the
programme decision: undecidable means refused, and it is the `else`. Adding the four names was
ruled out explicitly — the verifier found them by inventing them, and there is no argument that a
fifth does not exist.

## Decision

**The classifier does not ask what the callee is called. It asks what the call is handed.**
`decideUnrecognisedCall` in `tests/no-sdk-import.test.ts` is the `else` of the call-expression
branch, and it refuses a call when both of:

* a string it can read **at that call site** resolves, through `ts.resolveModuleName`, to a real
  module — the same resolver every other reference in the file goes through; and
* it cannot show the callee is a value **this file itself made** — that is, the callee expression is
  not rooted at an identifier the file binds, or the name it is rooted at is bound to another name.

The refusal names the file, the construct, and the module the string resolved to.

Three supporting pieces make that work:

* `calleeRoot` walks left through property access, element access, calls, parentheses, `!`, `as` and
  `satisfies` to the identifier a callee expression is rooted at, or to `null`. `expect(x).toBe`
  roots at `expect`; `require['main']['require']` roots at `require`; `(0, module.require)` roots at
  nothing.
* `fileBindings` collects, per file, the names the file binds, the subset of those bound to another
  name (`const load = require;` is why), and the names bound exactly once by `const` to a string
  literal.
* that last map is the one step of value-tracking the gate does, and it exists so that lifting a
  specifier into a variable is not the next spelling. It also strengthens the resolver arm: a
  `require(spec)` whose `spec` is a `const` string is now a *collected reference* rather than a
  refusal.

The three tables survive as a fast path, and their doc comments now say so: a callee's absence from
all three is not innocence. What the tables buy is the specifier — a call they name is read and
resolved rather than merely refused.

One further arm completes the branch, and it is a decision rather than a gap:

* **A call handed no readable string that resolves to a module is not, at that call site, naming
  one.** This is where the reach ends and the gate's header says so.

A second arm was written here and was **wrong**; the correction is below.

Separately, the walk now reads `sourceFile.typeReferenceDirectives` and `sourceFile.referencedFiles`.
The parser lifts triple-slash directives off the token stream onto the source file, so a walk of the
syntax tree alone never sees one; a tracked file carrying
`/// <reference types="@anthropic-ai/claude-agent-sdk" />` used to leave the gate green and now fails
the §42 set equality. `lib` directives name a file inside the compiler and are decided, not
collected.

## Consequences

* **Measured**, by planting each construct as a tracked file and running
  `npx vitest run --project tests tests/no-sdk-import.test.ts`: all four loaders above now fail the
  gate at `1 failed | 81 passed (82)` on the assertion `found no module reference it cannot decide`,
  and each failure message names the file and the callee text. Three constructs invented after the
  change — `Reflect.apply(module.require, module, [...])`,
  `require('node:module')._load(spec, module, false)` with the specifier lifted into a `const`, and
  `globalThis.process.mainModule.require(...)` — were each confirmed to load the SDK under `node`
  and are each refused.
* **One existing line in the gate had to be rewritten**, and it is the honest cost of the rule:
  `Object.prototype.hasOwnProperty.call(value, SDK_PACKAGE)` hands a string that resolves to the SDK
  to a callee rooted at `Object`, which no binding in that file explains, so the classifier refuses
  it. The dependency check now lifts `Object.keys(value)` into a local and tests membership. That
  refusal is the rule working; excluding it would have been the rule not working.
* Across the tracked tree at the time of writing, that was the **only** call site the new classifier
  refused. A survey of every call expression in the 139 tracked module-source files found 96 distinct
  free-rooted dotted callee chains and 1523 distinct computed callees, and none of the rest is handed
  a string that resolves to a module.
* The gate is stricter in a way that will reject constructs nobody intended to write, which is
  ADR-0031's consequence list and the right side to err on.
* **The reach ends in three named places**, each asserted in the gate as a demonstration rather than
  claimed in prose (`describe("where this gate's reach ends")`): `eval`/`Function` are refused rather
  than analysed; a specifier that arrives through a parameter or a computation is not read; and
  bindings are collected by name over the whole file rather than by scope, so a callee rooted at a
  name bound anywhere in the file is vouched for. The counter-examples are in the branch's declared
  gaps.

## Correction — a construction is a call site, and it was exempted (closeout)

The decision above carried a bullet that said **"a `new` expression is not a module load"**, with
`new Function` named as the single exception. That sentence was false, and it was written as a
justification for an arm — `else if (ts.isNewExpression(node)) { }` — that recorded no verdict at
all. It was the exact failure ADR-0031 clause 1 forbids, in the round that implemented clause 1.

A verifier refuted it by running the construct:

```js
// tracked bw2.cjs at the repository root
const w = new (require('node:worker_threads').Worker)(
  './apps/runner/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
);
```

`node bw2.cjs` prints `BW2 exit code 0` with no `error` event — the worker thread resolved and
executed the SDK module — and the gate stayed at `Test Files 1 passed (1); Tests 82 passed (82)`. A
tracked file that really runs the SDK passed the §42 boundary gate. (Note for anyone re-running it:
the worker's `online` event is *not* proof, because it fires before the entry module is resolved.
Exit code `0` with no `error` is.)

**The corrected decision: `new X(…)` is decided by `decideUnrecognisedCall` like every other call.**
The arm is gone; the branch's condition is `isCallExpression || isNewExpression ||
isTaggedTemplateExpression`, and the `else` is the classifier. The type `DecidableCall` names the
three, and `new X` written with no argument list at all (`arguments === undefined`) is handled
rather than thrown on.

Deleting the arm outright was measured first, and it is not free: across the tracked tree it turned
two real sites red, both of them the same shape —
`readFileSync(new URL('./agent-form.tsx', import.meta.url), 'utf8')` in
`apps/web/components/agents/agents-screens.test.ts:29`, and
`fileURLToPath(new URL('../../../../packages/core/src/db/schema/runs.ts', import.meta.url))` in
`apps/web/server/runs/store.test.ts:50`.

The rule that decides those is **not** a name. `URL` is in no table, and the gate asserts that it is
not. What decides them is the *argument pair*: a string handed to a call **together with an absolute
base URL** — `import.meta.url`, which the parser reports as a meta-property, or a string literal that
`URL.canParse` accepts with no base — is the shape a URL resolution is written in.

The important half is what that arm then does. **It collects the reference; it does not exempt the
call.** The string goes through `ts.resolveModuleName` like every other reference, so if it names the
SDK the file lands in the detected set and the §42 set equality fails. That is what keeps the arm
from being the next way past the gate, and it was tested by trying to use it as one. All three of
these were planted as tracked files, all three loaded the SDK under `node`, and all three now fail
the gate:

| construct | what `node` printed | verdict |
| --- | --- | --- |
| `new (require('node:worker_threads').Worker)('…/sdk.mjs')` | `BW2 exit code 0` | refused, naming `Worker` and the file |
| `new (require('node:worker_threads').Worker)('…/sdk.mjs', 'file:///x/')` | `BW4 exit code 0` | collected → §42 set equality fails |
| `new Worker(new URL('…/sdk.mjs', import.meta.url))` (ESM idiom) | `BW3 exit code 0` | collected → §42 set equality fails |

The last is the one that matters most for the arm's design: the outer callee is bound by an `import`
and so is vouched for, and the specifier is inside the nested `new URL`. Had the base-URL arm been an
exemption, that idiom would have been a free route to the SDK.

A fourth construct closes the round's other finding. `stringsHandedTo` walked into an array-literal
argument but not through a `SpreadElement`, so `module.require(...['@anthropic-ai/claude-agent-sdk'])`
— a working loader whose specifier is a plain literal written verbatim at the call site — was
silently ignored, while the identical array literal one AST node away inside `Reflect.apply` was
refused. The spread is now unwrapped before the literal and array tests, in both positions.

The prose was corrected with the code, because the prose is the part that stops the next reader
looking. The gate header's clause 2 used to say every call site leaves with "a reference … or a
refusal"; it now names **three** verdicts — collected, refused, or decided-not-a-reference — says
`new X(…)` is a call site, and says which limits the third verdict carries.

### Correction, after the round that accepted the arm above

As first written the base-URL arm ended the loop: it collected the candidate and `return`ed. That is
wrong, because `handedABaseUrl` is a question about the **call** — does any argument look like an
absolute base URL — not about the candidate being the string resolved against it. So at a call
carrying a base URL only the *first* resolvable string was decided and every later one, the SDK
included, left with no verdict. A tracked repo-root `b20.cjs` holding

```js
const q = Wibble('./package.json', 'file:///x/', '@anthropic-ai/claude-agent-sdk');
```

left the gate at `Tests 85 passed (85)` and named `b20.cjs` nowhere, while the same file against the
previous revision of the gate (`git checkout 905b1f2 -- tests/no-sdk-import.test.ts`, probe
unchanged) was refused by name. Reordered so the SDK is the first resolvable string, `b21.cjs`
failed the §42 set equality — the same construct, decided or not decided by argument order alone.

**The arm decides the candidate it is about and does not end the loop** (`continue`, not `return`).
Every string handed to such a call is now collected, so `b20.cjs` and `b21.cjs` both fail the §42
set equality by name. `tests/no-sdk-import.test.ts` asserts both orderings so the shape cannot
return. No working loader of the `b20` shape was built: what the regression cost was a refusal the
previous revision emitted and a verdict for the specifier after it — not a demonstrated SDK escape.
