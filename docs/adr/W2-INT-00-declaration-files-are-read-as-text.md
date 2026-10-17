# ADR-W2-INT-00 — The partitioned declaration files are read as text, by a total grammar, from a module both gates share

Status: accepted
Date: 2026-09-04
Decided by: W2-INT-00 (implementer)
Scope: `tests/inventory-support.ts`, `tests/route-inventory.test.ts`, `tests/screen-inventory.test.ts`, `tests/route-declarations/**`, `tests/screen-declarations/**`

## Context

[ADR-0025](0025-the-route-inventory-is-partitioned-by-owner.md) §2 says the gate "reads the union
of the tracked declaration files", and §1 says those files are `tests/route-declarations/<TASK-ID>.ts`
— TypeScript modules that export their routes. It does not say *how* the gate reads them, and the
obvious answer does not work.

The obvious answer is a dynamic import of each tracked path in a loop. `tests/no-sdk-import.test.ts`
scans the whole tracked tree and reports, as a hard failure, every module reference it cannot resolve
to a string literal:

> a resolver call whose argument is not a plain quoted string, so this gate cannot tell which module
> it names

That is the same objection that made this gate stop importing `apps/web/next.config.ts`
([W1-INT-02](W1-INT-02-the-page-extension-knob-is-asserted-unset-not-read.md)). It is not
hypothetical here either: the first draft of this task's *prose* spelled the construct out with its
opening parenthesis, in two doc comments, and the boundary gate reported both files as undecidable
module references. The gate scans its own source and everyone else's; the construct cannot be written
in these files at all, not even in a comment.

A second question ADR-0025 leaves open: two gates now read a directory of declaration files, because
its final consequence gives the screen inventory the same treatment. A reader written twice is two
sets of failure modes, and the failure modes are the whole of what ADR-0025 §3 asks for.

## Decision

1. **A declaration file is read as source text**, by `readDeclarationArray` in a new module
   `tests/inventory-support.ts`. It finds `export const <name> = [ … ]`, scans the literal with a
   bracket matcher that skips comments and strings, rewrites it as JSON through a **total** tokenizer,
   and parses that. The tokenizer understands whitespace, both comment forms, single- and
   double-quoted strings with a fixed escape set, the six structural characters, numbers,
   `true`/`false`/`null`, bare property keys and trailing commas — and **throws, naming the
   construct, on everything else**. A declaration file is data; a reader that guessed at an
   expression would be inventing routes.
2. **Four distinct spellings of "exports nothing readable" are hard failures**, which is what makes
   ADR-0025 §3's first guard implementable: no `export const <name> = [`, an array literal that is
   never closed, a body the tokenizer cannot read, and an array with no entries. Each names the file.
   An empty declaration file is *not* "this task ships no routes" — it is indistinguishable from one
   whose contents were lost (ADR-0015).
3. **`owner` must equal the declaration file's own stem**, and every file in a declaration directory
   must be named `<TASK-ID>.ts`. Without the first rule, the duplicate message ADR-0025 §3 requires —
   "declared by X in file A and by Y in file B" — could name an owner that did not write the file.
   Without the second, a `types.ts` or a `README.ts` would be read as a task's declarations, or
   skipped, and skipping is the shape this programme has got wrong seven times.
4. **The shared reader, the `pageExtensions` guard and the app-directory path mapper live in
   `tests/inventory-support.ts`**, imported by both gates. `pageExtensions` in particular: Next.js
   resolves `page.<ext>` from the same setting it resolves `route.<ext>` from, and two gates
   answering that question separately is one answer too many. The file is declared on this task's
   `Owns` line under [ADR-0018](0018-the-declared-owns-line-is-the-ownership-boundary.md); no
   sibling in the Wave 2 plan owns anything under `tests/`.
5. **The "this gate plants nothing" assertion is extended to cover the shared module**, in both
   gates. ADR-0019 §4's promise was bought with a defect, and a promise a refactor can walk out of by
   moving the call into a helper is not one.

## Alternatives considered

* **Import the declaration files dynamically.** Rejected: it fails `tests/no-sdk-import.test.ts`,
  and the only way to make it pass is to weaken that gate. A gate that another gate must be weakened
  to accept is not a gate.
* **Static imports at the top of the inventory.** That is the array again with extra steps: adding a
  route would mean editing `tests/route-inventory.test.ts`, which is exactly what ADR-0025 exists to
  stop.
* **Declare the routes as JSON rather than TypeScript.** JSON needs no tokenizer, and it was
  tempting. Rejected on two counts: ADR-0025 §1 says `.ts`, and JSON carries no comments and no type
  annotation — the `RouteDeclaration`/`ScreenDeclaration` annotations mean a misspelt field fails
  `pnpm typecheck` in the declaring task's own PR, before the gate is reached.
* **Duplicate the reader in both gates.** Rejected: the reader's failure modes *are* the guarantee,
  and two copies drift.

## Consequences

* The tokenizer is real code with a real grammar, and a declaration file that uses a construct
  outside it — a template literal, a spread, a computed value — fails rather than being read
  approximately. That cost is deliberate and the message says what was refused.
* `tests/inventory-support.ts` is a file under `tests/` that is not a test, and so is every
  declaration file. They are type-checked by `tsconfig.root.json`'s `tests/**/*.ts` include and
  linted like any other, and Vitest collects only `*.test.ts`, so they are libraries and data and
  nothing else changes. How many there are is not written here: it is
  `git ls-files tests/ | grep -v '\.test\.ts$'`, and it goes up every time a task declares a route
  or a screen (ADR-0016).
* Neither gate can ever name a dynamic import in prose. That is a strange constraint to inherit, and
  it is written into the header of both files so the next author does not rediscover it by running
  the boundary gate.
* If a future wave needs declarations that are genuinely computed, this decision is what has to be
  reversed — and reversing it means teaching `tests/no-sdk-import.test.ts` about the construct
  first, deliberately, rather than as a side effect.
