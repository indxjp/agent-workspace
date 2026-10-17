/**
 * A class's own public property declarations as a name/type/required/doc table — used for
 * `ClientOptions`-shaped classes on `reference/sdk/client.mdx`: the four error classes and (should
 * a family ever need it) any other class documented by its public surface rather than its methods.
 */
import ts from 'typescript';

import { TYPE_FORMAT } from './ts-nodes.mjs';
import { tsDocOf } from './ts-doc.mjs';
import { table, typeCell, mdxTableCell } from './mdx.mjs';

/** @param {ts.TypeChecker} checker @param {ts.PropertyDeclaration} member */
function propertyRow(checker, member) {
  const type = checker.getTypeAtLocation(member);
  const typeText = checker.typeToString(type, member, TYPE_FORMAT);
  return [`\`${member.name.getText()}\``, typeCell(typeText), 'Yes', mdxTableCell(tsDocOf(member))];
}

/** @param {ts.ClassElement} member */
function isPublicProperty(member) {
  if (!ts.isPropertyDeclaration(member) || !ts.isIdentifier(member.name)) return false;
  const modifiers = member.modifiers ?? [];
  const isPrivateField = member.name.text.startsWith('#');
  const hasPrivateModifier = modifiers.some(
    (modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword,
  );
  return !isPrivateField && !hasPrivateModifier;
}

/** @param {ts.TypeChecker} checker @param {ts.ClassDeclaration} classNode */
export function classPropertyTable(checker, classNode) {
  const rows = classNode.members.flatMap((member) => {
    if (!isPublicProperty(member) || !ts.isPropertyDeclaration(member)) return [];
    return [propertyRow(checker, member)];
  });
  return table(['Name', 'Type', 'Required', 'Description'], rows);
}
