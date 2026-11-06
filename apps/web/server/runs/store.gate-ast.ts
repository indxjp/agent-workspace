/**
 * Syntax-tree readers for the in-memory store gate (`store.in-memory-gate.test.ts`): what a call
 * site is handed, and whether the file that contains it binds the thing being called.
 */
import ts from 'typescript';

/** One expression with the wrappers that do not change what it denotes taken off. */
const unwrapExpression = (node: ts.Expression | undefined): ts.Expression | undefined => {
  let current = node;
  for (;;) {
    if (current === undefined) return undefined;
    if (ts.isParenthesizedExpression(current)) current = current.expression;
    else if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.CommaToken
    ) {
      // `(0, require)` denotes its right operand: the callee IS `require`, spelled around a
      // comma. Unwrapping is why closing this shape needed no new callee name.
      current = current.right;
    } else if (
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
    } else return current;
  }
};

/** The identifier a callee is rooted at: `globalThis` in `globalThis.require`. */
export const calleeRootName = (callee: ts.Expression): string | null => {
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
};

export interface FileBindings {
  readonly declared: ReadonlySet<string>;
  readonly aliased: ReadonlySet<string>;
  readonly constants: ReadonlyMap<string, string>;
}

/** Every name a binding pattern or identifier declares. */
function declaredNames(name: ts.Node | undefined): string[] {
  if (name === undefined) return [];
  if (ts.isIdentifier(name)) return [name.text];
  if (!ts.isObjectBindingPattern(name) && !ts.isArrayBindingPattern(name)) return [];
  return name.elements.flatMap((element) =>
    ts.isBindingElement(element) ? declaredNames(element.name) : [],
  );
}

/** The node kinds that declare a name through their `name` property. */
const declaresByName = (node: ts.Node): node is ts.NamedDeclaration =>
  ts.isParameter(node) ||
  ts.isBindingElement(node) ||
  ts.isImportClause(node) ||
  ts.isNamespaceImport(node) ||
  ts.isImportSpecifier(node) ||
  ts.isFunctionDeclaration(node) ||
  ts.isClassDeclaration(node) ||
  ts.isEnumDeclaration(node) ||
  ts.isModuleDeclaration(node) ||
  ts.isImportEqualsDeclaration(node);

/**
 * Every identifier one file binds, which of them are bound straight to another reference, and
 * which to a string literal.
 *
 * Not a scope model, and not an answer to "what is in scope". It answers the one question the
 * call classifier asks: *can this gate see where the thing being called was made?* A callee
 * rooted at a name the file declares is a value this file produced; a callee rooted at a free
 * name — `require` in a CommonJS module, `globalThis`, `process`, `eval` — came from somewhere
 * the walk cannot look; and a name bound straight to another reference is not vouched for, which
 * is what `const load = require;` turns on. A name declared anywhere in the file vouches for
 * every use of it, which errs towards passing a call, and that is stated rather than discovered.
 */
export function bindingsIn(source: ts.SourceFile): FileBindings {
  const declared = new Set<string>();
  const aliased = new Set<string>();
  const constants = new Map<string, string>();

  const recordVariable = (node: ts.VariableDeclaration): void => {
    for (const name of declaredNames(node.name)) declared.add(name);
    const initializer = unwrapExpression(node.initializer);
    if (initializer === undefined || !ts.isIdentifier(node.name)) return;
    if (ts.isStringLiteralLike(initializer)) {
      constants.set(node.name.text, initializer.text);
    } else if (
      ts.isIdentifier(initializer) ||
      ts.isPropertyAccessExpression(initializer) ||
      ts.isElementAccessExpression(initializer)
    ) {
      aliased.add(node.name.text);
    }
  };

  const walk = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) recordVariable(node);
    else if (declaresByName(node)) {
      for (const name of declaredNames(node.name)) declared.add(name);
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return { declared, aliased, constants };
}

/**
 * Every string this gate can read at one call site: literal arguments, names bound to a literal
 * in this file, and the elements of an array literal handed in — `Reflect.apply(fn, null, ['…'])`
 * and `fn(...['…'])` write the specifier out at the call site all the same.
 */
export const stringsHandedTo = (
  call: ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression,
  constants: ReadonlyMap<string, string>,
): readonly string[] => {
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
};

/** One call site as written, collapsed onto a line, for a failure message to name it by. */
export const snippet = (node: ts.Node): string => {
  const text = node.getText().replace(/\s+/gu, ' ').trim();
  return text.length > 72 ? `${text.slice(0, 69)}...` : text;
};

/** Does this module name the environment variable the acceptance harness will not run without? */
export const namesTheHarnessVariable = (source: ts.SourceFile): boolean => {
  let found = false;
  const walk = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) && node.text === 'AW_ACCEPTANCE_HARNESS') found = true;
    ts.forEachChild(node, walk);
  };
  walk(source);
  return found;
};
