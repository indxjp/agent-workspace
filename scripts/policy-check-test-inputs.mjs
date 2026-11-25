#!/usr/bin/env node
/**
 * `pnpm test-inputs:check` — every file a `tests/` Nx project reads is one of its declared inputs.
 *
 * The root `tests/` tree is split into Nx projects (tests/projects.mjs) so that `nx affected`
 * runs a project only when a file it reads changed. That is only sound if each project's `test`
 * target declares, as inputs, every path its tests read: a read the inputs miss is a change that
 * skips the tests that would have caught it, and the result is replayed from the cache as green.
 *
 * What this check sees (a static scan, by design — it runs in a second and needs no build):
 *
 * - every relative module import, re-export, dynamic `import()`, `require()` and `vi.mock()`,
 *   followed transitively through `tests/`, `scripts/`, `examples/` and every other file that is
 *   not inside a workspace package (a package's own imports are its own business);
 * - every import of a workspace package by name (`@indx-workspace/contracts/routes`). Nx makes
 *   an imported package a dependency of the project that OWNS the importing file, which `^default`
 *   then hashes — so the import counts only when the importing file lies under the project's own
 *   root. A file under another root (a helper of `tests/` imported by `tests-docs`, every file of
 *   a project such as `tests-next` whose root holds only its config) gives the edge to that other
 *   project; the package must then be a declared input or a positive implicit dependency;
 * - every `new URL('<path>', import.meta.url)`;
 * - every string or template-literal head that names a repository path: its first segment is a
 *   top-level entry of the repository (`docs/adr`, `apps/web/app`, `package.json`), including the
 *   literal segments of a `join(...)` / `resolve(...)` call (`join(root, 'docs', 'adr')`).
 *
 * What it does NOT see (the limits, stated so nobody relies on more):
 *
 * - a path built from a variable that is not a literal at the call site (`join(webDir, 'app')`
 *   is seen as `app`, which names no top-level entry, and is ignored), or computed at run time;
 * - a read performed by a child process the test spawns (`tsc`, `next dev`, `git ls-files`);
 *   such a test must declare what its child reads by hand, and a reviewer must check it;
 * - files under build output (`dist/`, `.next/`, `node_modules/`), which are a task's outputs,
 *   not its inputs: the `test` target depends on `build`, which hashes the sources.
 *
 * Over-reporting is possible (a string that names a path but is never opened). The fix is to
 * declare the input anyway — a superfluous input costs a run, a missing one costs a gate.
 */
import console from 'node:console';
import { existsSync, globSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { configDefaults } from 'vitest/config';

import { testsProjects } from '../tests/projects.mjs';

const OUTPUT_SEGMENTS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.next-embedded',
  'coverage',
  '.nx',
  '.lake',
  'test-results',
  'playwright-report',
  '.git',
]);

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.mjs', '.js', '.cjs', '.jsx'];

/** @param {string} p */
function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * The repository's top-level entries, which is what makes a string a repository path.
 *
 * @param {string} repoRoot
 * @returns {Set<string>}
 */
export function topLevelEntries(repoRoot) {
  return new Set(
    readdirSync(repoRoot).filter((name) => !['.git', 'node_modules', '.nx'].includes(name)),
  );
}

/**
 * The repository-relative path a literal names, cut at its first wildcard or substitution, or
 * null when it names none.
 *
 * @param {string} text
 * @param {Set<string>} topLevel
 * @returns {string | null}
 */
export function repositoryPathOf(text, topLevel) {
  const trimmed = text.replace(/^\.\//u, '').replace(/\/+$/u, '');
  if (trimmed === '' || /\s|^[a-z][a-z0-9+.-]*:/iu.test(trimmed)) return null;
  const segments = [];
  for (const segment of trimmed.split('/')) {
    if (/[*?[\]{}!]/u.test(segment) || segment === '' || segment === '.' || segment === '..') break;
    segments.push(segment);
  }
  if (segments.length === 0 || !topLevel.has(segments[0] ?? '')) return null;
  // A bare top-level name with no slash is a read only when it names a file (`package.json`,
  // `.gitignore`); a bare directory name (`docs`, `.github`) is far more often a word than a
  // path. Which one it is takes the file system, so the caller decides: see `bare` below.
  return segments.join('/');
}

/**
 * @typedef {{ kind: 'import' | 'package' | 'read'; path: string; line: number; text: string; bare?: boolean }} Reference
 *   `path` is absolute for an import and for a file-relative read, repository-relative for a
 *   repository-path read (`kind: 'read'` with a relative `path`), and the bare specifier for a
 *   `package` import (`@indx-workspace/contracts/routes`). `bare` marks a literal that is a
 *   top-level name and nothing else, which counts only when it names a file.
 */

/** What makes an expression a temporary directory rather than a place in the repository. */
const TEMPORARY_SOURCE = /mkdtemp|tmpdir\(\)/u;

/**
 * The names a file binds to a temporary directory (`const root = mkdtempSync(...)`), and to
 * anything built from one (`const skill = join(root, 'skills')`), so that the fixture tree a test
 * writes there is not mistaken for a read of the repository.
 *
 * @param {ts.SourceFile} sf
 * @returns {Set<string>}
 */
function temporaryBases(sf) {
  /** @type {[string, string][]} */
  const bindings = [];
  /** @param {ts.Node} node */
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      bindings.push([node.name.text, node.initializer.getText(sf)]);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      bindings.push([node.left.text, node.right.getText(sf)]);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  const names = new Set();
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, value] of bindings) {
      if (names.has(name)) continue;
      const derived = [...names].some((known) =>
        new RegExp(`(^|[^\\w$.])${known}([^\\w$]|$)`, 'u').test(value),
      );
      if (TEMPORARY_SOURCE.test(value) || derived) {
        names.add(name);
        changed = true;
      }
    }
  }
  return names;
}

/**
 * The references one source file makes.
 *
 * @param {string} fileAbs
 * @param {string} source
 * @param {Set<string>} topLevel
 * @returns {Reference[]}
 */
export function scanSource(fileAbs, source, topLevel) {
  const kind = fileAbs.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileAbs, source, ts.ScriptTarget.Latest, true, kind);
  /** @type {Reference[]} */
  const out = [];
  /** @type {Set<ts.Node>} */
  const consumed = new Set();
  // The SDK's definition helpers (`files('manuals', 'read')`, `skill('manuals')`) take names of a
  // workspace's folders and skills, never repository paths, so their arguments are not reads.
  /** @type {Set<string>} */
  const definitionHelpers = new Set();
  for (const statement of sf.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== '@indx-workspace/sdk/define'
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) definitionHelpers.add(element.name.text);
    }
  }
  const lineOf = (/** @type {ts.Node} */ node) =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const literalText = (/** @type {ts.Node | undefined} */ node) =>
    node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ? node.text
      : null;
  const addImport = (/** @type {ts.Node} */ node, /** @type {string} */ spec) => {
    consumed.add(node);
    if (spec.startsWith('.')) {
      out.push({
        kind: 'import',
        path: path.resolve(path.dirname(fileAbs), spec.replace(/\?.*$/u, '')),
        line: lineOf(node),
        text: spec,
      });
    } else if (!spec.startsWith('node:') && !spec.startsWith('/')) {
      out.push({ kind: 'package', path: spec, line: lineOf(node), text: spec });
    }
  };
  const addRepoRead = (
    /** @type {ts.Node} */ node,
    /** @type {string} */ text,
    /** @type {boolean} */ argument = false,
  ) => {
    const repoPath = repositoryPathOf(text, topLevel);
    if (repoPath !== null) {
      out.push({
        kind: 'read',
        path: repoPath,
        line: lineOf(node),
        text,
        bare: !argument && !text.replace(/^\.\//u, '').replace(/\/+$/u, '').includes('/'),
      });
    }
  };
  // A bare directory name passed straight to a call (`tracked('apps', 'packages')`) names the
  // directory the call lists; one in a test's title, an assertion or a temporary tree does not.
  const isPathArgument = (/** @type {ts.Node} */ node) => {
    const call = node.parent;
    if (!ts.isCallExpression(call) || !call.arguments.some((argument) => argument === node)) {
      return false;
    }
    const callee = call.expression.getText(sf);
    if (definitionHelpers.has(callee)) return false;
    return (
      !/^(describe|it|test|expect|vi)\b|\.(toBe|toEqual|toContain|toMatch|toStrictEqual|includes|startsWith|endsWith|has|get|set|add|push|split|replace|join|resolve|log|error|warn)$|^(console|String|Number|Symbol)\b/u.test(
        callee,
      ) && !isTemporary(call.getText(sf))
    );
  };

  const temporaryNames = temporaryBases(sf);
  const isTemporary = (/** @type {string} */ text) =>
    TEMPORARY_SOURCE.test(text) ||
    [...temporaryNames].some((name) =>
      new RegExp(`(^|[^\\w$.])${name}([^\\w$]|$)`, 'u').test(text),
    );

  /** @param {ts.Node} node */
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined
    ) {
      const spec = literalText(node.moduleSpecifier);
      if (spec !== null) addImport(node.moduleSpecifier, spec);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      const first = literalText(node.arguments[0]);
      if (
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          callee === 'require' ||
          /^vi\.(mock|doMock|importActual)$/u.test(callee)) &&
        first !== null &&
        node.arguments[0] !== undefined
      ) {
        addImport(node.arguments[0], first);
      } else if (
        /(^|\.)(join|resolve)$/u.test(callee) &&
        node.arguments.length > 1 &&
        isTemporary(node.arguments[0]?.getText(sf) ?? '')
      ) {
        // join(scratch, 'docs'): a path in a temporary directory the test made, not in the tree.
        for (const argument of node.arguments) consumed.add(argument);
      } else if (/(^|\.)(join|resolve)$/u.test(callee) && node.arguments.length > 1) {
        // join(base, 'a', 'b'): the literal segments after the base name a path below it.
        const literals = [];
        for (const argument of node.arguments.slice(1)) {
          const text = literalText(argument);
          if (text === null) break;
          consumed.add(argument);
          literals.push(text);
        }
        const [base] = node.arguments;
        const firstLiteral = literalText(base);
        if (base !== undefined && firstLiteral !== null) {
          consumed.add(base);
          literals.unshift(firstLiteral);
        }
        if (literals.length > 0) {
          const joined = toPosix(path.posix.join(...literals));
          if (joined.startsWith('..')) {
            out.push({
              kind: 'read',
              path: path.resolve(path.dirname(fileAbs), joined),
              line: lineOf(node),
              text: literals.join(', '),
            });
          } else {
            const repoPath = repositoryPathOf(
              joined.includes('/') ? joined : `${joined}/`,
              topLevel,
            );
            if (repoPath !== null) {
              out.push({
                kind: 'read',
                path: repoPath,
                line: lineOf(node),
                text: literals.join(', '),
              });
            }
          }
        }
      }
    } else if (
      ts.isNewExpression(node) &&
      node.expression.getText(sf) === 'URL' &&
      node.arguments !== undefined &&
      node.arguments.length === 2 &&
      node.arguments[1]?.getText(sf) === 'import.meta.url'
    ) {
      const spec = literalText(node.arguments[0]);
      if (spec !== null && node.arguments[0] !== undefined) {
        consumed.add(node.arguments[0]);
        out.push({
          kind: 'read',
          path: path.resolve(path.dirname(fileAbs), spec),
          line: lineOf(node),
          text: spec,
        });
      }
    } else if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      !consumed.has(node)
    ) {
      addRepoRead(node, node.text, isPathArgument(node));
    } else if (ts.isTemplateExpression(node)) {
      addRepoRead(node, `${node.head.text}*`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * The file a relative import names, the way TypeScript and Vite resolve it (`./a.js` may be
 * `./a.ts`), or null when there is none.
 *
 * @param {string} target
 * @returns {string | null}
 */
export function resolveModule(target) {
  const isFile = (/** @type {string} */ p) => existsSync(p) && statSync(p).isFile();
  if (isFile(target)) return target;
  const swapped = target.replace(/\.(m|c)?jsx?$/u, (_, kind) => `.${kind ?? ''}ts`);
  if (swapped !== target && isFile(swapped)) return swapped;
  if (target.endsWith('.js') && isFile(target.replace(/\.js$/u, '.tsx'))) {
    return target.replace(/\.js$/u, '.tsx');
  }
  for (const extension of SOURCE_EXTENSIONS) {
    if (isFile(target + extension)) return target + extension;
  }
  for (const extension of SOURCE_EXTENSIONS) {
    const index = path.join(target, `index${extension}`);
    if (isFile(index)) return index;
  }
  return null;
}

/**
 * The repository-relative path a reference names, or null when it names nothing that exists (a
 * fixture name, an output not yet written), names build output, or lies outside the repository.
 *
 * @param {string} repoRoot
 * @param {string} p absolute, or relative to the repository root
 * @returns {string | null}
 */
export function existingRepositoryPath(repoRoot, p) {
  const relative = toPosix(path.relative(repoRoot, path.resolve(repoRoot, p)));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  if (relative.split('/').some((segment) => OUTPUT_SEGMENTS.has(segment))) return null;
  return existsSync(path.join(repoRoot, relative)) ? relative : null;
}

/**
 * @typedef {{ path: string; via: 'import' | 'read'; from: string; line: number; text: string }} Read
 *   `path` is repository-relative; `from` is the repository-relative file that made the reference.
 */

/**
 * The package a bare specifier names: `@scope/name` of `@scope/name/sub`, `name` of `name/sub`.
 *
 * @param {string} specifier
 */
export function packageName(specifier) {
  const segments = specifier.split('/');
  return (specifier.startsWith('@') ? segments.slice(0, 2) : segments.slice(0, 1)).join('/');
}

/**
 * Every file and directory the given entry files read, transitively through relative imports.
 *
 * @param {{ repoRoot: string; entries: readonly string[]; topLevel: Set<string>; isPackageFile: (repoPath: string) => boolean; packageRoots?: ReadonlyMap<string, string> }} input
 *   `packageRoots` maps a workspace package's name to its repository-relative root; an import of a
 *   package it does not name (an npm dependency) is not a read of the repository.
 * @returns {Read[]}
 */
export function collectReads({ repoRoot, entries, topLevel, isPackageFile, packageRoots }) {
  /** @type {Read[]} */
  const reads = [];
  const seen = new Set();
  const queue = entries.map((entry) => path.resolve(repoRoot, entry));
  while (queue.length > 0) {
    const fileAbs = queue.shift();
    if (fileAbs === undefined || seen.has(fileAbs)) continue;
    seen.add(fileAbs);
    const from = toPosix(path.relative(repoRoot, fileAbs));
    const source = readFileSync(fileAbs, 'utf8');
    const scannable = SOURCE_EXTENSIONS.some((extension) => fileAbs.endsWith(extension));
    if (!scannable) continue;
    for (const reference of scanSource(fileAbs, source, topLevel)) {
      if (reference.kind === 'package') {
        const root = packageRoots?.get(packageName(reference.path));
        if (root !== undefined) {
          reads.push({
            path: root,
            via: 'import',
            from,
            line: reference.line,
            text: reference.text,
          });
        }
      } else if (reference.kind === 'import') {
        const resolved = resolveModule(reference.path);
        const target = resolved ?? reference.path;
        const repoPath = existingRepositoryPath(repoRoot, target);
        if (repoPath === null) continue;
        reads.push({
          path: repoPath,
          via: 'import',
          from,
          line: reference.line,
          text: reference.text,
        });
        if (resolved !== null && !isPackageFile(repoPath)) queue.push(resolved);
      } else {
        const repoPath = existingRepositoryPath(repoRoot, reference.path);
        if (repoPath === null) continue;
        if (reference.bare === true && statSync(path.join(repoRoot, repoPath)).isDirectory()) {
          continue;
        }
        // A directory that contains the reading file is a base it builds paths from
        // (`join(here, '..', '..')`), not a read of everything below it.
        if (from.startsWith(`${repoPath}/`)) continue;
        reads.push({
          path: repoPath,
          via: 'read',
          from,
          line: reference.line,
          text: reference.text,
        });
      }
    }
  }
  return reads;
}

/**
 * The Nx project roots of the workspace: the root, every pnpm workspace package and every
 * directory holding a project.json.
 *
 * @param {string} repoRoot
 * @returns {{ name: string; root: string }[]}
 */
export function workspaceProjects(repoRoot) {
  /** @type {{ name: string; root: string }[]} */
  const projects = [{ name: readJson(path.join(repoRoot, 'package.json')).name, root: '' }];
  for (const group of ['apps', 'packages']) {
    const dir = path.join(repoRoot, group);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const manifest = path.join(dir, entry.name, 'package.json');
      if (entry.isDirectory() && existsSync(manifest)) {
        projects.push({ name: readJson(manifest).name, root: `${group}/${entry.name}` });
      }
    }
  }
  for (const file of globSync('**/project.json', {
    cwd: repoRoot,
    exclude: (name) => OUTPUT_SEGMENTS.has(path.basename(name)) || name === '.claude',
  })) {
    const root = toPosix(path.dirname(file));
    const name = readJson(path.join(repoRoot, file)).name ?? root;
    if (!projects.some((project) => project.root === root)) projects.push({ name, root });
  }
  return projects;
}

/**
 * The project that owns a repository path: the one with the deepest root containing it.
 *
 * @param {readonly { name: string; root: string }[]} projects
 * @param {string} repoPath
 */
export function ownerOf(projects, repoPath) {
  let best = projects.find((project) => project.root === '');
  for (const project of projects) {
    if (
      project.root !== '' &&
      (repoPath === project.root || repoPath.startsWith(`${project.root}/`)) &&
      project.root.length > (best?.root.length ?? -1)
    ) {
      best = project;
    }
  }
  if (best === undefined) throw new Error('the workspace has no root project');
  return best;
}

/** @param {string} file */
function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * @typedef {{ globs: string[]; negated: string[]; dependencyInputs: boolean }} ExpandedInputs
 *   `globs` and `negated` are repository-relative.
 */

/**
 * A target's inputs with named inputs expanded and `{projectRoot}` / `{workspaceRoot}` replaced.
 *
 * @param {readonly unknown[]} inputs
 * @param {Record<string, readonly unknown[]>} namedInputs
 * @param {string} projectRoot
 * @returns {ExpandedInputs}
 */
export function expandInputs(inputs, namedInputs, projectRoot) {
  /** @type {ExpandedInputs} */
  const expanded = { globs: [], negated: [], dependencyInputs: false };
  const replace = (/** @type {string} */ glob) =>
    glob
      .replace('{projectRoot}', projectRoot)
      .replace(/^\{workspaceRoot\}\/?/u, '')
      .replace(/^\//u, '');
  const walk = (/** @type {readonly unknown[]} */ list, /** @type {Set<string>} */ stack) => {
    for (const input of list) {
      const text =
        typeof input === 'string'
          ? input
          : input !== null && typeof input === 'object' && 'fileset' in input
            ? String(input.fileset)
            : null;
      if (text === null) continue; // { runtime }, { env }, { externalDependencies }
      if (text.startsWith('^')) {
        expanded.dependencyInputs = true;
      } else if (text.startsWith('!')) {
        expanded.negated.push(replace(text.slice(1)));
      } else if (text.includes('/') || text.includes('{')) {
        expanded.globs.push(replace(text));
      } else {
        const named = namedInputs[text];
        if (named === undefined) throw new Error(`unknown named input "${text}"`);
        if (stack.has(text)) continue;
        walk(named, new Set([...stack, text]));
      }
    }
  };
  walk(inputs, new Set());
  return expanded;
}

/**
 * Whether a glob list covers a repository path; a directory is covered when everything below it
 * is (probed with a file name no glob can be written for).
 *
 * @param {ExpandedInputs} inputs
 * @param {string} repoPath
 * @param {boolean} isDirectory
 */
export function globsCover(inputs, repoPath, isDirectory) {
  const probe = isDirectory ? `${repoPath}/__probe__/__probe__.__probe__` : repoPath;
  // Nx matches dot files and directories with `**` and `*`; `path.matchesGlob` does not, so a path
  // is also tried with each leading dot replaced (`.github` → `_github`).
  const undotted = probe.replace(/(^|\/)\./gu, '$1_');
  const matches = (/** @type {string} */ glob) =>
    glob === '' ||
    glob === '**' ||
    glob === '**/*' ||
    path.posix.matchesGlob(probe, glob) ||
    path.posix.matchesGlob(undotted, glob);
  return inputs.globs.some(matches) && !inputs.negated.some(matches);
}

/**
 * @typedef {{
 *   name: string;
 *   projectRoot: string;
 *   testFiles: readonly string[];
 *   inputs: ExpandedInputs;
 *   implicitDependencies: readonly string[];
 * }} CheckedProject
 */

/**
 * The reads a project's inputs do not cover, each with the reason.
 *
 * @param {{ repoRoot: string; project: CheckedProject; projects: readonly { name: string; root: string }[]; topLevel: Set<string> }} input
 * @returns {{ read: Read; reason: string }[]}
 */
export function uncoveredReads({ repoRoot, project, projects, topLevel }) {
  const rootProject = projects.find((candidate) => candidate.root === '');
  const isPackageFile = (/** @type {string} */ repoPath) => {
    const owner = ownerOf(projects, repoPath);
    return /^(apps|packages)\//u.test(owner.root);
  };
  const packageRoots = new Map(
    projects
      .filter((candidate) => /^(apps|packages)\//u.test(candidate.root))
      .map((candidate) => [candidate.name, candidate.root]),
  );
  const reads = collectReads({
    repoRoot,
    entries: project.testFiles,
    topLevel,
    isPackageFile,
    packageRoots,
  });
  const excluded = new Set(
    project.implicitDependencies
      .filter((name) => name.startsWith('!'))
      .map((name) => name.slice(1)),
  );
  const included = new Set(project.implicitDependencies.filter((name) => !name.startsWith('!')));
  /** @type {{ read: Read; reason: string }[]} */
  const failures = [];
  const reported = new Set();
  for (const read of reads) {
    // Keyed by the owner of the reading file as well: an import of a package is this project's
    // edge from one of its own files and not from another project's.
    const key = `${read.path}\0${read.via}\0${ownerOf(projects, read.from).root}`;
    if (reported.has(key)) continue;
    reported.add(key);
    const isDirectory = statSync(path.join(repoRoot, read.path)).isDirectory();
    if (globsCover(project.inputs, read.path, isDirectory)) continue;
    const owner = ownerOf(projects, read.path);
    if (owner.root === project.projectRoot) {
      failures.push({ read, reason: `inside ${project.name} but not in its inputs` });
      continue;
    }
    if (owner === rootProject) {
      if (read.via === 'import' && !excluded.has(owner.name)) {
        failures.push({
          read,
          reason:
            `imports a file the root project owns; that makes "${owner.name}" a dependency and ` +
            `every root file an input — add "!${owner.name}" to implicitDependencies and declare ` +
            `the file as an input`,
        });
      } else {
        failures.push({ read, reason: 'a root-project path not declared as an input' });
      }
      continue;
    }
    // Nx gives an import edge to the project that owns the importing file, so only an import made
    // under this project's own root makes the package this project's dependency.
    const ownImport =
      read.via === 'import' && ownerOf(projects, read.from).root === project.projectRoot;
    const edge = !excluded.has(owner.name) && (ownImport || included.has(owner.name));
    if (project.inputs.dependencyInputs && edge) continue;
    failures.push({
      read,
      reason: ownImport
        ? `imports ${owner.name}, which is excluded from its dependencies or not hashed (no ^ input)`
        : read.via === 'import'
          ? `imports ${owner.name} from ${read.from}, which another project owns, so Nx gives the edge to that project — declare the package as an input or a positive implicit dependency`
          : `reads ${owner.name} without a declared input or implicit dependency (Nx sees no import)`,
    });
  }
  return failures;
}

/**
 * The files a project collects: its `include` globs under its Vitest root, less its `exclude`
 * globs and anything under node_modules — the rules Vitest applies.
 *
 * @param {string} repoRoot
 * @param {{ root: string; include: readonly string[]; exclude: readonly string[] }} entry
 * @returns {string[]} repository-relative
 */
export function collectedFiles(repoRoot, entry) {
  const vitestRoot = path.join(repoRoot, entry.root);
  const files = new Set(entry.include.flatMap((pattern) => globSync(pattern, { cwd: vitestRoot })));
  return [...files]
    .map(toPosix)
    .filter(
      (file) =>
        !file.split('/').includes('node_modules') &&
        !entry.exclude.some((glob) => path.posix.matchesGlob(file, glob)),
    )
    .map((file) => path.posix.join(entry.root, file))
    .sort();
}

/**
 * The checked form of every `tests/` project, from tests/projects.mjs, its project.json and nx.json.
 *
 * @param {string} repoRoot
 * @returns {CheckedProject[]}
 */
export function loadTestsProjects(repoRoot) {
  const nxJson = readJson(path.join(repoRoot, 'nx.json'));
  /** @type {CheckedProject[]} */
  const loaded = [];
  // Every file a project can collect, the storage load test included: the inputs of the project
  // that runs it under AW_LOAD_TESTS=1 must cover what it reads too.
  for (const entry of testsProjects({ loadTests: true })) {
    const projectJsonPath = path.join(repoRoot, entry.projectRoot, 'project.json');
    if (!existsSync(projectJsonPath)) {
      throw new Error(`${entry.name}: ${entry.projectRoot}/project.json is missing`);
    }
    const projectJson = readJson(projectJsonPath);
    if (projectJson.name !== entry.name) {
      throw new Error(`${projectJsonPath}: name is ${projectJson.name}, expected ${entry.name}`);
    }
    const test = projectJson.targets?.test;
    const inputs = test?.inputs ?? nxJson.targetDefaults?.test?.inputs;
    if (!Array.isArray(inputs)) throw new Error(`${entry.name}: the test target has no inputs`);
    const command = String(test?.options?.command ?? '');
    if (!command.includes(`--project ${entry.name} `)) {
      throw new Error(
        `${entry.name}: the test target must run \`vitest run --project ${entry.name}\``,
      );
    }
    const testFiles = collectedFiles(repoRoot, entry);
    loaded.push({
      name: entry.name,
      projectRoot: entry.projectRoot,
      testFiles,
      inputs: expandInputs(
        inputs,
        { ...nxJson.namedInputs, ...projectJson.namedInputs },
        entry.projectRoot,
      ),
      implicitDependencies: projectJson.implicitDependencies ?? [],
    });
  }
  return loaded;
}

function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const topLevel = topLevelEntries(repoRoot);
  const projects = workspaceProjects(repoRoot);
  const checked = loadTestsProjects(repoRoot);
  let failed = 0;
  const seenFiles = new Map();
  for (const project of checked) {
    for (const file of project.testFiles) {
      const other = seenFiles.get(file);
      if (other !== undefined) {
        console.error(`${file} is collected by both ${other} and ${project.name}`);
        failed += 1;
      }
      seenFiles.set(file, project.name);
    }
    const failures = uncoveredReads({ repoRoot, project, projects, topLevel });
    for (const { read, reason } of failures) {
      console.error(
        `${project.name}: ${read.from}:${String(read.line)} ${read.via}s ${read.path} (${JSON.stringify(read.text)}) — ${reason}`,
      );
    }
    failed += failures.length;
    console.log(
      `${project.name}: ${String(project.testFiles.length)} test files, ${String(failures.length)} undeclared reads`,
    );
  }
  // Every test file under tests/ is collected by some project: a file no project collects is a
  // gate nothing runs.
  for (const file of collectedFiles(repoRoot, {
    root: 'tests',
    include: configDefaults.include,
    exclude: ['browser/**'],
  })) {
    if (!seenFiles.has(file)) {
      console.error(`${file} is collected by no tests/ project (tests/projects.mjs)`);
      failed += 1;
    }
  }
  if (failed > 0) {
    console.error(
      `\n${String(failed)} problem(s). Declare each path in the project's test target inputs ` +
        '(tests/<dir>/project.json); see the header of scripts/policy-check-test-inputs.mjs.',
    );
    process.exit(1);
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
