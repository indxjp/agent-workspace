import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { repoRoot } from './database-reachability-manifest.test-support.js';

// Free or aliased callees are unvouched. Scope is deliberately file-wide; computed strings
// and values arriving through parameters remain outside this static check's reach.
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
export interface UnvouchedCall {
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

export const COMPUTED_IMPORT_DECISIONS: ReadonlyMap<string, string> = new Map([
  [
    'packages/aw/src/tools/host-child.ts',
    "imports the developer's own run files by path; decided in ADR-0115",
  ],
]);

function parseModule(relative: string): ts.SourceFile {
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

  return source;
}

function requiredCallSpecifier(
  node: ts.CallExpression,
  relative: string,
  kind: string,
): string | undefined {
  const argument = node.arguments[0];
  if (argument !== undefined && ts.isStringLiteralLike(argument)) {
    return argument.text;
  }
  // A decided exception (ADR-0115), for the one file and one kind it names; see below.
  if (kind === 'a dynamic import' && COMPUTED_IMPORT_DECISIONS.has(relative)) return;
  throw new Error(
    `${relative} calls ${kind} with an argument that is not a string literal, so this gate ` +
      'cannot tell which module it names. Write the specifier as a literal, or decide what a ' +
      'computed one means here; do not leave it unread.',
  );
}

interface CallReadContext {
  readonly relative: string;
  readonly bindings: Bindings;
  readonly specifiers: string[];
  readonly unvouched: UnvouchedCall[];
}

function readCall(
  node: ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression,
  context: CallReadContext,
): void {
  const callee = ts.isTaggedTemplateExpression(node) ? node.tag : node.expression;
  const isDynamicImport = ts.isCallExpression(node) && callee.kind === ts.SyntaxKind.ImportKeyword;
  const isRequire =
    ts.isCallExpression(node) && ts.isIdentifier(callee) && callee.text === 'require';
  if (ts.isCallExpression(node) && (isDynamicImport || isRequire)) {
    const specifier = requiredCallSpecifier(
      node,
      context.relative,
      isDynamicImport ? 'a dynamic import' : 'require',
    );
    if (specifier !== undefined) context.specifiers.push(specifier);
    return;
  }
  // A construction can load a module even when the constructor is locally bound.
  const root = ts.isCallExpression(node) ? calleeRootName(callee) : null;
  const vouched =
    root !== null && context.bindings.declared.has(root) && !context.bindings.aliased.has(root);
  if (vouched) return;
  context.unvouched.push({
    construct: snippet(callee),
    candidates: stringsHandedTo(node, context.bindings.constants),
  });
}

export function specifiersIn(relative: string): ReadModule {
  const parsed = parseModule(relative);
  const found: string[] = [];
  const literal = (node: ts.Node | undefined): void => {
    if (node !== undefined && ts.isStringLiteralLike(node)) found.push(node.text);
  };

  const bindings = bindingsIn(parsed);
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
      readCall(node, { relative, bindings, specifiers: found, unvouched });
    }
    ts.forEachChild(node, walk);
  };
  walk(parsed);
  return { specifiers: found, unvouched };
}
