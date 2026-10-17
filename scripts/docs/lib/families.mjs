/**
 * `AgentWorkspaceClient`'s own property list (`packages/sdk/src/index.ts`) is the single source of
 * truth for which 14 families exist, their declaration order, and which class each one is —
 * everything else (the family's `.mdx` file name, its `resources/<family>.ts` source) follows the
 * property's own name.
 */
import ts from 'typescript';

import { TYPE_FORMAT } from './ts-nodes.mjs';

/** @param {ts.SourceFile} sourceFile @returns {ts.InterfaceDeclaration | undefined} */
function findAgentWorkspaceClientInterface(sourceFile) {
  for (const statement of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(statement) && statement.name.text === 'AgentWorkspaceClient') {
      return statement;
    }
  }
  return undefined;
}

/** @param {ts.TypeChecker} checker @param {ts.PropertySignature} member */
function familyOf(checker, member) {
  const property = member.name.getText();
  const type = member.type;
  const className =
    type !== undefined && ts.isTypeReferenceNode(type)
      ? type.typeName.getText()
      : checker.typeToString(checker.getTypeAtLocation(member), member, TYPE_FORMAT);
  return { property, className };
}

/**
 * The interface's method signatures — operations that belong to no family, such as `me()`.
 *
 * Kept beside {@link familyClientNames} because the two partition the same member list: a
 * property is a family and gets a page, a method is an operation and gets a section on
 * `reference/sdk/client.mdx`. `render-client.mjs` renders these.
 * @param {ts.SourceFile} indexFile @returns {readonly ts.MethodSignature[]}
 */
export function rootClientMethods(indexFile) {
  const clientInterface = findAgentWorkspaceClientInterface(indexFile);
  if (clientInterface === undefined) {
    throw new Error('AgentWorkspaceClient interface was not found in sdk/src/index.ts');
  }
  return clientInterface.members.filter((member) => ts.isMethodSignature(member));
}

/**
 * @param {ts.TypeChecker} checker @param {ts.SourceFile} indexFile
 * @returns {readonly { readonly property: string, readonly className: string }[]}
 */
export function familyClientNames(checker, indexFile) {
  const clientInterface = findAgentWorkspaceClientInterface(indexFile);
  if (clientInterface === undefined) {
    throw new Error('AgentWorkspaceClient interface was not found in sdk/src/index.ts');
  }
  return clientInterface.members.flatMap((member) => {
    if (ts.isPropertySignature(member)) return [familyOf(checker, member)];
    // The rejecting `else`, and the reason this is not a bare `flatMap → []`. A member kind this
    // function does not understand used to be dropped in silence: `me()` was added as a method
    // signature, contributed no page — correctly — and would equally have contributed no page if
    // it had been a *family* written in a spelling this reader could not see. A method is skipped
    // by name, because `rootClientMethods` above renders it; anything else fails loudly.
    if (ts.isMethodSignature(member)) return [];
    throw new Error(
      `AgentWorkspaceClient has a member this reader cannot classify ` +
        `(${ts.SyntaxKind[member.kind]}: ${member.getText()}). A family is a property and an ` +
        `operation is a method signature; anything else would be dropped from the generated ` +
        `reference without a word, so it is refused instead.`,
    );
  });
}
