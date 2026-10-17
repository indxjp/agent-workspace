/**
 * Best-effort recovery of the `z.object({...})` shape literal behind a schema constant, so its
 * per-property TSDoc comments can be attached to the property table `renderTypeSection` builds
 * from the checker's resolved `z.infer` type. Not every schema is built this way (`z.union`,
 * `z.discriminatedUnion`, `Other.nullable()`) — those simply carry no per-property doc overrides.
 */
import ts from 'typescript';

import { tsDocOf } from './ts-doc.mjs';

/**
 * Whether `type` is a Zod schema instance: it has both `parse` and `safeParse` members.
 * @param {ts.Type} type
 */
export function isZodSchemaType(type) {
  return type.getProperty('parse') !== undefined && type.getProperty('safeParse') !== undefined;
}

/**
 * @param {string} name @param {ts.SourceFile} sourceFile
 * @returns {ts.Expression | undefined}
 */
function localConstInitializer(name, sourceFile) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer !== undefined
      ) {
        return declaration.initializer;
      }
    }
  }
  return undefined;
}

/**
 * Walk a schema initializer expression — through `.strict()`/`.readonly()`/… method chains and
 * through a reference to a locally declared shape object — to the `z.object({...})` argument's
 * object literal, or `null` when the schema is not built directly from one.
 * @param {ts.Expression} expression @param {ts.SourceFile} sourceFile @param {Set<string>} seen
 * @returns {ts.ObjectLiteralExpression | null}
 */
export function findShapeObjectLiteral(expression, sourceFile, seen = new Set()) {
  if (ts.isObjectLiteralExpression(expression)) return expression;
  if (ts.isIdentifier(expression)) {
    if (seen.has(expression.text)) return null;
    seen.add(expression.text);
    const initializer = localConstInitializer(expression.text, sourceFile);
    return initializer === undefined ? null : findShapeObjectLiteral(initializer, sourceFile, seen);
  }
  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
    const shapeArgument = expression.arguments[0];
    if (expression.expression.name.text === 'object' && shapeArgument !== undefined) {
      return findShapeObjectLiteral(shapeArgument, sourceFile, seen);
    }
    return findShapeObjectLiteral(expression.expression.expression, sourceFile, seen);
  }
  return null;
}

/**
 * Property name → TSDoc, for every top-level property of a `z.object({...})` shape literal.
 * @param {ts.ObjectLiteralExpression} objectLiteral
 */
export function shapeDocMap(objectLiteral) {
  /** @type {Map<string, string>} */
  const docs = new Map();
  for (const property of objectLiteral.properties) {
    if (property.name === undefined || !ts.isIdentifier(property.name)) continue;
    const doc = tsDocOf(property);
    if (doc !== '') docs.set(property.name.text, doc);
  }
  return docs;
}
