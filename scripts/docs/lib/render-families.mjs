/**
 * `reference/sdk/<family>.mdx` (brief §B) — one page per `AgentWorkspaceClient` family, covering
 * the family's own class and every nested client reachable through its public readonly properties.
 */
import ts from 'typescript';

import { pageHeader, finalizePage, codeBlock } from './mdx.mjs';
import {
  mdxDoc,
  returnTypeText,
  signatureText,
  findExportedClass,
  publicMethods,
  publicReadonlyProperties,
  parameterTable,
  directHttpRoute,
  moduleExports,
} from './ts-nodes.mjs';
import { renderTypeSection } from './type-render.mjs';

/**
 * Depth-first: a class's own methods, then each nested client's, dotted-path prefixed.
 * @param {ts.TypeChecker} checker @param {ts.ClassDeclaration} classNode @param {string} prefix
 * @param {Set<ts.ClassDeclaration>} [seen]
 * @returns {readonly { readonly path: string, readonly method: ts.MethodDeclaration }[]}
 */
function collectMethodSections(checker, classNode, prefix, seen = new Set()) {
  if (seen.has(classNode)) return []; // defends against an accidental cycle; none exists today
  seen.add(classNode);
  const sections = publicMethods(classNode).map((method) => ({
    path: `${prefix}${method.name.getText()}`,
    method,
  }));
  for (const property of publicReadonlyProperties(classNode)) {
    const typeNode = property.type;
    if (typeNode === undefined || !ts.isTypeReferenceNode(typeNode)) continue;
    const nestedClass = findExportedClass(
      checker,
      classNode.getSourceFile(),
      typeNode.typeName.getText(),
    );
    if (nestedClass === undefined) continue;
    const nestedPrefix = `${prefix}${property.name.getText()}.`;
    sections.push(...collectMethodSections(checker, nestedClass, nestedPrefix, seen));
  }
  return sections;
}

/** @param {ts.TypeChecker} checker @param {string} path @param {ts.MethodDeclaration} method */
function renderMethodSection(checker, path, method) {
  const name = method.name.getText();
  const signature = signatureText(checker, name, method);
  const returnType = returnTypeText(checker, method);
  const route = directHttpRoute(method.body ?? method);
  const parts = [
    `## ${path}`,
    '',
    mdxDoc(method),
    '',
    codeBlock('ts', signature),
    '',
    parameterTable(checker, method.parameters),
    '',
    `**Returns:** \`${returnType}\``,
  ];
  if (route !== null) parts.push('', `**Route:** \`${route.method} ${route.path}\``);
  return parts.join('\n');
}

/**
 * `## <Name>` for every interface/type the family module exports besides its client classes.
 * @param {ts.TypeChecker} checker @param {ts.SourceFile} sourceFile
 */
function renderOptionInterfaces(checker, sourceFile) {
  return moduleExports(checker, sourceFile)
    .filter((entry) => entry.kind === 'interface' || entry.kind === 'type')
    .map((entry) => {
      const type = checker.getTypeAtLocation(entry.node);
      return [
        `## ${entry.name}`,
        '',
        mdxDoc(entry.node),
        '',
        renderTypeSection(checker, type, entry.node),
      ].join('\n\n');
    })
    .join('\n\n');
}

/**
 * @param {ts.TypeChecker} checker @param {{ readonly property: string, readonly className: string }} family
 * @param {ts.SourceFile} sourceFile
 */
export function renderFamilyPage(checker, family, sourceFile) {
  const rootClass = findExportedClass(checker, sourceFile, family.className);
  if (rootClass === undefined) {
    throw new Error(`class ${family.className} was not found in ${sourceFile.fileName}`);
  }
  const sections = collectMethodSections(checker, rootClass, '');
  const methodMarkdown = sections
    .map((section) => renderMethodSection(checker, section.path, section.method))
    .join('\n\n');
  const optionMarkdown = renderOptionInterfaces(checker, sourceFile);
  const header = pageHeader({
    title: family.className,
    description: `Every method of ${family.className}, its parameters, return type, and route.`,
    sources: [`packages/sdk/src/resources/${family.property}.ts`],
  });
  const body = [mdxDoc(rootClass), methodMarkdown, optionMarkdown]
    .filter((part) => part !== '')
    .join('\n\n');
  return finalizePage(`${header}\n${body}`);
}
