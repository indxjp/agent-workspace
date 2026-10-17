/**
 * **A file outside the database layer obtains a database through `@agent-workspace/core/db`.**
 *
 * The mechanism, so that a reader can check the code against it rather than against a claim: this
 * file parses the tracked tree, hands every module specifier it finds to the TypeScript compiler's
 * own resolver, keeps the ones whose *resolved file* lands inside the layer, hands each one to
 * `decide()` for a verdict, and asserts that the refused verdicts are an empty list.
 *
 * ## Why this exists as well as the compile-time gate
 *
 * `packages/core/src/db/index.ts` no longer exports a way to obtain a database handle, and
 * `scope-forgery.test.ts` runs `tsc` over the attempt to prove it. Two things that gate cannot see:
 *
 *   1. `@agent-workspace/core/db/unscoped` — the declared escape — compiles from anywhere.
 *      TypeScript has no visibility rule that admits one importer and refuses another, and this
 *      repository's `tsconfig.json` and `eslint.config.mjs` belong to W0-INF-01.
 *   2. A path that walks out of `apps/web` and into the layer compiles too, because a path does not
 *      consult a package's `exports` map. Measured, not assumed: that is what a route handler
 *      carrying `import { createDatabase } from '../../../../../packages/core/src/db/client'` did
 *      before this file existed, with `tsc` exiting 0 — and, in verification round 2, what the same
 *      handler did with `../../../../../packages/core/dist/db/client.js`, also with `tsc` exiting
 *      0, because this gate then knew only the `src` half of the layer.
 *
 * ## Why the compiler resolves the specifiers (ADR-0030)
 *
 * Verification reached the layer again and again through a specifier this gate compared as *text*,
 * each time with a different spelling and each time with `tsc`, `eslint` and this gate all green:
 * a `tsconfig` `paths` alias; a `paths` block pulled in through an `extends` target whose extension
 * is not `.json`, which TypeScript loads verbatim; and a relative path through
 * `apps/web/node_modules/@agent-workspace/core`, the pnpm workspace symlink, which needs no
 * configuration change at all. Every one of them was a different spelling of one mistake: **a
 * module specifier is not a string, it is the input to a resolution algorithm**, and a table of
 * alias prefixes maintained beside the gate is a model of a resolver rather than a resolver.
 *
 * So the table is gone. `resolvedFiles` below asks `ts.resolveModuleName` and compares the
 * **resolved absolute path**. `paths`, `baseUrl`, `extends` of any filename, `exports`/`imports`
 * maps and workspace symlinks are the compiler's job, decided by the library `tsc` itself is built
 * out of rather than by a rule restated here.
 *
 * A resolved path is put through `realpathSync` before it is compared, and so are the layer's own
 * roots, so the comparison is between two real paths on disk. That is the choice this file makes
 * about symlinks, stated rather than inherited: the pnpm workspace link
 * `apps/web/node_modules/@agent-workspace/core` and `packages/core` are the same directory, and a
 * specifier that reaches the layer through the link reaches the layer.
 *
 * ## Which options a specifier resolves through: project membership, also asked of the compiler
 *
 * Not the nearest `tsconfig.json` above the importing file. Walking up the directory tree is itself
 * a model — of *project membership* this time — and verification round 5 walked past it: a tracked
 * `apps/web/server/leak/tsconfig.json` remapping `@/*` onto a stub redirected this gate's resolver
 * while `tsc -p apps/web/tsconfig.json` and `next build` went on resolving that same file through
 * `apps/web/tsconfig.json`.
 *
 * So membership is asked of the compiler. Every tracked `tsconfig*.json` — found by shape, out of
 * the same `git ls-files` listing the rest of this gate reads — is parsed with
 * `getParsedCommandLineOfConfigFile`, and the set of files its **program** contains is that
 * project's membership. Not `parsed.fileNames`: those are the project's *root* names, what its
 * `files`/`include`/`exclude` globs list, and a `tsc -p` program is that set plus everything the
 * roots import. Round 5 reached the layer through the difference, in the round after this gate
 * started reading root names: a file dropped out of `apps/web`'s `include` was still in the program
 * `tsc -p apps/web/tsconfig.json` builds and still resolved `@/*` through `apps/web`'s `paths`.
 * `ts.createProgram(parsed.fileNames, parsed.options).getSourceFiles()` is the compiler's own
 * answer to "which programs contain this file", and it is the answer `tsc -p` and `next build`
 * act on.
 *
 * A module's resolution contexts are then the **union of three sets, never a choice between them**:
 * every project whose program contains it; the repository root `tsconfig.json`, the options every
 * other config here extends and Node's own `moduleResolution`, Node being what loads a file no
 * project compiles; and every tracked project whose configuration file sits at or above it, because
 * a bundler that reaches such a file still resolves through the `paths` declared above it. The last
 * two are this gate's choice rather than the compiler's answer. A specifier reaches the layer when
 * **any** context places it there.
 *
 * Taking the union rather than preferring the owning projects is the second half of the round-5
 * correction, and it is what the earlier version got wrong: that one returned the owners
 * exclusively whenever there were any, so one `exclude` edit plus one nested `tsconfig.json` made
 * the attacker's project the only one consulted. The widened half is not decoration either: this
 * tree tracks `.mjs` and `.js` modules that no project here compiles, so they are in no project's
 * program and have no owner to ask.
 *
 * **What the union buys, stated no wider than it is true.** A configuration file added to the tree
 * adds contexts and removes none, and `resolvedFiles` is monotone in its contexts — one more
 * context can only add a resolution — so *an edge this gate already refuses cannot be taken away by
 * adding a configuration file.* Measured: with the leak barrel and the stub tree in place, the gate
 * is red; adding `"server/leak"` to `apps/web`'s `exclude` leaves it red; adding
 * `apps/web/server/leak/tsconfig.json` on top of that leaves it red, naming both barrel rows
 * against `packages/core/dist/db/client.d.ts` — the real layer, not the stub. That sentence is
 * about **edges**. It is deliberately not a claim about the hard failures raised elsewhere in this
 * file: a context added to the set can give a resolution to a specifier that previously resolved
 * nowhere, and the throw that specifier used to raise would then not be raised.
 *
 * ## How the sets are derived (ADR-0027)
 *
 *   * **The layer's own location is derived from `packages/core/package.json`.** The `./db` export
 *     is an object of conditions — `types` names a source file, every other condition names a
 *     build-output file — and the directory of each one is a *root* of the layer. That is how
 *     `packages/core/dist/db/` became something this gate can see: not by adding a second literal,
 *     but by reading the manifest condition that already named it. A root that does not exist on
 *     disk is a hard failure naming it (ADR-0015): the layer's build output is half of what this
 *     gate compares against, and a resolver cannot resolve a path to a directory that is not there.
 *   * **The contributing set is the whole tracked tree.** `git ls-files` is run with no pathspec,
 *     and every path it returns is classified by extension into a module this gate parses or a
 *     file no import specifier can resolve to. An extension in neither set is a hard failure
 *     naming the file: verification round 2 found the pathspec `'*.ts' '*.tsx' '*.mts' '*.cts'`
 *     dropping the tracked `.mjs` acceptance harness, and a pathspec cannot say "and nothing else".
 *   * **The admitted subpaths are derived from the manifest too**, not from a literal: every key
 *     under `./db` is a database entry point, `./db` is the public one, and **every other one is an
 *     escape** admitted only to a `*.test.ts`.
 *   * **A second door is decided by the names an export exposes, not by where its own file sits.**
 *     An export key that is not a `./db…` subpath is a hard failure when its target lands inside
 *     the layer, and also when the *names on its surface* are declared inside the layer and the
 *     public `./db` subpath does not expose them. The second half is why a `./persistence` export
 *     pointing at a module one hop outside the layer that re-exports `createDatabase` from inside
 *     it is a failure: verification round 4 built exactly that and the earlier rule, which compared
 *     only the key's own target against the layer roots, waved it through.
 *   * **A subpath's surface is read from every condition the manifest declares for it**, not from
 *     its `types` condition. `tsc` reads `types`; Node reads `default` — measured from `apps/web`,
 *     where `createRequire(…).resolve('@agent-workspace/core')` answers
 *     `packages/core/dist/index.js` while the `types` condition of `.` names
 *     `packages/core/src/index.ts`. Round 5 split the two: a `./persistence` key whose `types` was
 *     a hand-written `declare` stub and whose `default` was a compiled module re-exporting the
 *     layer published `createDatabase` to every caller while a `types`-only check read the stub.
 *     Reading one condition is the same shape of mistake as comparing specifier text — a model of
 *     what the consumer resolves.
 *   * **Specifiers are read with the TypeScript parser**, not with a regular expression over the
 *     text. `scope-forgery.test.ts` and `apps/web/server/agents/store.test.ts` both contain module
 *     specifiers inside string literals and comments, and a text scan would classify those as real
 *     edges. The parser sees import declarations, `export … from`, import type nodes, dynamic
 *     import expressions and CommonJS require calls, and nothing that is merely quoted; it also
 *     hands back the *cooked* specifier, so a string escape in one is the character it denotes.
 *     (Described without the call syntax on purpose: `tests/no-sdk-import.test.ts` scans comments
 *     too, and a bare call construct with no literal argument reads as undecidable to it.) A
 *     dynamic import or require whose argument is *not* a string literal is a thrown failure naming
 *     the file: its specifier is a run-time value this gate cannot follow, and round 3 reached the
 *     layer through one, with `tsc` exiting 0 and this gate reporting 8 passed.
 *   * **What happens to something a classifier cannot place: it throws.** A tracked file whose
 *     extension this gate does not recognise, a tracked module that will not parse, a tracked
 *     `tsconfig*.json` that will not parse, a dynamic import or require whose specifier is not
 *     readable, a `@agent-workspace/core/db…` specifier the manifest does not declare, an export
 *     condition naming a file this gate cannot read a surface out of, and a *path* specifier the
 *     compiler cannot resolve that names no file on disk either are each a thrown failure naming
 *     the file — never a skip, never a filtered-out row (ADR-0027 clause 3). An edge that reaches
 *     the layer and matches no permitted rule is the one case that is not a throw: it becomes a row
 *     in the refused list that the last assertion compares against `[]`, which is what lets one
 *     failure name several.
 *   * **The failure output prints the derived set**, because a reader can no longer find it by
 *     reading a list in this file (ADR-0027 clause 4).
 *
 * ## Every call site gets a verdict (ADR-0031 clause 1)
 *
 * A call, a construction or a tagged template that is not a dynamic import and not a `require` does
 * not fall out of the walk unread. It goes to `decideUnvouchedCall`, which asks one question — *is
 * this call handed a string that resolves to a file inside the layer, by a callee this file cannot
 * vouch for?* — and answers it two ways, both decisions:
 *
 *   * **refused**, naming the file, the callee as written and the file the string lands in. The
 *     call is refused without deciding whether it loads anything, because the gate cannot show that
 *     it does not;
 *   * **decided**: no string this gate can read at that call site lands in the layer, so at that
 *     call site nothing names it.
 *
 * "Vouched for" is not a list of callee names — no list of names ever finishes, which is the
 * finding this arm exists to close. It is: the callee is rooted at an identifier this file declares
 * and does not bind straight to another reference. A callee rooted at a free name (`globalThis`,
 * `process`, `require` in a CommonJS module) or at `const load = require;` is not vouched for, and
 * neither is any **construction**: a constructed `Worker` really does load and run a module.
 * Parentheses and comma expressions are unwrapped first, so a bare `require` written inside a
 * parenthesised comma expression reaches this arm with `require` as its root rather than as a
 * callee shape nobody named. (All of this without the call syntax on purpose, for the reason two
 * bullets up: `tests/no-sdk-import.test.ts` scans comments too.)
 *
 * ## Where that stops, stated so nobody has to discover it
 *
 * The second arm is the limit, and it is a real one. A string this gate cannot read at the call
 * site is not examined: a specifier arriving through a parameter, assembled by a computation, or
 * living inside the source text handed to `eval` or to the `Function` constructor. Measured on this
 * tree, the indirect spellings verification has built are refused — a `require` bound to another
 * name and called through it; a property chain ending in `require`, reached through `require.main`,
 * `process.mainModule` or `globalThis`; a bare `require` inside a parenthesised comma expression;
 * `Reflect.apply` handed the `require` function and an array literal; a spread of an array literal;
 * a constructed `Worker`; and a specifier held in a `const`. Two are **not** refused: a specifier
 * that exists only inside the source text handed to `eval`, and one inside the body string handed
 * to the `Function` constructor. Those two are this gate's edge, they are in this pull request's
 * declared gaps with their counter-example, and a static analysis over a dynamic language cannot
 * close them.
 *
 * The rule is deliberately *not* "refuse every call handed a string that resolves into the layer".
 * That was implemented and measured against this tree: with vouching switched off it refuses
 * `path.resolve(…, '..')` in this file and in `scope-forgery.test.ts`, `key.split('.')` in
 * `../schema/tenancy.test.ts`, `execFileSync('git', ['-C', '.', …])` and
 * `specifier.startsWith('.')`, because `'.'` and `'..'` resolve to the `index.ts` of a directory
 * inside the layer. The vouching rule is what makes this arm affordable, and it is also where the
 * arm's reach ends.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** `…/packages/core/src/db/repositories/<this file>` → the repository root, six levels up. */
const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..', '..');

/** Repository-relative, forward slashes, so a comparison means the same thing on either OS. */
const posix = (value: string): string => value.split(path.sep).join('/');

/**
 * The repository root as the filesystem really spells it.
 *
 * Every path this gate compares is put through `realpathSync` first, so both sides of a comparison
 * have followed the same links; the root has to be resolved the same way or the relative paths
 * taken against it would not line up.
 */
const realRepoRoot = realpathSync(repoRoot);

/** One absolute path, resolved through any symlinks, as a repository-relative posix path. */
function repoRelativeReal(absolute: string): string {
  let real = absolute;
  try {
    real = realpathSync(absolute);
  } catch {
    // A path that is not on disk cannot be resolved through links, and is compared as written.
    // Nothing inside the layer reaches this branch: the layer roots are asserted to exist below.
  }
  return posix(path.relative(realRepoRoot, real));
}

/**
 * The package that owns the database layer.
 *
 * A file inside it is on the same side of the module boundary as the layer, and its imports into
 * the layer's *source* are that package's own business — `packages/core/src/schemas.ts` imports the
 * `AgentPermissions` Zod schema from `db/schema/agents.ts` rather than restating §17 Step 4 twice,
 * and that is the shape it is meant to be. What this gate constrains is every file *outside* this
 * directory, which can reach the layer only through the `exports` map read below — and, for every
 * file including this package's own, a path into the layer's build output.
 */
const OWNING_PACKAGE = 'packages/core/';

/** The package whose subpaths this gate is about. */
const PACKAGE = '@agent-workspace/core';

/** The manifest this gate derives every path in it from. */
const MANIFEST = 'packages/core/package.json';

/**
 * Extensions Node and `tsc` resolve as modules. A tracked file with one of these is parsed, and an
 * import edge can only come from one of them.
 */
const MODULE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/**
 * Extensions that name prose, data, configuration or an asset — a file no `import` specifier
 * resolves to, so a file with one of these contributes no edge. `''` covers `LICENSE`, `Dockerfile`
 * and every dotfile, for which `path.extname` answers the empty string.
 *
 * This is a set of *shapes*, not of paths, and the arm after it rejects: adding a `.vue` or a
 * `.svelte` to the tree fails this gate by name until somebody decides which half it belongs in.
 * That is the intended cost.
 */
const NON_MODULE_EXTENSIONS = new Set([
  '',
  '.avif',
  '.conf',
  '.css',
  '.csv',
  '.dockerfile',
  // A Word draft (tests/gallery/contract-review): a zip of XML parts a tool reads.
  '.docx',
  // A CAD drawing in ASCII DXF (tests/gallery/cad-drafting): group-code/value lines a tool reads.
  '.dxf',
  '.example',
  '.gif',
  '.gitkeep',
  '.html',
  '.hcl',
  '.ico',
  '.jpeg',
  '.jpg',
  '.json',
  '.jsonc',
  '.lean',
  '.lock',
  '.map',
  '.md',
  '.mdx',
  '.npmrc',
  '.png',
  '.ps1',
  '.sh',
  '.snap',
  '.sql',
  '.service',
  '.svg',
  '.tf',
  '.tftpl',
  // A Helm named-template partial (infra/helm/*/templates/_helpers.tpl).
  '.tpl',
  '.timer',
  '.toml',
  '.txt',
  // A WebVTT meeting transcript (tests/gallery/meeting-minutes).
  '.vtt',
  '.webp',
  '.woff',
  '.woff2',
  // An Excel workbook (tests/gallery/excel-consolidation): a zip of XML parts a tool reads.
  '.xlsx',
  '.yaml',
  '.yml',
]);

/** One condition of one declared subpath, with the repository-relative file it names. */
interface DeclaredTarget {
  /** The manifest key: `./db`, `./db/unscoped`, … */
  readonly subpath: string;
  /** The `exports` condition: `types`, `default`, … */
  readonly condition: string;
  /** Repository-relative path of the file that condition names. */
  readonly target: string;
}

/** Every condition of every key in the manifest's `exports`, flattened, in declaration order. */
function declaredTargets(): readonly DeclaredTarget[] {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, MANIFEST), 'utf8')) as {
    exports?: Record<string, Record<string, string> | string>;
  };
  const exportsMap = manifest.exports;
  if (exportsMap === undefined) {
    throw new Error(`${MANIFEST} declares no "exports"; this gate cannot run.`);
  }
  const flat: DeclaredTarget[] = [];
  for (const [subpath, value] of Object.entries(exportsMap)) {
    const conditions = typeof value === 'string' ? { default: value } : value;
    for (const [condition, specifier] of Object.entries(conditions)) {
      if (typeof specifier !== 'string') {
        throw new Error(
          `${MANIFEST} exports "${subpath}" with a "${condition}" condition that is not a string, ` +
            'so this gate cannot tell which file it names.',
        );
      }
      flat.push({
        subpath,
        condition,
        target: posix(path.posix.normalize(`packages/core/${specifier.replace(/^\.\//u, '')}`)),
      });
    }
  }
  return flat;
}

const allTargets = declaredTargets();

/**
 * The public subpath's own targets, one per condition. `types` names the source barrel and every
 * other condition names a compiled one, so this is where both halves of the layer are found.
 */
const publicTargets = allTargets.filter((row) => row.subpath === './db');
if (publicTargets.length === 0) {
  throw new Error(
    `${MANIFEST} declares no "./db" export. Either the manifest changed shape or this gate is ` +
      'reading the wrong file; either way it cannot run, so it fails (ADR-0015).',
  );
}

/**
 * The layer's roots, derived: the real directory of each condition of `./db`.
 *
 * `types: "./src/db/index.ts"` gives `packages/core/src/db/`; `default: "./dist/db/index.js"` gives
 * `packages/core/dist/db/`. Nothing here is written down as a path.
 */
const layerRoots: ReadonlyMap<string, string> = new Map(
  publicTargets.map((row) => {
    const directory = path.posix.dirname(row.target);
    // The consistency check that keeps this derivation from widening. `./db` names a directory
    // called `db`; if the manifest ever pointed the subpath at, say, `./src/db.ts`, `dirname`
    // would answer `packages/core/src` and every file in the package would read as "inside the
    // layer" — a gate that had quietly stopped constraining anything. The expected name comes
    // from the subpath itself, not from a literal.
    const expected = row.subpath.slice('./'.length);
    if (path.posix.basename(directory) !== expected) {
      throw new Error(
        `${MANIFEST} exports "${row.subpath}" with "${row.condition}": "${row.target}", whose ` +
          `directory is "${directory}". This gate takes that directory to be the database layer ` +
          `and expects it to be named "${expected}". It is not, so the derivation would widen ` +
          'past the layer rather than describe it.',
      );
    }
    // ADR-0015. The comparison this gate makes is between real paths, and a resolver answers
    // "no such module" for a path under a directory that is not on disk — so a missing build
    // output would turn every reach into the compiled half of the layer into a silent pass.
    const absolute = path.join(repoRoot, directory);
    if (!existsSync(absolute)) {
      throw new Error(
        `${MANIFEST} exports "${row.subpath}" with "${row.condition}": "${row.target}", and ` +
          `"${directory}" does not exist. Run \`pnpm --filter @agent-workspace/core run build\` ` +
          'before `pnpm test`; CI does this in a step of its own. This gate compares resolved ' +
          'paths against that directory and cannot decide anything about it while it is absent.',
      );
    }
    return [row.condition, `${repoRelativeReal(absolute)}/`];
  }),
);

/** The half of the layer that is checked in. Reaching it from inside `packages/core` is that
 * package's own business; reaching any *other* root never is. */
const declaredSourceRoot = layerRoots.get('types');
if (declaredSourceRoot === undefined) {
  throw new Error(
    `${MANIFEST}'s "./db" export declares no "types" condition, so this gate cannot tell which ` +
      "directory holds the layer's source.",
  );
}
const sourceRoot: string = declaredSourceRoot;

/**
 * Is this repository-relative path under `root`, which ends in a slash?
 *
 * The directory itself counts, because a specifier can name one: a route handler carrying
 * `import { openDatabaseRoot } from '@/../../packages/core/src/db'` compiles — measured, `tsc`
 * exits 0 on it — and a comparison that only tested the trailing-slash prefix would answer "no".
 */
const underRoot = (candidate: string, root: string): boolean =>
  candidate.startsWith(root) || candidate === root.slice(0, -1);

/** Is this repository-relative path inside any root of the database layer? */
const insideLayer = (candidate: string): boolean =>
  [...layerRoots.values()].some((root) => underRoot(candidate, root));

/**
 * The manifest's own classifier, run for its side effect: every export key is either a database
 * entry point whose every condition lands inside the layer, or an export that reaches no root of
 * the layer at all. Anything between the two is a hard failure.
 *
 * The middle case is not hypothetical bookkeeping. An export named, say, `./persistence` pointing
 * at `./src/db/client.ts` would open the layer under a name the rest of this file does not
 * recognise, and the previous version of this loop skipped every non-`./db` key with a `continue`.
 * An export whose target sits *outside* the layer and re-exports from inside it is the same door
 * with one more hop, and the surface check further down is what closes that one.
 */
const databaseSubpaths = new Set<string>();
for (const row of allTargets) {
  const isDatabaseKey = row.subpath === './db' || row.subpath.startsWith('./db/');
  if (isDatabaseKey && insideLayer(row.target)) {
    databaseSubpaths.add(row.subpath);
  } else if (isDatabaseKey) {
    throw new Error(
      `${MANIFEST} exports "${row.subpath}" with "${row.condition}": "${row.target}", which is ` +
        `under none of the layer roots ${[...layerRoots.values()].join(', ')}. This gate ` +
        'classifies database entry points and cannot classify that one.',
    );
  } else if (insideLayer(row.target)) {
    throw new Error(
      `${MANIFEST} exports "${row.subpath}" with "${row.condition}": "${row.target}", which is ` +
        'inside the database layer under a key that is not a "./db" subpath. That is a second ' +
        'public door into the layer, and this gate would not have classified anything that went ' +
        'through it.',
    );
  }
  // The fourth arm: an export that names no file inside the layer. Its *surface* is still
  // classified, by the last describe block in this file.
}

/**
 * The declared database subpaths, partitioned: the public one, and — by definition, not by a list
 * — every other one, which is an escape. Written as a partition rather than as a `filter` so that
 * both halves are visibly accounted for and neither can be dropped.
 */
const escapeSubpaths = new Set<string>();
const publicSubpaths = new Set<string>();
for (const subpath of databaseSubpaths) {
  if (subpath === './db') publicSubpaths.add(subpath);
  else escapeSubpaths.add(subpath);
}
if (publicSubpaths.size !== 1) {
  throw new Error(
    `${MANIFEST} declares ${String(publicSubpaths.size)} public database subpaths; this gate is ` +
      'written for exactly one and would classify the others as neither public nor escape.',
  );
}

/** One import edge: who wrote it, and what it names. */
interface Edge {
  /** Repository-relative path of the file containing the import. */
  readonly from: string;
  /** The specifier exactly as written. */
  readonly specifier: string;
  /** For a subpath edge, the manifest key it named. `null` for a path edge. */
  readonly subpath: string | null;
  /** The repository-relative file the compiler resolved the specifier to. */
  readonly target: string;
  /**
   * How the specifier named the layer: through the package's `exports` map, or as a path — which
   * after resolution is one thing whether it was written relatively, through a `paths` alias, or
   * through the pnpm workspace symlink.
   */
  readonly via: 'subpath' | 'path';
}

/** Every tracked path, with no pathspec at all. The narrowing happens in a classifier, below. */
function trackedFiles(): readonly string[] {
  const listing = execFileSync('git', ['-C', repoRoot, 'ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return listing.split('\0').filter((file) => file !== '');
}

/**
 * Classify one tracked path by extension: a module this gate parses, or a file that can carry no
 * import edge. An extension in neither set is a hard failure naming the file (ADR-0027 clause 3).
 */
function classifyTrackedFile(relative: string): 'module' | 'not-a-module' {
  const extension = path.posix.extname(relative).toLowerCase();
  if (MODULE_EXTENSIONS.has(extension)) return 'module';
  if (NON_MODULE_EXTENSIONS.has(extension)) return 'not-a-module';
  throw new Error(
    `${relative} has the extension "${extension}", which this gate neither parses as a module nor ` +
      'recognises as a file no import specifier can resolve to. Add it to MODULE_EXTENSIONS or to ' +
      'NON_MODULE_EXTENSIONS in this file; do not leave it unclassified.',
  );
}

/** One expression with the wrappers that do not change what it denotes taken off. */
function unwrapExpression(node: ts.Expression | undefined): ts.Expression | undefined {
  let current = node;
  for (;;) {
    if (current === undefined) return undefined;
    if (ts.isParenthesizedExpression(current)) current = current.expression;
    else if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.CommaToken
    ) {
      // `(0, require)` denotes the right operand. The idiom exists precisely to hand `require`
      // on with a different `this`, and it is the reason this unwrapping is here rather than a
      // callee name being added to a list: the callee IS `require`, spelled around a comma.
      current = current.right;
    } else if (
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
    } else return current;
  }
}

/** The identifier a callee is rooted at: `globalThis` in `globalThis.require`, `require` in `(0, require)`. */
function calleeRootName(callee: ts.Expression): string | null {
  let current: ts.Expression = callee;
  for (;;) {
    const unwrapped = unwrapExpression(current);
    if (unwrapped === undefined) return null;
    if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
      current = unwrapped.expression;
      continue;
    }
    return ts.isIdentifier(unwrapped) ? unwrapped.text : null;
  }
}

/** What one file binds, as much of it as a walk with no scope model can see. */
interface Bindings {
  /** Every name declared anywhere in the file: imports, variables, functions, classes, parameters. */
  readonly declared: ReadonlySet<string>;
  /** The declared names bound straight to another reference — `const load = require;`. */
  readonly aliased: ReadonlySet<string>;
  /** The declared names bound to a string literal, so an argument written as a name can be read. */
  readonly constants: ReadonlyMap<string, string>;
}

/**
 * Every identifier this file binds, and which of them are bound to another reference.
 *
 * The question this answers is not "what is in scope". It is the narrower one the call classifier
 * below asks: *can this gate see where the thing being called was made?* A callee rooted at a name
 * the file declares is a value this file produced. A callee rooted at a free name — `require` in a
 * CommonJS module, `globalThis`, `process`, `eval` — came from somewhere the walk cannot look. A
 * name bound straight to another reference is not vouched for either, which is what
 * `const load = require;` turns on.
 *
 * Scope is deliberately not modelled: a name declared anywhere in the file vouches for every use of
 * it. That errs towards *passing* a call, and it is stated here rather than left to be discovered.
 */
function bindingsIn(source: ts.SourceFile): Bindings {
  const declared = new Set<string>();
  const aliased = new Set<string>();
  const constants = new Map<string, string>();
  const declareName = (name: ts.Node | undefined): void => {
    if (name === undefined) return;
    if (ts.isIdentifier(name)) declared.add(name.text);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) declareName(element.name);
      }
    }
  };
  const walk = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      declareName(node.name);
      const initializer = unwrapExpression(node.initializer);
      if (initializer !== undefined && ts.isIdentifier(node.name)) {
        if (ts.isStringLiteralLike(initializer)) constants.set(node.name.text, initializer.text);
        else if (
          ts.isIdentifier(initializer) ||
          ts.isPropertyAccessExpression(initializer) ||
          ts.isElementAccessExpression(initializer)
        ) {
          aliased.add(node.name.text);
        }
      }
    } else if (ts.isParameter(node) || ts.isBindingElement(node)) declareName(node.name);
    else if (ts.isImportClause(node) || ts.isNamespaceImport(node) || ts.isImportSpecifier(node)) {
      declareName(node.name);
    } else if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node) ||
      ts.isImportEqualsDeclaration(node)
    ) {
      declareName(node.name);
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return { declared, aliased, constants };
}

/**
 * Every string this gate can read at one call site: literal arguments, names bound to a literal in
 * this file, and the elements of an array literal handed in — `Reflect.apply(fn, null, ['…'])` and
 * `fn(...['…'])` write the specifier out at the call site all the same.
 */
function stringsHandedTo(
  call: ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression,
  constants: ReadonlyMap<string, string>,
): readonly string[] {
  const found: string[] = [];
  const read = (node: ts.Expression | undefined): void => {
    const value = unwrapExpression(node);
    if (value === undefined) return;
    if (ts.isStringLiteralLike(value)) found.push(value.text);
    else if (ts.isIdentifier(value)) {
      const constant = constants.get(value.text);
      if (constant !== undefined) found.push(constant);
    } else if (ts.isArrayLiteralExpression(value)) {
      for (const element of value.elements) read(element);
    } else if (ts.isSpreadElement(value)) read(value.expression);
  };
  if (ts.isTaggedTemplateExpression(call)) {
    if (ts.isNoSubstitutionTemplateLiteral(call.template)) found.push(call.template.text);
    return found;
  }
  for (const argument of call.arguments ?? []) read(argument);
  return found;
}

/** One call site as written, collapsed onto a line, for a failure message to name it by. */
function snippet(node: ts.Node): string {
  const text = node.getText().replace(/\s+/gu, ' ').trim();
  return text.length > 72 ? `${text.slice(0, 69)}...` : text;
}

/**
 * A call site this gate reads no specifier out of, carried out of the walk so that the loop below
 * can give it a verdict rather than let it fall through (ADR-0031 clause 1).
 */
interface UnvouchedCall {
  /** The callee as written. */
  readonly construct: string;
  /** Every string handed to it that this gate could read. */
  readonly candidates: readonly string[];
}

/** What one file's parse yielded: the specifiers read out of it, and the calls left to decide. */
interface ReadModule {
  readonly specifiers: readonly string[];
  readonly unvouched: readonly UnvouchedCall[];
}

/**
 * The files decided to hold a dynamic import whose argument is computed, each with its reason. A
 * file listed here is read as having no edge from that call, because the module it names is
 * chosen by the developer at run time and is never the database layer: nothing in a developer's
 * project may name it (ADR-0015). Exact repository paths only, never a glob, and the last
 * assertion of this file pins the list to exactly these entries, so widening it is a reviewed
 * change to this file and to ADR-0115 (ADR-0027 clause 3, ADR-0031 clause 1).
 */
const COMPUTED_IMPORT_DECISIONS: ReadonlyMap<string, string> = new Map([
  [
    'packages/aw/src/tools/host-child.ts',
    "imports the developer's own run files by path; decided in ADR-0115",
  ],
]);

/**
 * Every module specifier in one file, read with the TypeScript parser, and every call site the
 * reader took no specifier out of.
 *
 * A file that produces a syntax error is a hard failure naming the file rather than a file
 * contributing no edges — a gate that treated "I could not read it" as "it is clean" would be the
 * exact shape ADR-0015 forbids.
 */
function specifiersIn(relative: string): ReadModule {
  const absolute = path.join(repoRoot, relative);
  const text = readFileSync(absolute, 'utf8');
  const extension = path.posix.extname(relative).toLowerCase();
  const kind =
    extension === '.tsx' || extension === '.jsx'
      ? ts.ScriptKind.TSX
      : extension === '.ts' || extension === '.mts' || extension === '.cts'
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS;
  const source = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true, kind);
  const diagnostics = (source as unknown as { parseDiagnostics?: readonly unknown[] })
    .parseDiagnostics;
  if (diagnostics !== undefined && diagnostics.length > 0) {
    throw new Error(
      `${relative} did not parse cleanly, so its imports could not be classified. This gate fails ` +
        'rather than treating an unreadable file as an empty one (ADR-0015).',
    );
  }

  const found: string[] = [];
  const literal = (node: ts.Node | undefined): void => {
    if (node !== undefined && ts.isStringLiteralLike(node)) found.push(node.text);
  };
  /**
   * The specifier of a dynamic import or a require. Unlike an import declaration's, it is an
   * arbitrary expression, and an expression this gate cannot read is not an absence of an edge.
   * In verification round 3 a route handler that put `'…/packages/core/src/db/client'` in a
   * `const` and awaited a dynamic import of that binding reached the layer while this function
   * pushed nothing, so the unreadable shape throws instead. (Said without the call syntax on
   * purpose, for the reason the header gives.)
   */
  const callArgument = (node: ts.CallExpression, kind: string): void => {
    const argument = node.arguments[0];
    if (argument !== undefined && ts.isStringLiteralLike(argument)) {
      found.push(argument.text);
      return;
    }
    // A decided exception (ADR-0115), for the one file and one kind it names; see below.
    if (kind === 'a dynamic import' && COMPUTED_IMPORT_DECISIONS.has(relative)) return;
    throw new Error(
      `${relative} calls ${kind} with an argument that is not a string literal, so this gate ` +
        'cannot tell which module it names. Write the specifier as a literal, or decide what a ' +
        'computed one means here; do not leave it unread.',
    );
  };
  const bindings = bindingsIn(source);
  const unvouched: UnvouchedCall[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) literal(node.moduleSpecifier);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      literal(node.argument.literal);
    } else if (
      ts.isCallExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isTaggedTemplateExpression(node)
    ) {
      // Every call site leaves this branch with a verdict; there is no path out of it that neither
      // collects a specifier nor records a decision (ADR-0031 clause 1). The first two arms read a
      // specifier. The last is the `else`, and it does not ask "is this callee a resolver" — no
      // list of callee names ever finishes answering that, which is the finding this arm exists to
      // close. It asks whether the call is handed a string that resolves *into the layer*, by a
      // callee this file cannot vouch for, and hands that question to `decideUnvouchedCall` below.
      const callee = ts.isTaggedTemplateExpression(node) ? node.tag : node.expression;
      if (ts.isCallExpression(node) && callee.kind === ts.SyntaxKind.ImportKeyword) {
        callArgument(node, 'a dynamic import');
      } else if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(callee) &&
        callee.text === 'require'
      ) {
        callArgument(node, 'require');
      } else {
        // A **construction** is never vouched for. A constructed `Worker` loads and runs a module,
        // and the vouching rule below — which asks only whether this file binds the callee's root
        // name — passes one whose `Worker` came out of a destructured `require`. Refusing every
        // construction handed a string that resolves into the layer costs exactly one call site in
        // this tree, measured: the `URL` built over `…/src/db/schema/runs.ts` in
        // `apps/web/server/runs/store.test.ts`, which now builds that path with the `path` module
        // it imports. That price is affordable, so the stricter arm is the one taken.
        const root = ts.isCallExpression(node) ? calleeRootName(callee) : null;
        const vouched = root !== null && bindings.declared.has(root) && !bindings.aliased.has(root);
        if (!vouched) {
          unvouched.push({
            construct: snippet(callee),
            candidates: stringsHandedTo(node, bindings.constants),
          });
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return { specifiers: found, unvouched };
}

/** The host `ts.getParsedCommandLineOfConfigFile` reads a `tsconfig.json` through. */
const parseConfigHost: ts.ParseConfigFileHost = {
  useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  readDirectory: (rootDir, extensions, excludes, includes, depth): readonly string[] =>
    ts.sys.readDirectory(rootDir, extensions, excludes, includes, depth),
  fileExists: (fileName): boolean => ts.sys.fileExists(fileName),
  readFile: (fileName): string | undefined => ts.sys.readFile(fileName),
  getCurrentDirectory: (): string => ts.sys.getCurrentDirectory(),
  onUnRecoverableConfigFileDiagnostic: (diagnostic): never => {
    throw new Error(
      'a tsconfig this gate needs could not be read: ' +
        ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
    );
  },
};

/**
 * One parsed TypeScript project: the options a specifier inside it resolves through, and the set of
 * files the project compiles.
 */
interface Project {
  /** Repository-relative path of the configuration file. */
  readonly configPath: string;
  readonly options: ts.CompilerOptions;
  readonly cache: ts.ModuleResolutionCache;
  /** Every file this project's *program* contains, repository-relative and resolved through links. */
  readonly files: ReadonlySet<string>;
}

/**
 * Parse one tracked configuration into a project, membership included.
 *
 * Parsed rather than read: `extends` chains — including a target whose extension is not `.json`,
 * which TypeScript loads verbatim when the file exists — `baseUrl`, `paths`, and the `files`,
 * `include` and `exclude` globs are all resolved by `getParsedCommandLineOfConfigFile`, which is
 * the same entry point `tsc` itself uses.
 *
 * Membership is the **program**, not `parsed.fileNames`. Those are the project's *root* names —
 * what its `files`/`include`/`exclude` globs list — and a `tsc -p` program is that set plus
 * everything the roots import, transitively, each of which resolves its own specifiers through this
 * project's options. Verification round 5 reached the layer through the difference: a file dropped
 * out of `apps/web`'s `include` was still in the program `tsc -p apps/web/tsconfig.json` builds and
 * still resolved `@/*` through `apps/web`'s `paths`, while a gate that read root names alone
 * handed the file to whichever nested configuration claimed it. `ts.createProgram` is the
 * compiler's own answer to "which programs contain this file", and it is the answer `tsc -p` and
 * `next build` act on.
 */
function parseProject(relative: string): Project {
  const configPath = path.join(repoRoot, relative);
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, parseConfigHost);
  if (parsed === undefined) {
    throw new Error(`${relative} did not parse, so this gate cannot resolve anything under it.`);
  }
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  return {
    configPath: relative,
    options: parsed.options,
    cache: ts.createModuleResolutionCache(
      path.dirname(configPath),
      (fileName) => (ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase()),
      parsed.options,
    ),
    files: new Set(program.getSourceFiles().map((file) => repoRelativeReal(file.fileName))),
  };
}

/** The repository's root configuration, whose options every other config in the tree extends. */
const ROOT_CONFIG = 'tsconfig.json';

/** Every tracked TypeScript configuration, found by shape rather than by a list. */
const trackedConfigs = trackedFiles().filter((file) => /(?:^|\/)tsconfig[^/]*\.json$/u.test(file));
if (!trackedConfigs.includes(ROOT_CONFIG)) {
  throw new Error(
    `${ROOT_CONFIG} is not tracked. This gate resolves a module that no project compiles under ` +
      'the repository root options, and cannot do that while there are none.',
  );
}
const allProjects = trackedConfigs.map(parseProject);

/** The projects that compile something. A configuration that compiles nothing claims no file. */
const compilingProjects = allProjects.filter((project) => project.files.size > 0);

const declaredRootProject = allProjects.find((project) => project.configPath === ROOT_CONFIG);
if (declaredRootProject === undefined) {
  throw new Error(`${ROOT_CONFIG} is tracked but produced no project, so this gate cannot run.`);
}
const rootProject: Project = declaredRootProject;

/** Is `configPath`'s directory at or above `relative`? */
const sitsAbove = (configPath: string, relative: string): boolean => {
  const directory = path.posix.dirname(configPath);
  return directory === '.' || relative.startsWith(`${directory}/`);
};

/**
 * The projects a module's specifiers are resolved under: **the union of three sets, never a choice
 * between them.**
 *
 *   * every project whose program contains the module — the compiler's own answer;
 *   * the repository root `tsconfig.json`, whose options every other config here extends, and which
 *     is also Node's own `moduleResolution`, Node being what loads a file no project compiles;
 *   * every tracked project whose configuration file sits at or above the module, because a bundler
 *     that reaches such a file still resolves through the `paths` declared above it.
 *
 * The last two are this gate's choice rather than the compiler's answer. Taking the union rather
 * than preferring one set is the correction round 5 forced: the earlier version returned the owning
 * projects *exclusively* whenever there were any, so a nested `tsconfig.json` that claimed a file
 * `apps/web`'s `exclude` had just dropped became the only project consulted, and `apps/web`'s
 * `paths` — which `tsc -p` and `next build` still used on that same file — were discarded. Adding a
 * configuration file to the tree adds projects and removes none, so with the union no configuration
 * file can subtract a context.
 */
function contextsFor(relative: string): readonly Project[] {
  const owners = compilingProjects.filter((project) => project.files.has(relative));
  const above = allProjects.filter(
    (project) => project !== rootProject && sitsAbove(project.configPath, relative),
  );
  return [...new Set<Project>([...owners, rootProject, ...above])];
}

/**
 * Every file one specifier resolves to — one answer per project that compiles the importing file,
 * deduplicated, as real repository-relative paths.
 *
 * The compiler is asked once per context, and the filesystem once more:
 *
 *   * a path naming a file the compiler has no type for — `import './globals.css'` — is loaded by a
 *     bundler at exactly the path the specifier spells, so that path, joined onto the importing
 *     file's directory, is added to the answer whenever it exists and is a file. It is *added*
 *     rather than used only when every context declines, so that this function is monotone in its
 *     contexts: one more context can only add a resolution, never replace one. That is the property
 *     the union in `contextsFor` is for, and consulting the filesystem as an alternative would have
 *     left one way for a context to take an answer away.
 *   * a Node built-in, which `isBuiltin` recognises and which names no file anywhere;
 *   * a path naming nothing, which is a hard failure (ADR-0015): a reference this gate cannot
 *     decide is one it must refuse.
 *
 * A *bare* specifier every context declines is a package none of them can find from that file. The
 * layer is not reachable through it: both roots of the layer are asserted above to exist on disk,
 * so a specifier that named a file under one of them would have resolved.
 */
function resolvedFiles(from: string, specifier: string): readonly string[] {
  const absolute = path.join(repoRoot, from);
  const contexts = contextsFor(from);
  const files = new Set<string>();
  for (const context of contexts) {
    const resolved = ts.resolveModuleName(
      specifier,
      absolute,
      context.options,
      ts.sys,
      context.cache,
    );
    if (resolved.resolvedModule !== undefined) {
      files.add(repoRelativeReal(resolved.resolvedModule.resolvedFileName));
    }
  }
  const onDisk = specifier.startsWith('.') || path.isAbsolute(specifier);
  if (onDisk) {
    const asWritten = path.resolve(path.dirname(absolute), specifier);
    if (existsSync(asWritten) && statSync(asWritten).isFile()) {
      files.add(repoRelativeReal(asWritten));
    }
  }
  if (files.size > 0) return [...files];
  if (isBuiltin(specifier)) return [];
  if (onDisk) {
    throw new Error(
      `${from} imports "${specifier}", a path that TypeScript (through ` +
        `${contexts.map((context) => context.configPath).join(', ')}) cannot resolve and that ` +
        'names no file on disk. This gate decides where a reference points by resolving it, so a ' +
        'path it cannot resolve is a reference it cannot decide (ADR-0015).',
    );
  }
  return [];
}

/**
 * The file inside the layer one readable string at a call site names, or `null`.
 *
 * The same two questions `resolvedFiles` asks — the compiler once per context, then the filesystem
 * — with neither of its two failures: a string handed to an arbitrary call is not known to be a
 * specifier, so a string that resolves to nothing is not a reference this gate could not decide,
 * it is a string.
 */
function layerFileNamedBy(from: string, candidate: string): string | null {
  const absolute = path.join(repoRoot, from);
  for (const context of contextsFor(from)) {
    const resolved = ts.resolveModuleName(
      candidate,
      absolute,
      context.options,
      ts.sys,
      context.cache,
    );
    const file = resolved.resolvedModule?.resolvedFileName;
    if (file !== undefined) {
      const relative = repoRelativeReal(file);
      if (insideLayer(relative)) return relative;
    }
  }
  if (candidate.startsWith('.') || path.isAbsolute(candidate)) {
    const asWritten = path.resolve(path.dirname(absolute), candidate);
    if (existsSync(asWritten) && statSync(asWritten).isFile()) {
      const relative = repoRelativeReal(asWritten);
      if (insideLayer(relative)) return relative;
    }
  }
  return null;
}

/**
 * The verdict for a call site the specifier reader took nothing out of (ADR-0031 clause 1).
 *
 * Two outcomes, both decisions:
 *
 *   * a string this gate can read at the call site resolves to a file inside the database layer, and
 *     the callee is not one this file binds — **refused**, naming the file, the callee and the file
 *     the string lands in. It is refused without deciding whether the call loads anything, because
 *     the gate cannot show that it does not;
 *   * no string it can read there lands in the layer — **decided**: at this call site, nothing names
 *     the layer.
 *
 * The second outcome is where this gate stops, and the header says so in the same words: a
 * specifier that arrives through a parameter, through a computation, or inside the source text
 * `eval` is handed is not a string read here, so a call built that way takes the second arm. That
 * is a limit, not completeness, and it is written down rather than implied.
 */
function decideUnvouchedCall(from: string, call: UnvouchedCall): void {
  for (const candidate of call.candidates) {
    const target = layerFileNamedBy(from, candidate);
    if (target === null) continue;
    throw new Error(
      `${from} hands ${JSON.stringify(candidate)} to \`${call.construct}\`, and that string ` +
        `resolves to ${target}, inside the database layer. This gate cannot show the call is not ` +
        'a module load: its callee is neither a construct this gate reads a specifier from nor a ' +
        'name this file binds. Refused rather than passed over (ADR-0031 clause 1). Obtain the ' +
        `layer through ${PACKAGE}/db, or bind the callee in this file so that a reader can see ` +
        'what is being called.',
    );
  }
}

/**
 * Classify one specifier: which files inside the database layer does it reach, and how?
 *
 * An empty list means "this specifier resolves to no file inside the layer under any project that
 * compiles the importing file" — a `node:fs`, a sibling module, a third-party package. Every
 * specifier that names this package's `./db…` surface is either resolved through the manifest or
 * thrown on; there is no arm in which an unrecognised `@agent-workspace/core/db…` specifier is
 * quietly ignored. One specifier can yield more than one edge, because two projects that both
 * compile the importing file can place it in two different files, and each answer is classified.
 */
function edgesFor(from: string, specifier: string): readonly Edge[] {
  if (specifier === `${PACKAGE}/db` || specifier.startsWith(`${PACKAGE}/db/`)) {
    const subpath = `.${specifier.slice(PACKAGE.length)}`;
    // The explicit else. An import of a subpath the manifest does not declare would fail to
    // resolve at build time, but it must fail HERE too, naming the file, rather than leaving this
    // gate to report "no database edges" about a file that is full of them.
    if (!databaseSubpaths.has(subpath)) {
      throw new Error(
        `${from} imports "${specifier}", which ${MANIFEST} does not declare. Declared database ` +
          `subpaths: ${[...databaseSubpaths].sort().join(', ')}.`,
      );
    }
    const files = resolvedFiles(from, specifier);
    if (files.length === 0) {
      throw new Error(
        `${from} imports the declared subpath "${specifier}", and the compiler could not place ` +
          'it. This gate reports the file a specifier resolves to, and cannot report one it does ' +
          'not have.',
      );
    }
    return files.map((file) => ({ from, specifier, subpath, target: file, via: 'subpath' }));
  }

  return resolvedFiles(from, specifier)
    .filter((file) => insideLayer(file))
    .map((file) => ({ from, specifier, subpath: null, target: file, via: 'path' }));
}

const modules: string[] = [];
const data: string[] = [];
for (const file of trackedFiles()) {
  if (classifyTrackedFile(file) === 'module') modules.push(file);
  else data.push(file);
}

const edges: Edge[] = [];
for (const file of modules) {
  const read = specifiersIn(file);
  for (const specifier of read.specifiers) {
    edges.push(...edgesFor(file, specifier));
  }
  // The other half of the walk's verdict. A call site the reader took no specifier out of is
  // decided here rather than left behind it (ADR-0031 clause 1).
  for (const call of read.unvouched) decideUnvouchedCall(file, call);
}

/** An importer that lives inside the database layer may reach any part of it. */
const insideDatabaseLayer = (from: string): boolean => insideLayer(from);
/** An importer inside the owning package is on the same side of the module boundary. */
const insideOwningPackage = (from: string): boolean => from.startsWith(OWNING_PACKAGE);
/** The shape rule for an escape's admitted importer: a Vitest suite, by filename. */
const isSuite = (from: string): boolean => /\.test\.tsx?$/u.test(from);

interface Verdict {
  readonly edge: Edge;
  readonly permitted: boolean;
  readonly rule: string;
}

/**
 * The permission classifier. Five arms, the last of which rejects.
 *
 * Order matters only for readability; the arms are disjoint by construction because the first
 * tests the importer's location, the second the importer's package and the target's root, the
 * third the public subpath, the fourth the escape subpaths, and the fifth is everything else.
 */
function decide(edge: Edge): Verdict {
  if (insideDatabaseLayer(edge.from)) {
    return { edge, permitted: true, rule: 'the database layer may reach its own modules' };
  }
  if (insideOwningPackage(edge.from) && edge.via === 'path' && underRoot(edge.target, sourceRoot)) {
    return {
      edge,
      permitted: true,
      rule: "a path into the layer's source from inside the package that owns it",
    };
  }
  if (edge.via === 'subpath' && edge.subpath === './db') {
    return { edge, permitted: true, rule: 'the public surface, through the package export' };
  }
  if (edge.via === 'subpath' && edge.subpath !== null && escapeSubpaths.has(edge.subpath)) {
    if (isSuite(edge.from)) {
      return { edge, permitted: true, rule: 'a declared escape, imported by a test suite' };
    }
    return {
      edge,
      permitted: false,
      rule: 'a declared escape imported by something that is not a *.test.ts suite',
    };
  }
  const spelling = edge.via === 'path' ? 'a specifier resolving to' : 'a package subpath naming';
  const half = !underRoot(edge.target, sourceRoot)
    ? "the layer's BUILD OUTPUT, which skips both the export map and the source tree this gate reads"
    : 'the database layer from outside it, which skips the package export map entirely';
  return { edge, permitted: false, rule: `${spelling} ${half}` };
}

const verdicts = edges.map(decide);

const describeSet = (rows: readonly Verdict[]): string =>
  rows
    .map((row) => `  ${row.edge.from} → ${row.edge.specifier} (${row.edge.target})   [${row.rule}]`)
    .join('\n');

describe('nothing outside the database layer reaches past its public barrel', () => {
  it('holds exactly one decided computed dynamic import: the one ADR-0115 names', () => {
    expect([...COMPUTED_IMPORT_DECISIONS.keys()]).toEqual(['packages/aw/src/tools/host-child.ts']);
  });

  it('classified every tracked path, and parsed a non-empty set of modules', () => {
    // ADR-0015: a check that cannot run must fail. `classifyTrackedFile` has already thrown on
    // anything it could not place, so what is left to assert is that the listing was not empty and
    // that both halves of the classification are populated — a `git ls-files` that returned
    // nothing, or an extension rule that placed every file in `data`, would satisfy every
    // assertion below while proving nothing.
    expect(modules.length, '`git ls-files` yielded no module to parse').toBeGreaterThan(0);
    expect(
      data.length,
      '`git ls-files` yielded no non-module file, which cannot be true of this ' +
        'repository and means the extension classifier is mis-reading paths',
    ).toBeGreaterThan(0);
  });

  it('derived a non-empty set of import edges from the tracked tree', () => {
    expect(
      edges.length,
      'no import edge into the database layer was found in the tracked tree. Either the ' +
        'specifier reader is broken or `git ls-files` returned nothing; either way this gate ' +
        'proved nothing.',
    ).toBeGreaterThan(0);
  });

  it('found the public surface actually being imported from outside the database layer', () => {
    const publicEdges = verdicts.filter(
      (row) => row.permitted && row.edge.subpath === './db' && !insideOwningPackage(row.edge.from),
    );
    expect(
      publicEdges.length,
      `no file outside ${OWNING_PACKAGE} imports the public barrel. The derived set was:\n${describeSet(verdicts)}`,
    ).toBeGreaterThan(0);
  });

  it('found every declared escape being imported by a suite, so no subpath is declared unused', () => {
    for (const subpath of escapeSubpaths) {
      const importers = verdicts.filter(
        (row) => row.edge.subpath === subpath && isSuite(row.edge.from),
      );
      expect(
        importers.length,
        `${MANIFEST} declares the escape subpath "${subpath}", and no *.test.ts imports it. An ` +
          'escape nothing uses should be deleted from the manifest, not left for the next author ' +
          `to find. The derived set was:\n${describeSet(verdicts)}`,
      ).toBeGreaterThan(0);
    }
  });

  it('admits no edge that skips the public barrel', () => {
    const refused = verdicts.filter((row) => !row.permitted);
    expect(
      refused.map((row) => `${row.edge.from} → ${row.edge.specifier}   [${row.rule}]`),
      'These files reach into the database layer without going through ' +
        `${PACKAGE}/db. Application code obtains a database through openDatabaseRoot(); ` +
        'a suite that must build a fixture imports a declared escape subpath. The whole derived ' +
        `set, permitted and refused:\n${describeSet(verdicts)}`,
    ).toEqual([]);
  });
});

/**
 * **No export subpath is a second name for the database layer.**
 *
 * The manifest classifier at the top of this file rejects an export key whose own target lands
 * inside the layer. Verification round 4 walked past it with one more hop: a `./persistence` key
 * pointing at `packages/core/src/persistence.ts`, a module outside the layer whose whole body is
 * `export { createDatabase, createPool, readDatabaseConfig } from './db/client.js'`. Its target is
 * outside the layer, so the key was classified as no business of this gate, and a route handler
 * imported `@agent-workspace/core/persistence` with every gate in the repository green.
 *
 * So the question this block asks is about the **names** an export puts on the public surface, not
 * about where the file that carries them sits. It builds `packages/core`'s program, reads each
 * declared subpath's exported symbols with the type checker, follows every alias to the
 * declaration it ultimately names, and fails on a name that is declared inside the layer and that
 * the public `./db` subpath does not also expose. Following the alias chain is the point: a
 * re-export is an alias, and so is a re-export of a re-export.
 *
 * ## Every condition, not the `types` one
 *
 * Round 5 split the two. A `./persistence` key whose `types` condition was a hand-written
 * `declare` stub and whose `default` condition was a compiled module re-exporting the layer put
 * `createDatabase`, `createPool`, `readDatabaseConfig` and `agents` on the surface a consumer that
 * resolves through `default` loads, while this block — which read `types` alone — saw four names
 * declared in the stub and nothing inside the layer. `tsc` reads `types` and Node reads `default`,
 * and reading one of them is a model of what the consumer resolves rather than the thing itself. So
 * the program
 * this block builds has **every declared condition of every declared subpath** among its root
 * files, and a subpath's surface is the union of what each of its conditions exposes. A condition
 * naming a file that is not on disk is a hard failure naming the key and the condition (ADR-0015).
 */
describe('no export subpath is a second door into the database layer', () => {
  it('exposes no layer-declared name that the public subpath does not', () => {
    const configPath = path.join(repoRoot, OWNING_PACKAGE, 'tsconfig.json');
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, parseConfigHost);
    if (parsed === undefined) {
      throw new Error(`${OWNING_PACKAGE}tsconfig.json did not parse, so this gate cannot run.`);
    }
    // `include: ["src"]` is what that project compiles, so a `default` condition pointing into
    // `dist/` is not in it. Each condition's own file is added as a root, and `allowJs` is turned
    // on for the compiled halves, so the checker can be asked about the module a consumer loads.
    const conditionRoots = allTargets.map((row) => {
      const absolute = path.join(repoRoot, row.target);
      if (!existsSync(absolute)) {
        throw new Error(
          `${MANIFEST} exports "${row.subpath}" with "${row.condition}": "${row.target}", which ` +
            'is not on disk. This gate reads the names every condition of every subpath exposes ' +
            `and cannot read them out of a file that is absent. Run \`pnpm --filter ${PACKAGE} ` +
            'run build` before `pnpm test`; CI does this in a step of its own.',
        );
      }
      return absolute;
    });
    const program = ts.createProgram({
      rootNames: [...parsed.fileNames, ...conditionRoots],
      options: { ...parsed.options, allowJs: true, checkJs: false, noEmit: true },
    });
    const checker = program.getTypeChecker();
    const byRelative = new Map<string, ts.SourceFile>();
    for (const file of program.getSourceFiles()) {
      byRelative.set(repoRelativeReal(file.fileName), file);
    }

    /** Follow a re-export chain to the symbol it ultimately names. */
    const declared = (symbol: ts.Symbol): ts.Symbol => {
      let current = symbol;
      const seen = new Set<ts.Symbol>();
      while ((current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
        seen.add(current);
        const next = checker.getAliasedSymbol(current);
        if (next === current) break;
        current = next;
      }
      return current;
    };

    /** Every name one *condition* exposes, with the files those names are declared in. */
    const surfaceOfCondition = (row: DeclaredTarget): ReadonlyMap<string, readonly string[]> => {
      const file = byRelative.get(repoRelativeReal(path.join(repoRoot, row.target)));
      if (file === undefined) {
        throw new Error(
          `${row.target} — the "${row.condition}" condition of "${row.subpath}" — is not in the ` +
            'program this gate built, so it cannot read the names that condition exposes.',
        );
      }
      const moduleSymbol = checker.getSymbolAtLocation(file);
      if (moduleSymbol === undefined) {
        throw new Error(
          `${row.target} — the "${row.condition}" condition of "${row.subpath}" — has no module ` +
            'symbol, so the compiler does not see it as a module and this gate cannot read the ' +
            'names it exposes.',
        );
      }
      const surface = new Map<string, readonly string[]>();
      for (const exported of checker.getExportsOfModule(moduleSymbol)) {
        const files = (declared(exported).declarations ?? []).map((declaration) =>
          repoRelativeReal(declaration.getSourceFile().fileName),
        );
        surface.set(exported.name, [...new Set(files)]);
      }
      return surface;
    };

    /**
     * Every name one declared subpath exposes, over **every** condition the manifest gives it,
     * with the files those names are declared in. A caller resolves through exactly one condition
     * and this gate does not get to choose which, so the surface is the union.
     */
    const surfaceOf = (subpath: string): ReadonlyMap<string, readonly string[]> => {
      const rows = allTargets.filter((one) => one.subpath === subpath);
      if (rows.length === 0) {
        throw new Error(
          `${MANIFEST} declares "${subpath}" with no condition at all, so this gate cannot read ` +
            'the names it exposes.',
        );
      }
      const surface = new Map<string, readonly string[]>();
      for (const row of rows) {
        for (const [name, files] of surfaceOfCondition(row)) {
          surface.set(name, [...new Set([...(surface.get(name) ?? []), ...files])]);
        }
      }
      return surface;
    };

    const publicSubpath = [...publicSubpaths][0] ?? './db';
    const publicNames = new Set(surfaceOf(publicSubpath).keys());
    expect(
      publicNames.size,
      `${publicSubpath} exposes no name at all, so every comparison below would be vacuous.`,
    ).toBeGreaterThan(0);

    const examined: string[] = [];
    const doors: string[] = [];
    for (const subpath of new Set(allTargets.map((row) => row.subpath))) {
      // The layer's own declared entry points are what the rest of this file classifies; this
      // block is about every OTHER name the package publishes.
      if (databaseSubpaths.has(subpath)) continue;
      examined.push(subpath);
      for (const [name, declarations] of surfaceOf(subpath)) {
        const inside = declarations.filter((file) => insideLayer(file));
        if (inside.length === 0 || publicNames.has(name)) continue;
        doors.push(`${subpath} exposes "${name}", declared in ${inside.join(', ')}`);
      }
    }

    expect(
      examined.length,
      `${MANIFEST} declares no export key outside the database subpaths, so this block examined ` +
        'nothing and proved nothing.',
    ).toBeGreaterThan(0);
    expect(
      doors,
      `${MANIFEST} publishes these names, declared inside the database layer, under an export ` +
        `key that is not a database subpath and that ${publicSubpath} does not expose. Each one ` +
        'is a second door into the layer: a caller reaches it without naming the layer, and the ' +
        'edge classifier above never sees the specifier. Examined: ' +
        `${examined.join(', ')}.`,
    ).toEqual([]);
  }, 15_000);
});

/**
 * **The public barrel re-exports from the repository layer and from nothing else.**
 *
 * Verification round 2 found `runSeed` on `@agent-workspace/core/db`. It is not a handle and it is
 * not a table, so neither the surface fixture in `scope-forgery.test.ts` nor the edge gate above
 * objected — and it takes a caller-supplied workspace slug and email and writes an `owner`
 * membership row into whatever workspace that slug already names. A prose sentence saying "the
 * barrel exports only repositories" is the thing that was there and that was false, so this is the
 * shape rule instead: the barrel's export statements are parsed, and the one module they may name
 * is derived from the manifest rather than written here.
 */
describe('the public barrel re-exports the repository layer and nothing else', () => {
  /** The source barrel, from the manifest's own `types` condition for `./db`. */
  const barrel = publicTargets.find((row) => row.condition === 'types')?.target;

  /** The repository layer's index, as the barrel must spell it: sibling-relative, with `.js`. */
  const repositoryIndex = './repositories/index.js';

  it('names the repository index in every export statement it has, and at least one', () => {
    expect(barrel, `${MANIFEST} declares no "types" condition for "./db"`).toBeDefined();
    const absolute = path.join(repoRoot, barrel ?? '');
    const source = ts.createSourceFile(
      absolute,
      readFileSync(absolute, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    /**
     * Every top-level statement is classified, because `export { … } from '…'` is only one of the
     * ways a name reaches this module's surface. `export const db = createDatabase(pool)` is a
     * `VariableStatement` carrying an export modifier, not an `ExportDeclaration`, and a rule that
     * looked only at export declarations would not see it at all — which is ADR-0027 clause 3
     * inside the gate written for ADR-0027.
     */
    const carriesExportModifier = (statement: ts.Statement): boolean =>
      ts.canHaveModifiers(statement) &&
      (ts.getModifiers(statement) ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      );

    const specifiers: string[] = [];
    for (const statement of source.statements) {
      if (ts.isExportDeclaration(statement)) {
        const moduleSpecifier = statement.moduleSpecifier;
        // A bare `export { … }` with no `from` re-exports a local binding, which in a barrel that
        // declares nothing of its own cannot happen — and if it ever does, this gate says so
        // rather than skipping the statement.
        if (moduleSpecifier === undefined || !ts.isStringLiteralLike(moduleSpecifier)) {
          throw new Error(
            `${barrel ?? ''} has an export statement with no module specifier. This gate ` +
              'classifies re-exports and cannot classify that one.',
          );
        }
        specifiers.push(moduleSpecifier.text);
      } else if (ts.isExportAssignment(statement) || carriesExportModifier(statement)) {
        // The arm that would otherwise have been silence. A declaration made here and exported
        // from here is a name on the public surface that no re-export names, so it would pass the
        // specifier check below without ever being looked at.
        throw new Error(
          `${barrel ?? ''} declares an export of its own: ${
            statement.getText(source).split('\n')[0] ?? ''
          } — this barrel re-exports ./repositories/index.js and declares nothing. Put the ` +
            'declaration in the repository layer, where scope-forgery.test.ts compiles against it.',
        );
      } else {
        // An import, or any other statement that puts no name on this module's surface.
      }
    }

    expect(
      specifiers.length,
      `${barrel ?? ''} has no export statement at all, so this gate would pass over an empty ` +
        'surface (ADR-0015).',
    ).toBeGreaterThan(0);
    expect(
      specifiers.filter((specifier) => specifier !== repositoryIndex),
      `${barrel ?? ''} re-exports from a module other than ${repositoryIndex}. The public ` +
        "surface is the repository layer's surface: `./client.js`, `./schema/index.js`, " +
        '`./seed.js` and `./migrate.js` each hand a caller something that reaches PostgreSQL ' +
        'without a WorkspaceScope. If a new export genuinely belongs on the public surface, ' +
        're-export it from ./repositories/index.js, where scope-forgery.test.ts will see it.',
    ).toEqual([]);
  });
});

describe('the declared escape refuses to load outside a test process', () => {
  it('calls its guard as a top-level statement, so the refusal runs at import', () => {
    // Structural, and derived by parsing rather than by grepping: the guard is only a control if
    // it is invoked at module scope. A function that is exported and never called is the defect
    // verification round 1 found in `WorkspaceScope.isWorkspaceScope`, and it is not repeated here
    // by asserting it in prose.
    //
    // Every declared escape, not the first one. Verification round 3 declared a second escape
    // subpath re-exporting the raw handle and every table with no guard call at all, and this
    // block read `[...escapeSubpaths][0]` and passed.
    expect(
      escapeSubpaths.size,
      'no escape subpath is declared, so there is no guard to check',
    ).toBeGreaterThan(0);
    for (const escape of escapeSubpaths) {
      const relative = allTargets.find(
        (row) => row.subpath === escape && row.condition === 'types',
      )?.target;
      expect(
        relative,
        `${MANIFEST} declares "${escape}" with no "types" condition, so this gate cannot find ` +
          'its source.',
      ).toBeDefined();
      const absolute = path.join(repoRoot, relative ?? '');
      const source = ts.createSourceFile(
        absolute,
        readFileSync(absolute, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const topLevelCalls = source.statements
        .filter(ts.isExpressionStatement)
        .map((statement) => statement.expression)
        .filter(ts.isCallExpression)
        .filter((call) => ts.isIdentifier(call.expression))
        .map((call) => (call.expression as ts.Identifier).text);
      expect(
        topLevelCalls,
        `${relative ?? ''} declares a guard but does not call it at module scope, so importing it ` +
          'would refuse nothing.',
      ).toContain('assertTestProcess');
    }
  });

  it('throws when the process has not identified itself as a test runner', async () => {
    const { assertTestProcess } = await import('./unscoped.js');
    const before = { vitest: process.env['VITEST'], node: process.env['NODE_ENV'] };
    try {
      delete process.env['VITEST'];
      process.env['NODE_ENV'] = 'production';
      expect(() => {
        assertTestProcess();
      }).toThrow(/loadable\s+only from a test process/u);

      process.env['NODE_ENV'] = 'development';
      expect(() => {
        assertTestProcess();
      }).toThrow(/@agent-workspace\/core\/db\/unscoped/u);

      // The positive arm, so the guard is not passing by refusing everything.
      process.env['VITEST'] = 'true';
      expect(() => {
        assertTestProcess();
      }).not.toThrow();
      delete process.env['VITEST'];
      process.env['NODE_ENV'] = 'test';
      expect(() => {
        assertTestProcess();
      }).not.toThrow();
    } finally {
      if (before.vitest === undefined) delete process.env['VITEST'];
      else process.env['VITEST'] = before.vitest;
      if (before.node === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = before.node;
    }
  });
});
