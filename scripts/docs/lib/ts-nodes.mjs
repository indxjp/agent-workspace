/**
 * AST/checker helpers shared by the page renderers: enumerating a module's exports, rendering a
 * signature or a type as MDX-safe strings, walking a method body for the HTTP route it calls, and
 * turning an object type into a parameter/property table.
 */
import ts from 'typescript';

import { tsDocOf, mdxDoc } from './ts-doc.mjs';
import { table, typeCell } from './mdx.mjs';

/**
 * How the checker prints a type when the source carries no annotation to quote: never
 * truncated, and by an alias where the checker still knows one.
 */
export const TYPE_FORMAT =
  ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

/** @param {ts.Symbol} symbol */
function classifyExportSymbol(symbol) {
  if ((symbol.flags & ts.SymbolFlags.Function) !== 0) return 'function';
  if ((symbol.flags & ts.SymbolFlags.Class) !== 0) return 'class';
  if ((symbol.flags & ts.SymbolFlags.Interface) !== 0) return 'interface';
  if ((symbol.flags & ts.SymbolFlags.TypeAlias) !== 0) return 'type';
  return 'variable';
}

/**
 * @typedef {{
 *   readonly name: string,
 *   readonly node: ts.Node,
 *   readonly kind: 'function' | 'class' | 'interface' | 'type' | 'variable',
 *   readonly symbol: ts.Symbol,
 * }} ModuleExport
 */

/**
 * Every export of a module — including one re-exported from another file, resolved to its real
 * declaration — as `{ name, node, kind, symbol }`, sorted by name. `kind` is
 * `'function' | 'class' | 'interface' | 'type' | 'variable'`; `variable` is a `const`, and `node`
 * is its `VariableDeclaration`, so the initializer is one property away.
 * @param {ts.TypeChecker} checker @param {ts.SourceFile} sourceFile
 * @returns {readonly ModuleExport[]}
 */
export function moduleExports(checker, sourceFile) {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol === undefined) return [];
  /** @type {ModuleExport[]} */
  const entries = checker.getExportsOfModule(moduleSymbol).flatMap((exported) => {
    const symbol =
      (exported.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(exported) : exported;
    const node = symbol.valueDeclaration ?? symbol.declarations?.[0];
    // A re-exported package namespace (`export { z } from 'zod'`) is another package's reference.
    if (node === undefined || ts.isSourceFile(node)) return [];
    return [{ name: exported.getName(), node, kind: classifyExportSymbol(symbol), symbol }];
  });
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The class declaration exported (directly or via a named export elsewhere) by `name`.
 * @param {ts.TypeChecker} checker @param {ts.SourceFile} sourceFile @param {string} name
 * @returns {ts.ClassDeclaration | undefined}
 */
export function findExportedClass(checker, sourceFile, name) {
  for (const entry of moduleExports(checker, sourceFile)) {
    if (entry.kind === 'class' && entry.name === name && ts.isClassDeclaration(entry.node)) {
      return entry.node;
    }
  }
  return undefined;
}

/**
 * Public, non-constructor, non-private-named methods of a class, in declaration order.
 * @param {ts.ClassDeclaration} classNode @returns {readonly ts.MethodDeclaration[]}
 */
export function publicMethods(classNode) {
  return classNode.members.flatMap((member) => {
    if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) return [];
    const isPrivate = (member.modifiers ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword,
    );
    return isPrivate ? [] : [member];
  });
}

/**
 * Public readonly properties of a class typed as another class the generator also documents.
 * @param {ts.ClassDeclaration} classNode @returns {readonly ts.PropertyDeclaration[]}
 */
export function publicReadonlyProperties(classNode) {
  return classNode.members.flatMap((member) => {
    if (!ts.isPropertyDeclaration(member) || !ts.isIdentifier(member.name)) return [];
    // Public is the absence of `private`/`protected` and of a `#` name — `public` itself is
    // optional in TypeScript — and `readonly` is the modifier the name promises.
    const modifiers = member.modifiers ?? [];
    const isHidden = modifiers.some(
      (modifier) =>
        modifier.kind === ts.SyntaxKind.PrivateKeyword ||
        modifier.kind === ts.SyntaxKind.ProtectedKeyword,
    );
    const isReadonly = modifiers.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
    );
    return !isHidden && isReadonly && !member.name.text.startsWith('#') ? [member] : [];
  });
}

/**
 * `name(params): ReturnType`, each type as the source declares it (see `declaredTypeText`).
 * @param {ts.TypeChecker} checker @param {string} name @param {ts.SignatureDeclaration} node
 */
export function signatureText(checker, name, node) {
  const parameters = node.parameters
    .filter((parameter) => !ts.isIdentifier(parameter.name) || parameter.name.text !== 'this')
    .map((parameter) => {
      const optional = parameter.questionToken !== undefined || parameter.initializer !== undefined;
      return `${parameter.name.getText()}${optional ? '?' : ''}: ${parameterTypeText(checker, parameter)}`;
    });
  const isAsync =
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
  const isGenerator = ts.isMethodDeclaration(node) && node.asteriskToken !== undefined;
  const prefix = `${isAsync ? 'async ' : ''}${isGenerator ? '*' : ''}`;
  return `${prefix}${name}(${parameters.join(', ')}): ${returnTypeText(checker, node)}`;
}

/**
 * A type as the source declares it — the alias a consumer imports, `Promise<StartRunResponse>`
 * — falling back to the checker when there is no annotation. The checker alone would expand a
 * `z.infer` alias into the whole structure behind it, which is a screen of text per method.
 * @param {ts.TypeChecker} checker @param {ts.TypeNode | undefined} annotation @param {ts.Node} node @param {ts.Type} type
 */
function declaredTypeText(checker, annotation, node, type) {
  return annotation === undefined
    ? checker.typeToString(type, node, TYPE_FORMAT)
    : annotation.getText().replaceAll(/\s+/gu, ' ');
}

/** @param {ts.TypeChecker} checker @param {ts.ParameterDeclaration} parameter */
export function parameterTypeText(checker, parameter) {
  return declaredTypeText(checker, parameter.type, parameter, checker.getTypeAtLocation(parameter));
}

/** @param {ts.TypeChecker} checker @param {ts.SignatureDeclaration} node */
export function returnTypeText(checker, node) {
  const signature = checker.getSignatureFromDeclaration(node);
  const type =
    signature === undefined ? checker.getTypeAtLocation(node) : signature.getReturnType();
  return declaredTypeText(checker, node.type, node, type);
}

/**
 * A parameter table: name, type, required — no description column (the SDK carries none).
 * @param {ts.TypeChecker} checker @param {readonly ts.ParameterDeclaration[]} parameters
 */
export function parameterTable(checker, parameters) {
  const rows = parameters
    .filter((parameter) => !ts.isIdentifier(parameter.name) || parameter.name.text !== 'this')
    .map((parameter) => {
      const typeText = parameterTypeText(checker, parameter);
      const name = parameter.name.getText();
      const required = parameter.questionToken === undefined && parameter.initializer === undefined;
      return [`\`${name}\``, typeCell(typeText), required ? 'Yes' : 'No'];
    });
  return table(['Name', 'Type', 'Required'], rows);
}

/**
 * Recursively unwrap a call expression's first argument to find the identifier or expression a
 * path segment names, e.g. `segment(agentId)` → `agentId`, `segment(fileRouteId(path))` → `path`.
 * @param {ts.Expression} expression
 */
function paramNameFrom(expression) {
  if (ts.isCallExpression(expression)) {
    const firstArgument = expression.arguments[0];
    if (firstArgument !== undefined) return paramNameFrom(firstArgument);
  }
  return expression.getText();
}

/**
 * A template literal / string literal path as static text, `${…}` rendered as `:param`.
 * @param {ts.Expression} node @returns {string | null}
 */
function staticPathText(node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) {
      text += `:${paramNameFrom(span.expression)}${span.literal.text}`;
    }
    return text;
  }
  return null;
}

/**
 * @param {readonly ts.ObjectLiteralElementLike[]} properties @param {string} propertyName
 * @returns {ts.PropertyAssignment | undefined}
 */
function propertyAssignmentNamed(properties, propertyName) {
  for (const property of properties) {
    if (ts.isPropertyAssignment(property) && property.name.getText() === propertyName) {
      return property;
    }
  }
  return undefined;
}

/**
 * @typedef {{ readonly method: string, readonly path: string }} HttpRoute
 */

/**
 * Find the first `<expr>.json({...})` / `<expr>.send({...})` call directly inside a method body
 * (no recursion into nested function bodies) and read its literal `method`/`path`. `null` when no
 * such call is directly visible — the brief's "omit rather than guess".
 * @param {ts.Node} bodyNode @returns {HttpRoute | null}
 */
export function directHttpRoute(bodyNode) {
  /** @type {HttpRoute | null} */
  let found = null;
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (found !== null) return;
    if (ts.isFunctionLike(node) && node !== bodyNode) return; // do not descend into closures
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const calleeName = node.expression.name.text;
      const specArgument = node.arguments[0];
      if (
        (calleeName === 'json' || calleeName === 'send') &&
        specArgument !== undefined &&
        ts.isObjectLiteralExpression(specArgument)
      ) {
        const methodProperty = propertyAssignmentNamed(specArgument.properties, 'method');
        const pathProperty = propertyAssignmentNamed(specArgument.properties, 'path');
        if (
          methodProperty !== undefined &&
          ts.isStringLiteralLike(methodProperty.initializer) &&
          pathProperty !== undefined
        ) {
          const path = staticPathText(pathProperty.initializer);
          if (path !== null) found = { method: methodProperty.initializer.text, path };
        }
      }
    }
    if (found === null) ts.forEachChild(node, visit);
  };
  ts.forEachChild(bodyNode, visit);
  return found;
}

export { tsDocOf, mdxDoc };
