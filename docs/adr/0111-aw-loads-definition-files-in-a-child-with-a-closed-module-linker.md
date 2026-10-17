# ADR-0111 — `aw` loads definition files in a forked child with Node's type stripper and a closed module linker

Status: accepted
Date: 2026-10-02
Decided by: the planning writer of the developer-journey delivery, on the Owner's delegation of 2026-10-02 ("decide yourself, ask nothing")
Scope: `packages/aw/src/project/` (`loader-child.ts`, `load.ts`, `protocol.ts`, `problems.ts`, `diff.ts`), `packages/aw/src/config.ts` (`profileKeyRefs`), `packages/aw/src/commands/project.ts`, `packages/aw/src/commands/agent-versions.ts`; issue #452 (S1-14)

## Amendment (slice 2, 2026-10-03) — the loader serves project-relative modules (issue #523)

Reason: slice 2 of the delivery plan (§8) decides SD12:
the definition loader also serves project-relative modules whose real path stays inside the project
root, and packages other than `@indx-workspace/sdk/define` stay refused. The closed linker below
serves only `@indx-workspace/sdk/define` and refuses every other specifier
(`packages/aw/src/project/loader-child.ts:114-116`). So the agent that S2-06a renders, which
imports its tool with `import { orders } from '../tools/orders'`, fails with `import_refused`.
The `tools/` directory exists because of
[ADR-0113](0113-tools-defined-in-code-are-catalog-connectors-that-run-in-the-gateway.md); this
amendment decides nothing about tools and covers only how the loader links a file. "The slice-1
import limit" below already expected the change: "A later unit may widen the linker to
project-relative files whose real path stays inside the project root."

The loader was built by S2-09b (#548, PR #574); this record keeps the decision as decided.

- **The linker also serves a relative specifier.** A relative specifier is one that starts with
  `./` or `../`. It is resolved as a filesystem path, not as a URL:
  `path.resolve(path.dirname(importerRealPath), specifier)` on the raw specifier, after the
  extension rule below. A specifier that contains any of these characters is refused with
  `import_refused` before anything is resolved:
  - `%`, because no percent-decoding happens, so `%2e%2e` cannot pass for a disguised `..`;
  - `?` and `#`, because a file path has no query or fragment, and the URL forms would name a
    different module identity for the same file;
  - a backslash, because it is a path separator only on Windows, so one spelling would resolve to
    different files on different operating systems;
  - `:`, because on NTFS `name:stream` addresses an alternate data stream of a file:
    `../tools/orders.ts:evil` would open the stream `evil.ts` of `orders.ts`, content that no
    directory listing, watcher or review shows. Elsewhere a colon in a file name is not portable.

  The resolved path is served only when its real path, after `realpath` has followed every
  symlink, meets all of these:
  - it is a regular `.ts` file;
  - it is strictly inside the project root's real path, by the same test `readInstructions`
    uses: `path.relative` from the root is not `''`, not `..`, does not start with `..` and a
    separator, and is not absolute;
  - no segment of that root-relative path, split on POSIX `/`, equals `node_modules` compared
    case-insensitively, so a relative path cannot reach a package, even as `Node_Modules` on a
    case-insensitive filesystem. Only the path relative to the root is tested, so a project
    whose root itself sits under a `node_modules` directory still serves its own files.
- **One extension rule, no probing.** If the specifier ends in `.ts`, such as
  `../tools/orders.ts`, it is used as written. Otherwise `.ts` is always appended, whatever the
  specifier already ends in: `../tools/orders` names `orders.ts`, which is the form the plan
  renders; `../tools/orders.schema` names `orders.schema.ts`; `../tools/orders.js` names
  `orders.js.ts`, never `orders.js`. Exactly one candidate is tried, and it must be an existing
  regular `.ts` file, so a `.js`, `.mts`, `.cts`, `.tsx` or `.json` file is never loaded. There
  is no directory index resolution and no rewriting of `.js` to `.ts`. A specifier that contains
  `?`, `#`, `%`, `:` or a backslash is refused before resolution.
- **An imported file is built like a definition.** The real file is read, stripped with the same
  `stripTypeScriptTypes` strip mode, and built as a `vm.SourceTextModule` whose identifier is the
  file URL of its real path and whose `import.meta` is set as for a definition. The same rules
  apply to its own imports, transitively.
- **An import with attributes is refused.** Any static import or re-export (`export … from`)
  whose import attributes are not empty, such as
  `import { orders } from '../tools/orders' with { type: 'json' }`, is `import_refused` with the
  usual `details`, and so is one of `@indx-workspace/sdk/define` (`with { type: 'css' }`). The
  check runs on every module request before its specifier is resolved. An attribute asks for a
  module type (JSON, CSS, ...) that this linker never serves: it serves only the synthetic define
  module and stripped `.ts` source modules, and serving the attributed request as source would
  give a different module than Node gives for it.
- **One instance per real path.** Each real path is instantiated at most once per load. A cycle
  between two project files therefore links, and two definitions that import one tool share one
  instance of it, as under Node. A cached module that failed to strip, link or evaluate stays
  failed for the rest of the load: every definition that imports it, directly or transitively,
  gets the same problem code and the same `details` as the first one did, and the linker never
  re-links or re-evaluates the errored instance.
- **Everything else stays refused with `import_refused`:** every package other than
  `@indx-workspace/sdk/define`; `node:*` built-ins; absolute paths and `file:` and `data:` URLs;
  a symlink or `..` that leaves the root; a missing target, or one that is not a `.ts` file; a
  specifier that contains `%`, `?`, `#`, `:` or a backslash; any import with import attributes;
  and `import()`, because there is still no `importModuleDynamically`.
- **Problem lines keep their one shape.** A problem is attributed to the definition file being
  evaluated. When the refused import sits in an imported module, `details` is the specifier and
  then the importer's POSIX path relative to the root:

  ```text
  agents/support.ts: local import_refused [node:fs, tools/orders.ts]
  ```

  A stripping or evaluation failure in an imported module keeps its existing code. No new loader
  problem code is added.
- **The §42 gate is unchanged.** `tests/no-sdk-import.test.ts` is not edited. The new linker work
  uses only `realpath`, `readFile`, `path`, the `vm` and `module` namespaces and
  `pathToFileURL` for module identifiers: no `import()`,
  no `createRequire`, no `require.resolve`. The tracked tree's reachability stays
  `aw → sdk/define`. The gate also refuses a string literal that resolves to an existing module
  when it is handed to a call the gate cannot vouch for (a callee not bound in the same file and
  no explicit base URL), so the implementation tests a specifier's prefix with a regular expression literal or a
  character comparison, never by passing such a literal to a string method.
- **The child is still not a sandbox, and the runtime never imports these modules.** "The child
  is not a sandbox" below still holds: an imported file is the user's own code, with the same
  access as a definition. The runtime never imports these modules; only what the loader derives
  from them reaches the server, the bodies and, from S2-09c, the connectors. The extensionless
  form therefore creates no divergence between `aw` and the runtime, unlike the TypeScript
  loader dependency under "Alternatives rejected". A secret named only in a TS `secret()` call in
  a tool file reaches the environment of the first loader child that evaluates it. That is the
  declared gap of
  [ADR-0109's slice-2 amendment](0109-the-local-runtime-publishes-as-one-bundled-package-that-aw-dev-runs-from-the-project.md)
  (SD17), and this amendment does not change it.

Implemented by:

- **S2-09b**, PR #574 (`packages/aw/src/project/loader-child*.ts`, `load*.ts`, `protocol*.ts`,
  `packages/aw/README.md`, `packages/aw/CHANGELOG.md`). Tests: a definition that imports
  `../tools/orders` loads; a symlink that escapes the root is `import_refused`; `../../x` is
  `import_refused`; `node:fs` imported in a tool file is `import_refused`; a tool file that
  imports another package is `import_refused`; a path through `node_modules` or `Node_Modules`
  is `import_refused`; a project whose root sits under a `node_modules` directory still loads
  `../tools/orders`; `../tools/orders.js` and a specifier containing `%2e%2e` are
  `import_refused`; `../tools/orders.schema` loads `orders.schema.ts`; a cycle between two
  project files links; two definitions that import one failing tool both get the same code and
  `details`; a specifier holding `:` (`../tools/orders.ts:evil`) is `import_refused`; an import
  with attributes, of a project file (`../tools/orders` with `{ type: 'json' }`) or of
  `@indx-workspace/sdk/define` (with `{ type: 'css' }`), is `import_refused`.

Consequence and declared gap: `aw dev`'s watcher watches only `agents/` and `surfaces/`
(`packages/aw/src/dev/watch.ts:5`, and the comment at lines 42-45 says a module a definition
imports is not watched). Until S2-09c adds `tools/` to it, an edit to an imported module is synced
on the next save of a watched file. Each load still forks a fresh child, so no cache-busting is
needed.

Amended 2026-10-03 (issue #575): the refusal of `:` in a relative specifier and of any import with
import attributes were added to this amendment to match the S2-09b implementation (PR #574).

## Context

`aw check` and `aw push` (S1-14) must read a project's `agents/*.ts` and `surfaces/*.ts`, take
each file's default export (a `defineAgent` or `defineSurface` value from
`@indx-workspace/sdk/define`, S1-07) and turn it into an `AgentVersionBody`. The plan asks for
Node's native type stripping and no new dependency (ENGINEERING_GUIDELINES §40).

The obvious implementation is an in-process `import(pathToFileURL(file).href)`. The repository
cannot accept it:

- The §42 boundary gate, `tests/no-sdk-import.test.ts`, gives every call site in the tracked tree
  a verdict, and under [ADR-0031](0031-a-static-gate-cannot-be-complete-so-undecidable-must-mean-refused.md)
  a call it cannot decide is refused. It refuses `import(<non-literal>)`, any `createRequire` not
  called directly on a literal, and `require(<computed>)`, and it refuses resolving a package the
  owning package does not depend on.
- The [ADR-0109](0109-the-local-runtime-publishes-as-one-bundled-package-that-aw-dev-runs-from-the-project.md)
  amendment for `aw dev` (S1-13, issue #451) met the same gate and answered it by reading files and
  forking a path, never by resolving or importing a computed specifier.
- Widening the gate for one CLI command would make the tree's reachability undecidable at exactly
  the point the gate exists to watch: code the user wrote, loaded by a published binary.

A test under vitest would not prove the stripping either: vitest's module runner transforms a
fixture itself and would accept an `enum` that Node's stripper refuses.

## Decision

### A forked child loads the files

`packages/aw/src/project/loader-child.ts` runs in a child process that the parent starts with
`fork` on its own sibling path (`.ts` from `src`, `.js` from `dist`), with
`--experimental-vm-modules` and `--disable-warning=ExperimentalWarning`, an IPC channel with JSON
serialisation, the project root as working directory, and the parent's environment minus
`AGENT_WORKSPACE_API_KEY`, `ANTHROPIC_API_KEY` and every profile's `apiKeyRef` variable. The
parent kills it after 30 seconds (`loader_timeout`). Before each file the child sends an
`evaluating` message and waits until it has left the process, so a timeout, and a file that ends
the child without an answer (`process.exit()`, a top-level `await` that never settles:
`module_unfinished`), is attributed to that file. Anything the user's code writes with `console.*` reaches `aw`'s stderr, never
its stdout, so `--json` stays clean.

For each file the child:

1. strips types with `stripTypeScriptTypes(source, { mode: 'strip', sourceUrl })` from
   `node:module`, Node's own stripper, so non-erasable syntax (`enum`, `namespace`, parameter
   properties) fails with Node's own message;
2. builds a `vm.SourceTextModule` from the result, with `import.meta.url`, `.filename` and
   `.dirname` set as Node sets them for a module;
3. links it with a **closed linker**: exactly one specifier, `@indx-workspace/sdk/define`, is
   served, as a `vm.SyntheticModule` over `aw`'s own statically imported copy of that module.
   Every other specifier is refused by name (`import_refused`). No `importModuleDynamically` is
   given, so an `import()` inside user code fails;
4. evaluates it and reads `default`, which must carry the define brand (`isDefinedAgent` /
   `isDefinedSurface`). An agent's `instructions: { file }` is read beside the file and must stay
   inside the project root after following links.

The child replies with one IPC message and exits. The parent trusts nothing it receives: the reply
is parsed with strict Zod schemas (`project/protocol.ts`) whose bodies are the contracts'
`AgentVersionBodySchema` and `SurfaceDefinitionSchema`. The parent then groups surfaces by agent
and refuses an unknown agent, a duplicate agent name and a duplicate surface name (C9).

Before forking, the parent refuses with `typescript_unavailable` when
`process.features.typescript` is false, naming the Node version and the flag that turned it off.
It lists `agents/*.ts` and `surfaces/*.ts` itself: a symbolic link is followed only when its
target is a file inside the project (`file_link_refused` otherwise), and a name the protocol
cannot carry (a control or format character, `\`, `:`) is refused as `file_name_unsupported`, so
one bad file never hides the others.

### The gate is unchanged

`tests/no-sdk-import.test.ts` is not edited. Every call site in the loader is one the gate
already decides: calls on the bound `vm` and `module` namespaces, a `fork` of a computed path (the
S1-13 precedent), and `new URL` over literals. There is no `import()`, no `createRequire` and no
`eval`. The only module the user's code can reach at run time is `@indx-workspace/sdk/define`,
which `aw` already depends on, so the tracked tree's reachability stays `aw → sdk/define`. This
confines what the gate cares about; it does not route around it.

### Why a child, not the vm in-process

- `vm.SourceTextModule` exists only behind `--experimental-vm-modules`, a process flag `aw`
  cannot set on itself.
- A fresh process per load has an empty module cache, so S1-15's watch loop reloads a changed file
  with no cache-busting.
- A user's top-level code (a loop, `process.exit`, a thrown error) cannot take `aw` down or write
  to its stdout, and the environment's key variables are not in its environment.

### The child is not a sandbox

The closed linker limits what a definition file can **import**, which is what the §42 gate
watches. It does not limit what the file can **do**: the module runs in the child's main context,
so `process` is reachable, and `process.getBuiltinModule()` gives it every Node.js built-in. The
files are the user's own code and run with the user's file access, as `node agents/x.ts` would —
they can read the credentials `aw login` stores under `~/.config/agent-workspace/`. Withholding
the key variables keeps them out of an accidental `console.log(process.env)`; it is not isolation,
and the guide says so. A sandboxed loader (a fresh `vm` context, a permission-model child) is a
possible later unit, not part of this decision.

### The slice-1 import limit

A definition file may import only `@indx-workspace/sdk/define`; an `import type { … }`
statement is erased before linking and is therefore free. The inline form `import { type X }`
keeps its import (TypeScript's `verbatimModuleSyntax` semantics), so it is refused like any other. A shared helper file or another package is refused with
`import_refused` and its specifier. A later unit may widen the linker to project-relative files
whose real path stays inside the project root.

### Problem lines

Every problem has one shape, `{ file, status, code, details }`, and one human line:

```text
<file>: <status|local> <code>[ [detail, detail]]
agents/assistant.ts: 422 engine_capability_unsupported [mcp]
agents/assistant.ts: 403 forbidden
agents/assistant.ts: local typescript_syntax_unsupported [TypeScript enum is not supported in strip-only mode]
```

`file` is POSIX and relative to the project. Loader problems have no HTTP status and print
`local`. A definition that fails `toAgentVersionBody` or the contracts schema is
`400 invalid_agent_version`, the same answer the server's pipeline gives. A server refusal keeps
its status, code and details and is attributed to the agent's file, or to a surface's file when the
detail names `surfaces.<i>`. A transport or contract failure is not a problem line: it keeps exit
codes 4 and 3. Any problem exits 1.

### Writes need `--yes`; every write has a read-only form

`aw push`, `aw agents versions create` and `aw agents pointers set` change server state only with
`--yes`. Without it each runs its read-only form and exits 0: `push` prints the plan and the diff
using only `GET`s and `dryRun: true` `POST`s, `versions create` runs the server's check and prints
the number the version would get, and `pointers set` reads the versions and prints
`<environment>: <from> → <to>`. `aw check` never writes. An unchanged body is never saved twice:
`push --yes` points `local` at the newest version instead, or does nothing when it is already
there.

## Consequences

- `aw check` and `aw push` depend on two experimental Node 24 APIs, `vm.SourceTextModule` and
  `module.stripTypeScriptTypes`. Both are used in one file, the warnings are silenced in the child
  only, and the tests fork the real child, so a Node release that changes either fails CI rather
  than a user. `engines` stays `>=24`.
- A reviewer may read the vm execution as an eval-class way round §42. The closed linker is tested
  directly ("a bare import is refused", "a dynamic import fails"), and the gate test must pass
  unchanged.
- Tests that fork the child from `src` need `packages/sdk/dist` built first; Nx `test` depends on
  `^build`. The child file must use erasable syntax only and `import type` for its siblings.
- Each load costs one Node start (a few hundred milliseconds), acceptable for a command a person
  runs and for S1-15's debounced watch.
- `aw push` compares the files with the agent's newest version (an agent with no version yet
  with its export, the only state it has). The export is not compared with a version: a compiled
  policy, the write ceiling and engine-switch narrowing make the two differ for an unchanged agent.
- Until V-2, edits made outside `aw push` (the UI, `PATCH`) are not versioned. Setting a pointer
  writes the agent row and the pointer in one transaction, so both carry the same `updatedAt`; an
  agent row newer than its `local` pointer was edited since, and `aw push --yes` points `local` at
  the same version again, which applies it over the edit. The plan names the edit but cannot diff
  it.
- A multi-agent push is not atomic: agents are saved one at a time. The report's `saved` means
  every agent was saved, and each saved agent carries its own `saved: true`.
- In slice 1 the `403` `aw check` reports is the role and ownership `403` of RBAC; the policy
  `403 policy_cannot_widen` (ADR-0102, R-2) arrives in slice 3.

## Alternatives rejected

- **`import(pathToFileURL(file).href)` in-process.** Refused by the §42 gate as a computed
  specifier; widening the gate would make the tree's reachability undecidable.
- **A TypeScript loader dependency (`tsx`, `esbuild`, `typescript`).** A new runtime dependency in
  `aw` (§40), and it would accept syntax Node's own stripper refuses, so the project would load
  under `aw` and fail under the runtime.
- **Running the files through `node --import` with a custom loader hook.** The hook would still
  resolve arbitrary specifiers from the project, which is the reach the closed linker removes.
