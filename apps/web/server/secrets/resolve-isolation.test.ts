/**
 * Nothing reachable from a secrets route may **transitively** reach `@agent-workspace/core/secrets`
 * as a value, through any chain of hops, except the files that must in order to keep everything
 * else from being able to.
 *
 * ## Why this replaced a text scan (verification round 2, F1/F2), and why round 2's version was
 * still wrong (verification round 3, B1/B2)
 *
 * The first version of this gate decided reachability with `text.includes('resolveByName')`. A
 * planted route that built the identifier at runtime and imported `createSecretsService` directly
 * through the `./secrets` package subpath returned a real decrypted value over HTTP while that text
 * scan stayed green — ADR-0030: *an import edge is resolved by the compiler, not matched by regex.*
 *
 * Round 2's fix asked the compiler, but only about each file's **own direct** edges. That is a
 * one-hop check, and one hop through a file its own allow-list permits defeats it: a route
 * importing `createSecretsService` re-exported from `memory-store.ts` (allow-listed because it must
 * hold a real value edge for tests) got a live, decrypting `SecretsService`, with the one-hop gate,
 * `tsc` and `eslint` all green. The same shape works through any `*.test.ts` file in these
 * directories, and through a file entirely **outside** them that itself imports the package. Round
 * 2's own claim — "no file in these two directories can construct or import a live secrets service
 * on its own" — was false the moment a second hop existed to make it true through.
 *
 * So this version walks the resolved import graph **transitively**: from every route and server
 * file (the roots), it follows each **value** edge (never a `type`-only one — that is erased before
 * anything runs and can call nothing) to whatever file it names, and keeps following from there,
 * until the chain either lands inside `packages/core/src/secrets/**` (a violation, unless the
 * *root* itself is on the allow-list) or leaves the set of files this gate can usefully keep
 * following (a third-party package under `node_modules`, at which point the chain is not pursued
 * further — see the ADR-0031 section below for what that costs). A hop through `memory-store.ts`, a
 * `*.test.ts` file, or a file outside these two directories is *followed*, not treated as a wall,
 * because none of those files being individually permitted to hold the edge says anything about
 * whether the **root** that reached them through it should be allowed to.
 *
 * ## What this does NOT decide (ADR-0031 — an undecidable case is declared refused, not implied closed)
 *
 * * **A specifier this reader cannot read as a literal is a hard failure naming the file**, never a
 *   skip — a dynamic `import()` or `require()` call (including one reached through an identifier
 *   this file bound to `require` or to `createRequire(...)`'s result — verification round 3's B2)
 *   whose argument is not a plain string literal could name anything at run time, and this reader
 *   does not attempt the fuller "vouched for" analysis
 *   `packages/core/src/db/repositories/database-reachability.test.ts` uses for that case. That is a
 *   narrower gate than that one, stated as a limit rather than implied to be its equal. Also read
 *   as edges: `import x = require('…')`, `X.require('…')` for any `X` (`module.require`,
 *   `globalThis.require`), `require.resolve('…')`, and a `createRequire` imported under another
 *   name or called as `X.createRequire(...)`. An unrecognised alias of `require` this reader does
 *   not know to look for — one bound through a destructuring pattern, or through a property read
 *   off an object rather than a call (`const x = module.require`) — is not detected and not
 *   refused; this is this gate's own residual limit on top of the one above, named rather than
 *   implied away.
 * * **A property access on a value already in hand is invisible to this gate.** It answers "does
 *   this file's own import statements, followed transitively, reach the package", not "does this
 *   file call a method on an object some other file handed it at run time." `store.ts`'s
 *   `RepositorySecretsStoreDependencies.service` parameter is typed `CoreSecretsService` — which
 *   does carry `resolveByName` — and nothing here stops a future edit of `store.ts` from calling
 *   `dependencies.service.resolveByName(...)` directly. What this gate proves is narrower and still
 *   real: no file in these two directories can *import its way to* a live secrets service, through
 *   any chain of its own `import`/`export`/`require` statements.
 * * **A chain is not followed past a file under `node_modules`, once real paths are compared.**
 *   Third-party packages are not part of this repository's own source, their own dependency trees
 *   are large, and none of the frozen attacks this gate is built against require following one.
 *   Every resolved path is put through `realpathSync` before it is classified — see "Verification
 *   round 4, B1" below for why a repo-relative prefix comparison over an *un*-realpathed path was
 *   wrong, not merely incomplete: the pnpm workspace symlink for `@agent-workspace/core`
 *   (`apps/web/node_modules/@agent-workspace/core`) is a real, on-disk symlink, and
 *   `ts.resolveModuleName` does **not** collapse it for a specifier spelled as a relative path
 *   *through* `node_modules` rather than through the package's own name — only `realpathSync`
 *   does. A value edge that reaches the secrets package only via a genuine third-party package's
 *   own internals is still not something this gate attempts to decide.
 * * **Files outside these two directories are not treated as *roots*.** They are followed as
 *   *intermediate hops* when a root's chain passes through them (closing the laundering route that
 *   motivated this rewrite), but a sibling task's own route, declared and reachable only from
 *   outside `apps/web/app/api/secrets/**` / `apps/web/server/secrets/**`, is never itself checked.
 *   See `no-plaintext-leak.test.ts`'s header for the narrower, resource-scoped trip-wire this task
 *   can honestly maintain for that case, and for what even that trip-wire cannot see.
 *
 * ## Verification round 4, B1 — a repo-relative prefix test is the same mistake as text-matching, one layer down
 *
 * Round 3's classifier compared `path.relative(REPO_ROOT, resolvedFileName)` against the package's
 * roots as plain strings. A specifier spelled as a relative path *through* the pnpm workspace
 * symlink — `../../../node_modules/@agent-workspace/core/src/secrets/index.js`, planted in the real
 * declared route — resolves, via `ts.resolveModuleName`, to
 * `apps/web/node_modules/@agent-workspace/core/src/secrets/index.ts`: a real file that **is** this
 * package (the symlink's target is `packages/core`), spelled under a path this gate's un-realpathed
 * prefix test does not recognise. `insideSecretsPackage` said no; `isExternal` then matched
 * `node_modules` in that same unresolved path and silently stopped following the chain — refusal
 * was not the `else`. A route importing `createSecretsService` that way got a live, decrypting
 * service, with this gate, `tsc`, `eslint` and `prettier` all clean.
 *
 * ADR-0030's rule is not only about specifiers matched as regex text; comparing an un-normalised
 * *path* against a literal prefix is the identical mistake at the filesystem layer, which is why
 * `packages/core/src/db/repositories/database-reachability.test.ts` realpaths every resolved path
 * — and every root it compares against — before classifying anything, and why this gate now does
 * the same: {@link toRealRepoRelative} runs every resolved file (and the package's own roots)
 * through `realpathSync` first, so the comparison is between two real paths on disk regardless of
 * which of the several equivalent ways a specifier reached the same file. A path this gate cannot
 * realpath (the file named does not really exist) is a hard failure naming it, not a silent
 * non-match — the `else` ADR-0031 asks for.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const posix = (value: string): string => value.split(path.sep).join('/');

/**
 * `REPO_ROOT` itself, resolved through any symlink above it, so that every path this gate compares
 * has been through the same normalisation — comparing an un-realpathed path against a realpathed
 * one would just move the class of bug B1 found rather than close it.
 */
const REAL_REPO_ROOT = realpathSync(REPO_ROOT);

/**
 * One absolute path, resolved through `realpathSync`, as a repository-relative posix path. Throws
 * — rather than falling back to the un-resolved path — when the path cannot be realpathed at all:
 * a path this gate cannot verify really exists is a path it cannot classify, and ADR-0031 requires
 * the `else` here to refuse rather than to guess (`insideSecretsPackage`/`isExternal` would
 * otherwise be comparing a value neither one actually named).
 *
 * This is the fix for verification round 4's B1: `ts.resolveModuleName` does not collapse the pnpm
 * workspace symlink for `@agent-workspace/core` when a specifier reaches it as a relative path
 * *through* `node_modules` rather than through the package's own name, so a prefix comparison over
 * the un-realpathed path is the same mistake ADR-0030 names for specifier text, one layer down —
 * see this file's header.
 */
const realRepoRelativeCache = new Map<string, string>();
function toRealRepoRelative(absolute: string): string {
  const cached = realRepoRelativeCache.get(absolute);
  if (cached !== undefined) return cached;
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch (error) {
    throw new Error(
      `${posix(path.relative(REAL_REPO_ROOT, absolute))} could not be resolved to a real path, ` +
        'so this gate cannot tell whether it is inside the secrets package or outside it. ' +
        'Refused rather than guessed (ADR-0031).',
      { cause: error },
    );
  }
  const repoRelative = posix(path.relative(REAL_REPO_ROOT, real));
  realRepoRelativeCache.set(absolute, repoRelative);
  return repoRelative;
}

function trackedFilesUnder(...prefixes: string[]): string[] {
  const stdout = execFileSync('git', ['ls-files', '-z', '--', ...prefixes], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout
    .split('\0')
    .filter((line) => line.length > 0)
    .map(posix);
}

/**
 * Files a *root's* direct value edge into the secrets package is expected from — see this file's
 * header. These are not exempt as *intermediate hops*: a root outside this list that reaches the
 * package by passing through one of these is still a violation (that is the whole point of the
 * transitive walk).
 */
function mayHoldAValueEdge(file: string): boolean {
  if (file === 'apps/web/server/secrets/memory-store.ts') return true;
  return /\.test\.tsx?$/u.test(file);
}

// ── Derive the package's secrets roots from its own manifest, not from a literal here ──────────

const CORE_MANIFEST = 'packages/core/package.json';
interface CoreManifest {
  exports?: Record<string, Record<string, string> | string>;
}
const manifest = JSON.parse(
  readFileSync(path.join(REPO_ROOT, CORE_MANIFEST), 'utf8'),
) as CoreManifest;
const secretsExport = manifest.exports?.['./secrets'];
if (secretsExport === undefined || typeof secretsExport === 'string') {
  throw new Error(`${CORE_MANIFEST} declares no "./secrets" export object; this gate cannot run.`);
}
/**
 * Real, repo-relative roots of the secrets package: one per export condition (types + default),
 * realpathed like every other path this gate compares — the package's own `src` root is not
 * reached through any symlink today, but a root compared without the same normalisation the
 * resolved edges get would be exactly the kind of asymmetry that let B1 through.
 */
const secretsRoots: readonly string[] = Object.values(secretsExport).map((target) => {
  const absoluteFile = path.join(REPO_ROOT, 'packages/core', target.replace(/^\.\//u, ''));
  const directory = path.dirname(absoluteFile);
  return toRealRepoRelative(directory);
});
if (secretsRoots.length === 0) {
  throw new Error(`${CORE_MANIFEST}'s "./secrets" export has no conditions; this gate cannot run.`);
}

function insideSecretsPackage(repoRelative: string): boolean {
  return secretsRoots.some((root) => repoRelative === root || repoRelative.startsWith(`${root}/`));
}

/** A file this gate declines to follow further — third-party code, not this repository's source. */
function isExternal(repoRelative: string): boolean {
  return repoRelative.split('/').includes('node_modules');
}

// ── apps/web's own tsconfig is the one resolution context every scanned file belongs to ────────

const APPS_WEB_TSCONFIG = path.join(REPO_ROOT, 'apps/web/tsconfig.json');
const parseHost: ts.ParseConfigFileHost = {
  useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  readDirectory: (rootDir, extensions, excludes, includes, depth) =>
    ts.sys.readDirectory(rootDir, extensions, excludes, includes, depth),
  fileExists: (fileName) => ts.sys.fileExists(fileName),
  readFile: (fileName) => ts.sys.readFile(fileName),
  getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
  onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
    throw new Error(
      `apps/web/tsconfig.json could not be read: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
    );
  },
};
const parsedWebConfig = ts.getParsedCommandLineOfConfigFile(
  APPS_WEB_TSCONFIG,
  undefined,
  parseHost,
);
if (parsedWebConfig === undefined) {
  throw new Error('apps/web/tsconfig.json did not parse; this gate cannot resolve anything.');
}
const webOptions = parsedWebConfig.options;
const resolutionCache = ts.createModuleResolutionCache(
  path.dirname(APPS_WEB_TSCONFIG),
  (fileName) => (ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase()),
  webOptions,
);

/** One specifier found in one file, and whether the import/export/require that named it is type-only. */
interface FoundSpecifier {
  readonly specifier: string;
  readonly typeOnly: boolean;
}

/**
 * Is this variable declaration binding an identifier to something `require`-shaped: assigned
 * straight from `require` (`const req = require`), or assigned the result of calling
 * `createRequire(...)` (verification round 3's B2 — `const req = createRequire(import.meta.url)`),
 * whether that function is named `createRequire`, is a local alias the file imported it under
 * (`import { createRequire as cr } from 'node:module'`; `createRequireNames`), or is read off an
 * object (`module.createRequire(...)`, `m.createRequire(...)` for `import * as m`)? A call through
 * such a binding is treated exactly like a direct `require(...)` call, including refusing a
 * non-literal argument.
 */
function requireLikeBinding(
  declaration: ts.VariableDeclaration,
  createRequireNames: ReadonlySet<string>,
): string | null {
  if (!ts.isIdentifier(declaration.name)) return null;
  const init = declaration.initializer;
  if (init === undefined) return null;
  const isRequireAlias = ts.isIdentifier(init) && init.text === 'require';
  const isCreateRequireResult =
    ts.isCallExpression(init) &&
    ((ts.isIdentifier(init.expression) && createRequireNames.has(init.expression.text)) ||
      (ts.isPropertyAccessExpression(init.expression) &&
        init.expression.name.text === 'createRequire'));
  return isRequireAlias || isCreateRequireResult ? declaration.name.text : null;
}

/**
 * Every static and literal-argument dynamic specifier in one file. Throws — rather than skipping —
 * on a dynamic `import()` or a `require`-shaped call (direct, or through a binding
 * {@link requireLikeBinding} recognises, or a property call such as `module.require(...)`,
 * `globalThis.require(...)` or `require.resolve(...)`) whose argument is not a plain string literal
 * (ADR-0031):
 * such a call could resolve to anything at run time, and this reader does not attempt the fuller
 * "vouched for" analysis the database-reachability gate uses for that case.
 *
 * One parse and one pruned pass over the tree per file, with no parent pointers and no JSDoc parsing:
 * none of the nodes read here is a JSDoc node (`forEachChild` never visits those) or needs its
 * parent. Calls through a plain identifier are collected during the pass and classified after it,
 * once every `require`-shaped binding in the file is known — a binding declared below its first
 * use is still recognised. This reader runs over the whole value closure (~170 files, ~1.4 MB) on
 * a CI runner that also runs two vitest projects side by side, so its CPU cost is the test's
 * duration there, multiplied by the runner's load.
 */
function specifiersIn(
  file: string,
  text = readFileSync(path.join(REPO_ROOT, file), 'utf8'),
): FoundSpecifier[] {
  const absolute = path.join(REPO_ROOT, file);
  const extension = path.posix.extname(file).toLowerCase();
  const kind =
    extension === '.tsx'
      ? ts.ScriptKind.TSX
      : extension === '.ts'
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS;
  const source = ts.createSourceFile(
    absolute,
    text,
    { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseNone },
    false,
    kind,
  );
  const createRequireNames = new Set(['createRequire']);
  const declarations: ts.VariableDeclaration[] = [];
  const identifierCalls: { readonly callee: string; readonly call: ts.CallExpression }[] = [];
  const resolveCalls: { readonly callee: string; readonly call: ts.CallExpression }[] = [];
  const found: FoundSpecifier[] = [];
  // Which subtrees the pass below may skip. Every specifier it records comes from one of: an
  // import declaration, an `import()` call or an `import('…')` type — each has the keyword
  // `import` inside its own source range — an `export … from` statement, which only ever sits
  // directly in a source file or a module block (both always descended), or a call through
  // `require` or a binding of it, which cannot exist in a file whose text names neither `require`
  // nor `createRequire` (or spells an identifier with a `\u` escape). So unless the file may call
  // `require`, a subtree whose range has no `import` in it is not walked — mostly schema and
  // repository bodies that cannot hold an edge. The compiler still decides every edge that is
  // recorded; the text only decides where not to look.
  const mayCallRequire = /\brequire\b|createRequire|\\u/u.test(text);
  const mayHoldAnEdge = (node: ts.Node): boolean => {
    if (mayCallRequire || ts.isSourceFile(node) || ts.isModuleDeclaration(node)) return true;
    if (ts.isModuleBlock(node)) return true;
    const at = text.indexOf('import', node.pos);
    return at !== -1 && at < node.end;
  };

  const literalArg = (node: ts.CallExpression, construct: string): void => {
    const argument = node.arguments[0];
    if (argument !== undefined && ts.isStringLiteralLike(argument)) {
      found.push({ specifier: argument.text, typeOnly: false });
      return;
    }
    throw new Error(
      `${file} calls ${construct} with an argument that is not a string literal, so this gate ` +
        'cannot tell which module it names and refuses rather than skipping it (ADR-0031).',
    );
  };

  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const typeOnly = node.importClause?.isTypeOnly === true;
      found.push({ specifier: node.moduleSpecifier.text, typeOnly });
      const bindings = node.importClause?.namedBindings;
      if (
        /^(?:node:)?module$/u.test(node.moduleSpecifier.text) &&
        bindings !== undefined &&
        ts.isNamedImports(bindings)
      ) {
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text === 'createRequire') {
            createRequireNames.add(element.name.text);
          }
        }
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      found.push({ specifier: node.moduleReference.expression.text, typeOnly: node.isTypeOnly });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      if (ts.isStringLiteralLike(node.moduleSpecifier)) {
        found.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly });
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      if (ts.isStringLiteralLike(node.argument.literal)) {
        found.push({ specifier: node.argument.literal.text, typeOnly: true });
      }
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        literalArg(node, 'a dynamic import');
      } else if (ts.isIdentifier(node.expression)) {
        identifierCalls.push({ callee: node.expression.text, call: node });
      } else if (ts.isPropertyAccessExpression(node.expression)) {
        const { expression: target, name } = node.expression;
        if (name.text === 'require') {
          literalArg(node, 'a property call to require');
        } else if (name.text === 'resolve' && ts.isIdentifier(target)) {
          resolveCalls.push({ callee: target.text, call: node });
        }
      }
    } else if (ts.isVariableDeclaration(node)) {
      declarations.push(node);
    }
    if (mayHoldAnEdge(node)) ts.forEachChild(node, walk);
  };
  walk(source);
  const requireLike = new Set<string>();
  for (const declaration of declarations) {
    const binding = requireLikeBinding(declaration, createRequireNames);
    if (binding !== null) requireLike.add(binding);
  }
  for (const { callee, call } of identifierCalls) {
    if (callee === 'require') literalArg(call, 'require');
    else if (requireLike.has(callee)) literalArg(call, 'an aliased require');
  }
  for (const { callee, call } of resolveCalls) {
    if (callee === 'require' || requireLike.has(callee)) literalArg(call, 'require.resolve');
  }
  return found;
}

interface Edge {
  readonly from: string;
  readonly specifier: string;
  readonly resolved: string;
  readonly typeOnly: boolean;
}

function resolveEdge(from: string, found: FoundSpecifier): Edge | null {
  const absoluteFrom = path.join(REPO_ROOT, from);
  const result = ts.resolveModuleName(
    found.specifier,
    absoluteFrom,
    webOptions,
    ts.sys,
    resolutionCache,
  );
  const resolvedFileName = result.resolvedModule?.resolvedFileName;
  if (resolvedFileName === undefined) return null;
  const resolved = toRealRepoRelative(resolvedFileName);
  return { from, specifier: found.specifier, resolved, typeOnly: found.typeOnly };
}

/** Every edge out of one file, computed once and cached — many roots' walks pass through the same
 * intermediate files, and re-parsing them per walk would be wasted work, not just slow. */
const edgeCache = new Map<string, readonly Edge[]>();
function edgesOf(file: string): readonly Edge[] {
  const cached = edgeCache.get(file);
  if (cached !== undefined) return cached;
  const edges = specifiersIn(file)
    .map((found) => resolveEdge(file, found))
    .filter((edge): edge is Edge => edge !== null);
  edgeCache.set(file, edges);
  return edges;
}

/** `null` means "does not reach"; otherwise the chain of files from `file` into the package. */
type Reach = readonly string[] | null;

/**
 * Files proven to reach the package (with the chain that does it) or proven not to. Shared across
 * roots, because many roots' walks pass through the same intermediate files.
 */
const reachCache = new Map<string, Reach>();

/**
 * Does `file` reach the secrets package through any chain of **value** edges? Follows a value edge
 * into any file — allow-listed or not, inside these two directories or not — except one under
 * `node_modules`.
 *
 * A plain depth-first search per root with one `visited` set, so each file is expanded at most once
 * per root. What goes into {@link reachCache} is restricted to answers that are true independently
 * of which root asked:
 *
 * * A **positive** result (a chain was found) is cached for every file on that chain — a real path
 *   into the package is true regardless of anything else still being explored.
 * * A **negative** result is cached only when the *whole* search from a root came back negative.
 *   At that point every file the search visited had its entire reachable set explored inside that
 *   same search (anything reachable from a visited file is reachable from the root), so none of
 *   them can reach the package either. A negative seen mid-search is never cached on its own: with
 *   a cycle `h1 → h2 → h3 → h1` plus a direct `h1 → secrets`, exploring `h1`'s first edge sees `h2`
 *   and `h3` come back negative only because `h1` was already on the stack — caching that was the
 *   unsound shortcut an earlier version of this function took (verification round 4's secondary
 *   finding), and a later root reaching the package only through `h2` was wrongly cleared by it.
 *
 * The version before this one avoided that by leaving such cycle-touched negatives uncached and
 * recomputing them on every revisit, which was correct but re-expanded the same files hundreds of
 * thousands of times (542,074 calls for 171 files) and timed out under CI load.
 */
function reaches(root: string): Reach {
  const visited = new Set<string>();
  const search = (file: string): Reach => {
    const cached = reachCache.get(file);
    if (cached !== undefined) return cached;
    if (visited.has(file)) return null;
    visited.add(file);
    for (const edge of edgesOf(file)) {
      if (edge.typeOnly) continue;
      if (insideSecretsPackage(edge.resolved)) {
        const chain = [file, edge.resolved];
        reachCache.set(file, chain);
        return chain;
      }
      if (isExternal(edge.resolved)) continue;
      const deeper = search(edge.resolved);
      if (deeper !== null) {
        const chain = [file, ...deeper];
        reachCache.set(file, chain);
        return chain;
      }
    }
    return null;
  };
  const chain = search(root);
  if (chain === null) for (const file of visited) reachCache.set(file, null);
  return chain;
}

describe('nothing reachable from a secrets route can construct a live secrets service', () => {
  it('no non-allow-listed file in these two directories transitively reaches the secrets package', () => {
    const files = trackedFilesUnder('apps/web/app/api/secrets', 'apps/web/server/secrets');
    expect(files.length).toBeGreaterThan(0);

    const violations: { readonly root: string; readonly chain: readonly string[] }[] = [];
    let packageEdgesSeen = 0;
    for (const file of files) {
      for (const edge of edgesOf(file)) {
        if (insideSecretsPackage(edge.resolved)) packageEdgesSeen += 1;
      }
      if (mayHoldAValueEdge(file)) continue; // this root is allowed to hold the edge itself.
      const chain = reaches(file);
      if (chain !== null) violations.push({ root: file, chain });
    }

    // The gate must have actually looked at something inside the package at least once — a
    // derivation bug that made `insideSecretsPackage` answer false for everything would leave
    // every assertion below vacuously true (ADR-0015).
    expect(packageEdgesSeen).toBeGreaterThan(0);

    expect(
      violations,
      violations
        .map((v) => `${v.root} reaches the package via: ${v.chain.join(' -> ')}`)
        .join('\n'),
    ).toEqual([]);
  });

  const PLANTED = 'apps/web/server/secrets/planted.ts';
  const SECRETS = '@agent-workspace/core/secrets';

  it.each([
    ['import-equals require', `import x = require('${SECRETS}');`],
    ['module.require', `module.require('${SECRETS}');`],
    ['globalThis.require', `globalThis.require('${SECRETS}');`],
    ['require.resolve', `require.resolve('${SECRETS}');`],
    [
      'an aliased createRequire',
      `import { createRequire as cr } from 'node:module';\nconst r = cr(import.meta.url);\nr('${SECRETS}');`,
    ],
    [
      'module.createRequire',
      `import module from 'node:module';\nconst r = module.createRequire(import.meta.url);\nr('${SECRETS}');`,
    ],
    [
      'a require alias declared after its use',
      `function f() { return r.resolve('${SECRETS}'); }\nconst r = require;`,
    ],
  ])('sees %s as a value edge', (_form, text) => {
    expect(specifiersIn(PLANTED, text)).toContainEqual({ specifier: SECRETS, typeOnly: false });
  });

  it.each([
    ['module.require', 'module.require(name);'],
    ['require.resolve', 'require.resolve(name);'],
    [
      'module.createRequire',
      'import module from "node:module";\nconst r = module.createRequire(import.meta.url);\nr(name);',
    ],
  ])('refuses a non-literal argument to %s (ADR-0031)', (_form, text) => {
    expect(() => specifiersIn(PLANTED, text)).toThrow(/ADR-0031/u);
  });
});
