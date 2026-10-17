# W1-INT-02 — Three classifications the §42 scan owed: a `.conf`, a template, and `createRequire`

Status: accepted
Date: 2026-09-03
Decided by: W1-INT-02 (Wave 1 invariants)
Scope: `tests/no-sdk-import.test.ts`

## Context

The §42 boundary gate classifies every tracked file and refuses to pass over any module reference it
cannot decide statically. Both refusals are correct and both fired on the Wave 1a union and on the
compose branch above it, on files three other tasks wrote:

```
tracked files whose kind this gate does not recognise:
  .env.example
  apps/web/server/runs/acceptance/nginx.conf
  runtime.Dockerfile

module references this gate cannot resolve; it refuses to pass over them:
  apps/web/server/runs/acceptance/run-acceptance.mjs: createRequire builds a module reference at run time …
  apps/web/server/runs/acceptance/run-acceptance.mjs: createRequire builds a module reference at run time …
```

The gate is not wrong to stop. What it is owed is a **classification** — a rule that says what these
file kinds and this construct *are* — because "it did not match my regex" decides nothing, and
because the two obvious repairs are both worse than the failure. Adding `.example` to the inert list
would make `handler.ts.example` inert, and a committed TypeScript template that imports the SDK is
precisely the thing this gate exists to see. Deleting the `createRequire` entry would remove a real
guard.

## Decision

**1 — A file kind is inert when the program that reads it is not a JavaScript module resolver.**

- `.conf` — nginx's own directive grammar. `apps/web/server/runs/acceptance/nginx.conf` is the case
  that forced it. nginx has no module resolution and cannot reach a node package.
- `Dockerfile` and `<stage>.Dockerfile` — docker build instructions. `Dockerfile` was already
  classified this way by name; `runtime.Dockerfile` is the same kind of file and now classifies the
  same way by rule rather than by a second literal name. A module reference inside a `RUN node …`
  line is resolved by a node *inside the image*, against that image's file system.
- `.env`, and `.env` reached through the template rule below. KEY=VALUE lines read by docker compose
  and by `process.env`; a value reaches a program's environment, never a module resolver. It has to
  be named as a basename as well as an extension, because `path.extname('.env')` is the empty string.

**2 — A template is classified as the file it is a template of.**

`.example`, `.sample` and `.template` are stripped, repeatedly, and the remainder is classified.
`.env.example` classifies as `.env` and is inert; `handler.ts.example` classifies as `.ts` and is
**scanned**. A name that is only a suffix is left alone, because stripping it would leave nothing to
classify and the fall-through must decide it. This is why the quick answer — put `.example` in the
inert list — was refused: it is right about the one file in the tree and wrong about the kind.

**3 — `createRequire` is decidable exactly when its result is used at once on a plain quoted
string, and the specifier it names is then scanned like any other.**

It used to be matched as a bare word, in the table of constructs that manufacture a module reference
at run time. That reported two references in one file — one of them the `import { createRequire } from
'node:module'` that brings the name in, which is not a module reference to *the SDK* at all — while
never looking at the specifier sitting next to the call. The rule that replaces it:

- `createRequire(<anything>)` immediately followed by `.resolve('literal')`, or by `('literal')`,
  names that literal. The specifier is extracted and put through the same SDK matcher as every other
  specifier, so `createRequire(u).resolve('@anthropic-ai/claude-agent-sdk')` is now **detected as an
  import**. It was not, before.
- a `createRequire` call whose result is used any other way — bound to a name, returned, passed on,
  or called with something that is not a plain quoted string — is undecidable and is reported, because
  every later call through that binding could name anything.

The argument list is matched by counting parentheses with string awareness, so
`createRequire(resolve(webRoot, 'package.json')).resolve('next/dist/bin/next')` — the real call in
`run-acceptance.mjs` — is read correctly rather than by a regular expression that would stop at the
first `)`.

Both halves are exercised: the recognised table gains the two decidable shapes, the refused table
now names three undecidable ones — bound to a name, called on a variable, returned from a function —
and one test asserts against the real call's exact text that nothing is reported *and* that
`next/dist/bin/next` reaches the matcher.

## Alternatives considered

- **Scan `.conf`, `.env` and Dockerfiles with the specifier matcher anyway, since a false positive is
  the safe direction.** Attractive, and rejected on measurement: `compose.yaml` contains a healthcheck
  spelt `node -e "require('http')…"`, so the same reasoning applied to `.yaml` — already inert — would
  fail the gate on a file that reaches nothing. Widening the scan is a separate decision with its own
  evidence, not a side effect of classifying three files.
- **Add `.example` to the inert extensions.** Rejected; see Decision 2.
- **Keep the bare-word `createRequire` match and add the acceptance script to an allowlist.**
  Rejected: the gate has no allowlist for undecidable references and gains nothing by acquiring its
  first one. The construct was decidable all along; nobody had written the rule.

## Consequences

- **The gate now detects an SDK import written as `createRequire(u).resolve('…')`**, which it
  previously reported as "cannot decide" — a stop, but a stop that named the wrong problem — and
  which a reader could have talked past. That is a strictly larger detected set, not a smaller one.
- **A `createRequire` bound to a name still fails the gate**, in this repository and any other. If one
  ever has a real use here, the fix is to write the rule that makes it decidable, in this file, with
  the reason — not to stop looking.
- **`compose.yaml` and every other `.yaml` remain unscanned**, and now that this record names the
  `require('http')` in it, that is a known gap rather than an unexamined one. It is carried on
  W1-INT-02's PR as a declared gap.
