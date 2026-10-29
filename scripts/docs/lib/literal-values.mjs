/**
 * Rendering a plain (non-Zod) literal `const` initializer — an array of literal members, an
 * object of key/value pairs, or a single scalar — shared by the contracts renderer (`D`) and the
 * CLI renderer's `EXIT_CODE` table (`E`).
 */
import ts from 'typescript';

import { inlineCode, table, typeCell } from './mdx.mjs';

/**
 * Unwrap `as const` / `satisfies` / parentheses to the literal expression underneath.
 * @param {ts.Expression} expression
 */
export function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** @param {string} text */
function collapse(text) {
  return text.replaceAll(/\s+/gu, ' ');
}

/** @param {ts.ArrayLiteralExpression} literal */
export function renderArrayLiteral(literal) {
  return literal.elements
    .map((element) => `- ${inlineCode(collapse(element.getText()))}`)
    .join('\n');
}

/**
 * @param {ts.ObjectLiteralExpression} literal @param {readonly [string, string]} headers
 */
export function renderObjectLiteral(literal, headers = ['Key', 'Value']) {
  const rows = literal.properties.flatMap((property) => {
    if (!ts.isPropertyAssignment(property)) return [];
    return [
      [inlineCode(property.name.getText()), typeCell(collapse(property.initializer.getText()))],
    ];
  });
  return table(headers, rows);
}

/** @param {ts.Node} node */
function isConstDeclaration(node) {
  return (
    ts.isVariableDeclaration(node) &&
    ts.isVariableDeclarationList(node.parent) &&
    (node.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

/**
 * The value of a constant expression: number, string and boolean literals, numeric arithmetic,
 * string concatenation, and names of `const` declarations (followed through imports), or
 * `undefined` when any part is not constant.
 * @param {ts.TypeChecker} checker @param {ts.Expression} expression @param {Set<ts.Node>} seen
 * @returns {number | string | boolean | undefined}
 */
function constantValue(checker, expression, seen) {
  const node = unwrapExpression(expression);
  if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll('_', ''));
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const operand = constantValue(checker, node.operand, seen);
    return typeof operand === 'number' ? -operand : undefined;
  }
  if (ts.isIdentifier(node)) {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    const declaration = symbol?.valueDeclaration;
    if (declaration === undefined || !isConstDeclaration(declaration) || seen.has(declaration)) {
      return undefined;
    }
    const { initializer } = /** @type {ts.VariableDeclaration} */ (declaration);
    if (initializer === undefined) return undefined;
    seen.add(declaration);
    const value = constantValue(checker, initializer, seen);
    seen.delete(declaration);
    return value;
  }
  if (!ts.isBinaryExpression(node)) return undefined;
  const left = constantValue(checker, node.left, seen);
  const right = constantValue(checker, node.right, seen);
  if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    if (typeof left === 'string' && (typeof right === 'string' || typeof right === 'number')) {
      return left + right;
    }
    if (typeof left === 'number' && typeof right === 'string') return left + right;
  }
  if (typeof left !== 'number' || typeof right !== 'number') return undefined;
  switch (node.operatorToken.kind) {
    case ts.SyntaxKind.PlusToken:
      return left + right;
    case ts.SyntaxKind.MinusToken:
      return left - right;
    case ts.SyntaxKind.AsteriskToken:
      return left * right;
    case ts.SyntaxKind.SlashToken:
      return left / right;
    case ts.SyntaxKind.AsteriskAsteriskToken:
      return left ** right;
    case ts.SyntaxKind.LessThanLessThanToken:
      return left * 2 ** right;
    default:
      return undefined;
  }
}

/**
 * The literal a name stands for, as source text (`10485760`, `'aw-control'`): the value its
 * `const` declaration folds to, else its type when that is a single number, string or boolean
 * literal, else `null`.
 * @param {ts.TypeChecker} checker @param {ts.Expression} expression
 */
export function resolvedLiteral(checker, expression) {
  const value = constantValue(checker, expression, new Set());
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return `'${value}'`;
  const type = checker.getTypeAtLocation(expression);
  if (type.isNumberLiteral()) return String(type.value);
  if (type.isStringLiteral()) return `'${type.value}'`;
  if (type.flags & ts.TypeFlags.BooleanLiteral) return checker.typeToString(type);
  return null;
}

/**
 * A scalar initializer as written. One that only names another constant also shows the value that
 * name resolves to, so the page never shows a bare name a reader has to look up.
 * @param {ts.Expression} expression @param {ts.TypeChecker} [checker]
 */
export function renderScalar(expression, checker) {
  const written = `Value: ${inlineCode(collapse(expression.getText()))}`;
  if (checker === undefined || !ts.isIdentifier(expression)) return written;
  const value = resolvedLiteral(checker, expression);
  return value === null ? written : `${written} (${inlineCode(value)})`;
}

/**
 * An array, object, or scalar `const` initializer, rendered generically.
 * @param {ts.Expression} expression @param {ts.TypeChecker} [checker]
 */
export function renderLiteralConst(expression, checker) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isArrayLiteralExpression(unwrapped)) return renderArrayLiteral(unwrapped);
  if (ts.isObjectLiteralExpression(unwrapped)) return renderObjectLiteral(unwrapped);
  return renderScalar(unwrapped, checker);
}
