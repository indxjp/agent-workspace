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

/** @param {ts.Expression} expression */
export function renderScalar(expression) {
  return `Value: ${inlineCode(collapse(expression.getText()))}`;
}

/**
 * An array, object, or scalar `const` initializer, rendered generically.
 * @param {ts.Expression} expression
 */
export function renderLiteralConst(expression) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isArrayLiteralExpression(unwrapped)) return renderArrayLiteral(unwrapped);
  if (ts.isObjectLiteralExpression(unwrapped)) return renderObjectLiteral(unwrapped);
  return renderScalar(unwrapped);
}
