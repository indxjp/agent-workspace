import { posix } from 'node:path';

import ts from 'typescript';

const MiB = 1024 * 1024;

/** The one place each storage size limit is defined (the storage design, §04 "Size limits"). */
export const STORAGE_LIMITS = [
  { name: 'MAX_UPLOAD_BYTES', owner: 'packages/contracts/src/files.ts', bytes: 64 * MiB },
  {
    name: 'SIGNED_UPLOAD_HARD_MAX_BYTES',
    owner: 'packages/contracts/src/files.ts',
    bytes: 5 * 1024 * MiB,
  },
  { name: 'RUN_FILES_MAX_BYTES', owner: 'packages/runtime/src/transfer.ts', bytes: 128 * MiB },
  {
    name: 'SESSION_STATE_BLOB_MAX_BYTES',
    owner: 'packages/engine/src/session-state.ts',
    bytes: 32 * MiB,
  },
  {
    name: 'MAX_SKILL_REQUEST_BODY_BYTES',
    owner: 'packages/contracts/src/skills.ts',
    bytes: 16 * MiB,
  },
  {
    name: 'SURFACE_ATTACHMENT_MAX_BYTES',
    owner: 'packages/contracts/src/attachment-limits.ts',
    bytes: 10 * MiB,
  },
  {
    name: 'SURFACE_ATTACHMENTS_MAX_TOTAL_BYTES',
    owner: 'packages/contracts/src/surfaces.ts',
    bytes: 50 * MiB,
  },
] as const;

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

const SCOPE = [
  /^apps\/web\/server\/(?:files|skills|sessions|compose|runs|surfaces)\//u,
  /^apps\/runner\/src\//u,
  /^packages\/(?:runtime|contracts|engine|sdk|aw)\/src\//u,
  /^packages\/core\/src\/storage\//u,
];

/** Non-test (`.test`, `.acceptance`, `.contract`), non-declaration `.ts` in the storage scope. */
export function inStorageScope(path: string): boolean {
  return (
    path.endsWith('.ts') &&
    !/\.(?:test|acceptance|contract)\.ts$/u.test(path) &&
    !path.endsWith('.d.ts') &&
    SCOPE.some((pattern) => pattern.test(path))
  );
}

/** Resolves an identifier to the value of the binding it names, or `null` when it cannot. */
type Resolve = (identifier: ts.Identifier) => number | null;

function fold(node: ts.Expression, resolve: Resolve): number | null {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return fold(node.expression, resolve);
  }
  if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll('_', ''));
  if (ts.isIdentifier(node)) return resolve(node);
  if (isMathPow(node)) {
    const [base, exponent] = node.arguments.map((argument) => fold(argument, resolve));
    return base === undefined || base === null || exponent === undefined || exponent === null
      ? null
      : base ** exponent;
  }
  if (!ts.isBinaryExpression(node)) return null;
  const left = fold(node.left, resolve);
  const right = fold(node.right, resolve);
  if (left === null || right === null) return null;
  switch (node.operatorToken.kind) {
    case ts.SyntaxKind.AsteriskToken:
      return left * right;
    case ts.SyntaxKind.PlusToken:
      return left + right;
    case ts.SyntaxKind.MinusToken:
      return left - right;
    case ts.SyntaxKind.AsteriskAsteriskToken:
      return left ** right;
    case ts.SyntaxKind.LessThanLessThanToken:
      return left * 2 ** right;
    default:
      return null;
  }
}

function isMathPow(node: ts.Expression): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    node.arguments.length === 2 &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'Math' &&
    node.expression.name.text === 'pow'
  );
}

/** Test code: a test, acceptance, contract or spec file, or anything under the top-level `tests/`. */
function isTestCode(path: string): boolean {
  return (
    /\.(?:test|spec|acceptance|contract)\.[cm]?[jt]sx?$/u.test(path) || path.startsWith('tests/')
  );
}

/** A name bound to an initializer: a variable, an object or class property, or a default parameter. */
interface Binding {
  readonly name: string;
  readonly initializer: ts.Expression;
  readonly exported: boolean;
  /** Only a variable can be named by a bare identifier elsewhere in the file. */
  readonly variable: boolean;
}

/** One parse per path and text for the whole process: every scan reads the same tree. */
const parsed = new Map<string, { readonly text: string; readonly source: ts.SourceFile }>();

function parse(file: SourceFile): ts.SourceFile {
  const cached = parsed.get(file.path);
  if (cached?.text === file.text) return cached.source;
  const source = ts.createSourceFile(
    file.path,
    file.text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  parsed.set(file.path, { text: file.text, source });
  return source;
}

function bindingName(name: ts.Node): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
}

function bindings(source: ts.SourceFile): Binding[] {
  const found: Binding[] = [];
  const add = (name: ts.Node, initializer: ts.Expression | undefined, variable = false) => {
    const text = bindingName(name);
    if (text !== null && initializer !== undefined) {
      found.push({ name: text, initializer, exported: false, variable });
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node)) {
      const exported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
      for (const decl of node.declarationList.declarations) {
        const name = bindingName(decl.name);
        if (name !== null && decl.initializer !== undefined) {
          found.push({ name, initializer: decl.initializer, exported, variable: true });
        }
      }
    } else if (ts.isVariableDeclaration(node) && !ts.isVariableStatement(node.parent.parent)) {
      add(node.name, node.initializer, true);
    } else if (ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) {
      add(node.name, node.initializer);
    } else if (ts.isParameter(node)) {
      add(node.name, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** `local name → exported name` for each named import of the file. */
function namedImports(source: ts.SourceFile): Map<string, string> {
  const imports = new Map<string, string>();
  for (const statement of source.statements) {
    const clause = ts.isImportDeclaration(statement) ? statement.importClause : undefined;
    const named = clause?.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      imports.set(element.name.text, (element.propertyName ?? element.name).text);
    }
  }
  return imports;
}

/**
 * Where `name` is declared directly in `scope`: its initializer, `undefined` when it is declared
 * without one (a parameter, a function, a destructured name), or `null` when `scope` does not
 * declare it. A declaration without a value still shadows any outer binding of the name.
 */
function declaredIn(scope: ts.Node, name: string): ts.Expression | undefined | null {
  const fromList = (list: ts.VariableDeclarationList) => {
    const decl = list.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === name);
    return decl === undefined ? null : decl.initializer;
  };
  if (ts.isFunctionLike(scope)) {
    const param = scope.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === name);
    if (param !== undefined) return param.initializer;
    return scope.name !== undefined && ts.isIdentifier(scope.name) && scope.name.text === name
      ? undefined
      : null;
  }
  if (
    (ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) &&
    scope.initializer !== undefined &&
    ts.isVariableDeclarationList(scope.initializer)
  ) {
    return fromList(scope.initializer);
  }
  if (ts.isCatchClause(scope)) {
    const variable = scope.variableDeclaration?.name;
    return variable !== undefined && ts.isIdentifier(variable) && variable.text === name
      ? undefined
      : null;
  }
  const statements =
    ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope)
      ? scope.statements
      : ts.isCaseClause(scope) || ts.isDefaultClause(scope)
        ? scope.statements
        : undefined;
  for (const statement of statements ?? []) {
    if (ts.isVariableStatement(statement)) {
      const found = fromList(statement.declarationList);
      if (found !== null) return found;
    } else if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name?.text === name
    ) {
      return undefined;
    }
  }
  return null;
}

const LIMIT_NAMES = new Set<string>(STORAGE_LIMITS.map((limit) => limit.name));

interface NumericBinding {
  readonly name: string;
  readonly value: number;
  readonly exported: boolean;
  readonly variable: boolean;
  /** The value is reached through an imported limit (`maxBytes: MAX_UPLOAD_BYTES`): a use, not a copy. */
  readonly usesLimit: boolean;
}

/**
 * The numeric value of every binding in `file`. An identifier resolves to the nearest declaration
 * of its name in the enclosing scopes, else, when the file imports it by name, to the one exported
 * constant of that name in `exported` (a name exported with two different values stays unresolved).
 */
function numericBindings(
  file: SourceFile,
  exported: Pick<ReadonlyMap<string, number | null>, 'get'> = new Map(),
): NumericBinding[] {
  const source = parse(file);
  const imports = namedImports(source);
  const resolving = new Set<ts.Expression>();
  let usesLimit = false;
  const resolve: Resolve = (identifier) => {
    const name = identifier.text;
    for (let scope = identifier.parent; scope !== undefined; scope = scope.parent) {
      const initializer = declaredIn(scope, name);
      if (initializer === null) continue;
      // The name's own default (`cap = cap * 2`) or an unvalued declaration does not resolve.
      if (initializer === undefined || resolving.has(initializer)) return null;
      resolving.add(initializer);
      const value = fold(initializer, resolve);
      resolving.delete(initializer);
      return value;
    }
    const original = imports.get(name);
    if (original === undefined) return null;
    if (LIMIT_NAMES.has(original)) usesLimit = true;
    return exported.get(original) ?? null;
  };
  return bindings(source).flatMap(({ name, initializer, exported: isExported, variable }) => {
    usesLimit = false;
    resolving.add(initializer);
    const value = fold(initializer, resolve);
    resolving.delete(initializer);
    return value === null ? [] : [{ name, value, exported: isExported, variable, usesLimit }];
  });
}

interface Exported {
  readonly values: Map<string, number | null>;
  /** How many sources outside the scope were parsed to find them. */
  readonly exporters: number;
}

const exportedByScan = new WeakMap<readonly SourceFile[], Exported>();

/**
 * Exported variables' values, for units such as `MiB` that a file in scope folds through an
 * import. Only the names a fold asks for are looked up, and only non-test apps/packages sources
 * that export one of them with `export const|let|var` are parsed.
 */
function exportedValues(files: readonly SourceFile[]): Exported {
  const cached = exportedByScan.get(files);
  if (cached !== undefined) return cached;
  const requested = new Set<string>();
  const record = {
    get: (name: string): undefined => {
      requested.add(name);
    },
  };
  for (const file of files.filter(({ path }) => inStorageScope(path))) {
    numericBindings(file, record);
  }
  const values = new Map<string, number | null>();
  const names = [...requested].map((name) => name.replaceAll('$', '\\$')).join('|');
  const exports = new RegExp(`\\bexport\\s+(?:const|let|var)\\s[^;]*?\\b(?:${names})\\b`, 'u');
  const exporters = files.filter(
    ({ path, text }) =>
      requested.size > 0 &&
      /^(?:apps|packages)\/.*\.m?ts$/u.test(path) &&
      !isTestCode(path) &&
      !path.endsWith('.d.ts') &&
      exports.test(text),
  );
  for (const file of exporters) {
    for (const { name, value, exported } of numericBindings(file)) {
      if (!exported || !requested.has(name)) continue;
      const seen = values.get(name);
      values.set(name, seen === undefined || seen === value ? value : null);
    }
  }
  const result = { values, exporters: exporters.length };
  exportedByScan.set(files, result);
  return result;
}

/**
 * How much of `files` a scan parses: the files in scope, and the exporters read for their imported
 * units. A guard that the scan stays bounded by the scope, not by the size of the repository.
 */
export function scanFootprint(files: readonly SourceFile[]): {
  inScope: number;
  exporters: number;
} {
  return {
    inScope: files.filter(({ path }) => inStorageScope(path)).length,
    exporters: exportedValues(files).exporters,
  };
}

const SPECIFIER = /\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/gu;
const EXTENSION = /\.(?:[cm]?[jt]sx?)$/u;

/** A test-support name: `fixtures.ts`, `*-fixtures.ts` or `*-fixture.ts`. */
const TEST_SUPPORT_NAME = /(?:^|\/|-)fixtures?\.ts$/u;

/** Everything under a package's `src/` compiles into its published dist. */
const PACKAGE_SOURCE = /^packages\/[^/]+\/src\//u;

/** Every file a `package.json` `exports` entry names, as a repository path. */
function exportTargets(files: readonly SourceFile[]): Set<string> {
  const targets = new Set<string>();
  const collect = (dir: string, entry: unknown): void => {
    if (typeof entry === 'string') targets.add(posix.normalize(dir + entry));
    else if (entry !== null && typeof entry === 'object') {
      for (const value of Object.values(entry)) collect(dir, value);
    }
  };
  for (const file of files) {
    if (!file.path.endsWith('package.json')) continue;
    let manifest: unknown;
    try {
      manifest = JSON.parse(file.text);
    } catch {
      continue;
    }
    if (manifest === null || typeof manifest !== 'object' || !('exports' in manifest)) continue;
    collect(file.path.slice(0, file.path.lastIndexOf('/') + 1), manifest.exports);
  }
  return targets;
}

/**
 * A test-support module ships nothing, so like a test file it cannot hold a copy of a limit (a
 * load test's memory bound is not one). It must be named as test support, sit outside every
 * package's `src/`, be no `package.json` export, and be imported by test code only. Being imported
 * only by tests is not enough on its own: a package entry point or a framework-loaded file often is.
 */
function isTestSupport(path: string, files: readonly SourceFile[], exports: Set<string>): boolean {
  return (
    TEST_SUPPORT_NAME.test(path) &&
    !PACKAGE_SOURCE.test(path) &&
    !exports.has(path) &&
    onlyTestsImport(path, files)
  );
}

/**
 * Some test code imports `path` and no other code does. A non-relative specifier whose last
 * segment names the module counts as a non-test importer, so a module a package export reaches
 * stays in scope.
 */
function onlyTestsImport(path: string, files: readonly SourceFile[]): boolean {
  const stem = path.replace(EXTENSION, '');
  const base = stem.slice(stem.lastIndexOf('/') + 1);
  let tests = 0;
  for (const file of files) {
    if (file.path === path || !file.text.includes(base)) continue;
    const dir = file.path.slice(0, file.path.lastIndexOf('/') + 1);
    for (const [, specifier = ''] of file.text.matchAll(SPECIFIER)) {
      const relative = specifier.startsWith('.');
      const target = relative
        ? posix.normalize(dir + specifier).replace(EXTENSION, '')
        : specifier.slice(specifier.lastIndexOf('/') + 1).replace(EXTENSION, '');
      if (target !== (relative ? stem : base)) continue;
      if (!isTestCode(file.path)) return false;
      tests += 1;
    }
  }
  return tests > 0;
}

/**
 * Constants in scope whose value equals a limit's bytes outside that limit's owner file.
 * Returns sorted, unique `path::NAME` keys.
 */
export function findLimitCopies(files: readonly SourceFile[]): string[] {
  const hits = new Set<string>();
  const exported = exportedValues(files).values;
  const exports = exportTargets(files);
  for (const file of files.filter(({ path }) => inStorageScope(path))) {
    const copies = numericBindings(file, exported).filter(
      ({ value, usesLimit }) =>
        !usesLimit && STORAGE_LIMITS.some((l) => l.bytes === value && l.owner !== file.path),
    );
    if (copies.length === 0 || isTestSupport(file.path, files, exports)) continue;
    for (const { name } of copies) hits.add(`${file.path}::${name}`);
  }
  return [...hits].sort();
}

/** `owner::NAME` for each limit whose owner file does not export that name with that value. */
export function findMissingOwners(files: readonly SourceFile[]): string[] {
  const exported = exportedValues(files).values;
  return STORAGE_LIMITS.filter((limit) => {
    const file = files.find(({ path }) => path === limit.owner);
    return !(
      file !== undefined &&
      numericBindings(file, exported).some(
        (c) => c.exported && c.variable && c.name === limit.name && c.value === limit.bytes,
      )
    );
  })
    .map((limit) => `${limit.owner}::${limit.name}`)
    .sort();
}
