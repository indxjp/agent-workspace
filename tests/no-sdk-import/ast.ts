import path from 'node:path';

import ts from 'typescript';

/** Which `ts.ScriptKind` a file's extension is parsed as, so JSX and TSX both parse. */
export function scriptKindFor(file: string): ts.ScriptKind {
  switch (path.extname(file).toLowerCase()) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

/**
 * The dotted name of a callee, or `null` when it is not a plain chain of identifiers.
 *
 * `null` is the answer for `createRequire(u).resolve` and anything else computed, which keeps a
 * dotted resolver from being half-recognised: the caller falls through to the `createRequire`
 * rules or to nothing, rather than matching `require.resolve` on a coincidence.
 */
export function dottedName(node: ts.Node): string | null {
  if (node.kind === ts.SyntaxKind.ImportKeyword) return 'import';
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isMetaProperty(node)) {
    const keyword = node.keywordToken === ts.SyntaxKind.ImportKeyword ? 'import' : 'new';
    return `${keyword}.${node.name.text}`;
  }
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
    const base = dottedName(node.expression);
    return base === null ? null : `${base}.${node.name.text}`;
  }
  return null;
}

/** The cooked text of a plain string literal, or `null` for anything computed. */
export function literalText(node: ts.Node | undefined): string | null {
  if (node === undefined) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/**
 * `parseDiagnostics` is where the parser records syntax it could not read, and it is not in
 * TypeScript's public type. It is read anyway, because the alternative is a gate that reports no
 * references out of a file it could not parse and calls that a pass. Its absence is itself a
 * refusal, and a control plants a real syntax error, so this cannot rot into a property that is
 * always `undefined` and always ignored.
 */
export type ParsedSourceFile = ts.SourceFile & {
  readonly parseDiagnostics?: readonly ts.Diagnostic[];
};

/** Nodes the callee-root walk looks through: they change nothing about where a value came from. */
function isTransparentWrapper(node: ts.Node): node is ts.Node & { expression: ts.Node } {
  return (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    ts.isCallExpression(node) ||
    ts.isNewExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAwaitExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  );
}

/**
 * The identifier a callee expression is **rooted** at, or `null` when there is not one.
 *
 * Where {@link dottedName} asks "what is this callee called", this asks the only question the
 * call-site classifier can answer soundly: "where did the value being called come from?" It walks
 * left through property and element access, calls and the wrappers that change nothing (`(…)`,
 * `!`, `as`, `satisfies`) until it reaches a name or something that is not one. So
 * `expect(x).toBe` roots at `expect`, `require['main']['require']` at `require`, and
 * `(0, require)` at nothing at all, the answer that matters: a callee this function cannot root
 * is one the classifier cannot vouch for.
 */
export function calleeRoot(node: ts.Node): string | null {
  let current: ts.Node = node;
  for (;;) {
    if (ts.isIdentifier(current)) return current.text;
    if (ts.isTaggedTemplateExpression(current)) {
      current = current.tag;
    } else if (isTransparentWrapper(current)) {
      current = current.expression;
    } else {
      return null;
    }
  }
}

/**
 * What a source file binds, read once per file and used by the call-site classifier.
 *
 *   * `declared`: every name the file introduces (variable, binding element, parameter, function
 *     or class name, import binding, catch variable). A callee rooted at one is a value the file
 *     made, and the walk sees the code that made it.
 *   * `aliased`: the subset bound to a **bare name or a property chain**. `const load = require;`
 *     is the case that forced this: `load` holds whatever that other name held, which this gate
 *     cannot follow, so declared-and-aliased is not vouched for.
 *   * `constants`: names bound exactly once, by `const`, to a string literal: the one step of
 *     value-tracking this gate does, so lifting a specifier into a variable is not a way past.
 *
 * Names are collected over the **whole file**, not per scope. A name bound twice is dropped from
 * `constants` rather than guessed at, and a callee rooted at a name bound anywhere is vouched for
 * even where that binding is out of scope; that limit is demonstrated in the reach tests.
 */
export type FileBindings = {
  readonly declared: ReadonlySet<string>;
  readonly aliased: ReadonlySet<string>;
  readonly constants: ReadonlyMap<string, string>;
};

type BindingState = {
  readonly declared: Set<string>;
  readonly aliased: Set<string>;
  readonly constants: Map<string, string>;
  readonly notConstant: Set<string>;
};

function isConstDeclaration(node: ts.VariableDeclaration): boolean {
  const list = node.parent;
  return ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
}

function recordVariable(
  node: ts.VariableDeclaration,
  name: ts.Identifier,
  state: BindingState,
): void {
  state.declared.add(name.text);
  const initializer = node.initializer;
  if (
    initializer !== undefined &&
    (ts.isIdentifier(initializer) ||
      ts.isPropertyAccessExpression(initializer) ||
      ts.isElementAccessExpression(initializer))
  ) {
    state.aliased.add(name.text);
  }
  const literal = literalText(initializer);
  if (literal !== null && isConstDeclaration(node) && !state.constants.has(name.text)) {
    state.constants.set(name.text, literal);
  } else {
    state.notConstant.add(name.text);
  }
}

/** A name that is bound but never trusted as a constant. */
function recordNonConstant(name: ts.Node | undefined, state: BindingState): void {
  if (name === undefined || !ts.isIdentifier(name)) return;
  state.declared.add(name.text);
  state.notConstant.add(name.text);
}

function recordBinding(node: ts.Node, state: BindingState): void {
  if (ts.isVariableDeclaration(node)) {
    if (ts.isIdentifier(node.name)) recordVariable(node, node.name, state);
  } else if (ts.isBindingElement(node) || ts.isParameter(node)) {
    recordNonConstant(node.name, state);
  } else if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node) ||
    ts.isImportSpecifier(node) ||
    ts.isNamespaceImport(node) ||
    ts.isImportEqualsDeclaration(node) ||
    ts.isImportClause(node)
  ) {
    recordNonConstant(node.name, state);
  } else if (ts.isCatchClause(node)) {
    const name = node.variableDeclaration?.name;
    if (name !== undefined && ts.isIdentifier(name)) state.declared.add(name.text);
  }
}

export function fileBindings(sourceFile: ts.SourceFile): FileBindings {
  const state: BindingState = {
    declared: new Set(),
    aliased: new Set(),
    constants: new Map(),
    notConstant: new Set(),
  };
  const walk = (node: ts.Node): void => {
    recordBinding(node, state);
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
  for (const name of state.notConstant) state.constants.delete(name);
  return { declared: state.declared, aliased: state.aliased, constants: state.constants };
}
