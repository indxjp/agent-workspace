/**
 * **Nothing that a deployment runs constructs {@link InMemoryRunStore}.**
 *
 * Round 1 of verification found `store.ts` (now split into `store.ts` and `memory-store.ts`) claiming that `apps/web/instrumentation.ts` "refuses to
 * install it unless an operator asked for it by name", of a mechanism that did not exist. Round 2
 * found its replacement — "its two real consumers are this file's own conformance suite and
 * `…/acceptance/instrumentation.ts`" — also false: there are more importers than that, and the
 * number had been written rather than measured (ADR-0016). A third sentence would be a third
 * guess, so this block measures it instead, and prints the derived set on every failure.
 *
 * ## How the set is derived (ADR-0027)
 *
 * `git ls-files` with no pathspec (`store.gate-files.ts`), then two classifiers, each ending in
 * rejection:
 *
 *   1. every tracked path is a module this block parses or a file no `import` specifier can
 *      resolve to, decided by extension; an extension in neither set fails by name;
 *   2. every module that imports the name `InMemoryRunStore` from a specifier resolving to
 *      `memory-store.ts` is either a `*.test.ts`/`*.test.tsx` suite, or a harness — a module that names
 *      the `AW_ACCEPTANCE_HARNESS` environment variable it refuses to run without. Any other
 *      importer is a hard failure naming the file, because that is a module a deployment could
 *      load (`store.gate-importers.ts`).
 *
 * The imported *name* is read from the import clause with the TypeScript parser, so
 * `import { InMemoryRunStore }`, `import { InMemoryRunStore as X }` and `import * as store` are
 * each seen for what they are, and the class name appearing in a comment or a string is not.
 *
 * ## Where a specifier points is the compiler's answer, not a comparison of its text (ADR-0030)
 *
 * This block used to expand a specifier through an alias table it built out of the tracked
 * configuration files. That table was a model of a resolver, and verification rounds walked past
 * it repeatedly — through a `paths` alias, then through a `paths` block reached by an `extends`
 * target whose extension is not `.json` and which TypeScript loads verbatim. So the table is gone:
 * `resolutionsOf` (`store.gate-resolver.ts`) asks `ts.resolveModuleName` and compares the resolved
 * path — put through `realpathSync`, as is this module's own path — against this module. `paths`,
 * `baseUrl`, `extends` of any filename, `exports` maps and workspace symlinks are all the
 * compiler's job.
 *
 * ## Which options a specifier resolves through: project membership, also the compiler's answer
 *
 * Not the nearest `tsconfig.json` above the importing file. Walking up the directory tree is a
 * model of *project membership*, and round 5 walked past it: a tracked
 * `apps/web/server/leak/tsconfig.json` remapping `@/*` onto a stub redirected this gate while
 * `tsc -p apps/web/tsconfig.json` and `next build` went on resolving that file through
 * `apps/web/tsconfig.json`. A project's membership is its `files`/`include` globs, not the
 * directories above a file.
 *
 * So every tracked `tsconfig*.json` — found by shape, out of the same `git ls-files` listing this
 * block already reads — is parsed, and the set of files its **program** contains is that project's
 * membership. Not `parsed.fileNames`: those are the project's *root* names, and a `tsc -p` program
 * is that set plus everything the roots import, each of which resolves its own specifiers through
 * that project's options.
 *
 * A module's contexts are then the **union of three sets, never a choice between them**: every
 * project whose program contains it, the repository root `tsconfig.json`, and every tracked project
 * whose configuration file sits at or above it. The last two are this gate's choice rather than the
 * compiler's answer, and they are not decoration: this tree tracks `.mjs` and `.js` modules that no
 * project here compiles, so they are in no project's program and have no owner to ask. Taking the
 * union rather than preferring the owners
 * is the correction round 5 forced: the earlier version returned the owners exclusively whenever
 * there were any, so one `exclude` edit plus one nested `tsconfig.json` made the attacker's project
 * the only one consulted. A configuration file added to the tree adds contexts and removes none,
 * and `resolutionsOf` is monotone in its contexts, so an importer this gate already classifies
 * cannot be taken away by adding one. Measured: with `apps/web/server/leak/vattack-runstore.ts`
 * importing the class through `@/server/runs/store`, `"server/leak"` in `apps/web`'s `exclude` and
 * a nested `apps/web/server/leak/tsconfig.json` remapping `@/*` onto a stub, this gate is red and
 * reports `other: apps/web/server/leak/vattack-runstore.ts`. That sentence is about **importers**.
 * It is deliberately not a claim about the hard failures below: a context added to the set can give
 * a resolution to a specifier that previously resolved nowhere, and the throw that specifier used
 * to raise would then not be raised.
 *
 * A dynamic import expression or a CommonJS require whose argument is not a string literal is a
 * hard failure: its specifier is a run-time value, and a gate that read nothing out of it would
 * report the file as a non-importer. So is a *path* specifier the compiler cannot resolve that
 * names no file on disk either. (Said without the call syntax on purpose:
 * `tests/no-sdk-import.test.ts` scans comments too, and a bare call construct with no literal
 * argument reads as undecidable to it.)
 *
 * ## Every call site gets a verdict (ADR-0031 clause 1)
 *
 * A call, a construction or a tagged template that is neither of those two constructs does not fall
 * out of the walk unread. It is asked one question — *is this call handed a string that resolves to
 * `memory-store.ts`, by a callee this file cannot vouch for?* — and it leaves with one of two
 * verdicts: **refused**, naming the file, the callee as written and the module; or **decided**,
 * meaning no string this gate can read at that call site names `memory-store.ts`.
 *
 * "Vouched for" is not a list of callee names. It is: the callee is rooted at an identifier this
 * file declares and does not bind straight to another reference. So a property chain ending in
 * `require` — reached through `globalThis`, `require.main` or `process.mainModule` — a bare
 * `require` inside a parenthesised comma expression, whose root *is* `require` once the parentheses
 * and the comma are unwrapped, and a `require` bound to another name and called through it are all
 * refused, as is any **construction**, because a constructed `Worker` loads and runs a module.
 * (Written without the call syntax on purpose, for the reason the paragraph above gives.)
 *
 * ## Where that stops
 *
 * A string this gate cannot read at the call site is not examined: a specifier arriving through a
 * parameter, assembled by a computation, or inside the source text handed to `eval` or to the
 * `Function` constructor. Those last two are measured open and are in this PR's declared gaps.
 * The rule is deliberately not "refuse every call handed a string": a string at a call site is
 * resolved by `stringNamesTheStore`, which reaches no verdict of "unresolvable", because
 * `fetch('/api/agents')` in `apps/web/components/agents/agent-form.tsx` is a string and not a
 * reference this gate failed to decide — measured, routing it through `namesTheStore` instead
 * fails this gate on that component.
 */
import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { classifyTrackedFiles, repositoryRoot, storeModule } from './store.gate-files';
import { classifyImporters, COMPUTED_IMPORT_DECISIONS } from './store.gate-importers';
import { createStoreResolver } from './store.gate-resolver';

describe('nothing a deployment loads constructs the in-memory run store', () => {
  const tracked = execFileSync('git', ['-C', repositoryRoot, 'ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\0')
    .filter((file) => file !== '');
  const files = classifyTrackedFiles(tracked);
  const resolver = createStoreResolver(files, storeModule);
  const { suites, harnesses, deployable } = classifyImporters(
    files.root,
    files.modules,
    resolver,
    storeModule,
  );

  const derivedSet = (): string =>
    `suites: ${suites.join(', ') || '(none)'}\nharnesses: ${harnesses.join(', ') || '(none)'}\n` +
    `other: ${deployable.join(', ') || '(none)'}`;

  it('holds exactly one decided computed dynamic import: the one ADR-0115 names', () => {
    expect([...COMPUTED_IMPORT_DECISIONS.keys()]).toEqual(['packages/aw/src/tools/host-child.ts']);
  });

  it('found importers to classify, so the classification is not vacuous', () => {
    expect(
      suites.length + harnesses.length + deployable.length,
      `no module imports InMemoryRunStore from ${storeModule}. Either the specifier resolver is ` +
        `broken or the class was renamed; either way this gate proved nothing.\n${derivedSet()}`,
    ).toBeGreaterThan(0);
  });

  it('classifies every importer as a suite or as the acceptance harness', () => {
    expect(
      deployable,
      'These modules import InMemoryRunStore and are neither a *.test.ts suite nor a harness ' +
        'that names AW_ACCEPTANCE_HARNESS, so a deployment could load one of them and quietly ' +
        `serve runs out of a Map that a restart empties.\n${derivedSet()}`,
    ).toEqual([]);
  });

  it('found the acceptance harness among them, so the harness arm is not dead', () => {
    expect(
      harnesses.length,
      'no importer named AW_ACCEPTANCE_HARNESS, so the harness arm of this classification has ' +
        'never been taken and would not be noticed if it stopped working.\n' +
        derivedSet(),
    ).toBeGreaterThan(0);
  });
});
