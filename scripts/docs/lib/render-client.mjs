/**
 * `reference/sdk/client.mdx` (brief §A) — `createClient`, `AgentWorkspaceClient`, `ClientOptions`,
 * `RequestOptions`, `ClientAuth`, and every SDK error class, from `packages/sdk/src/index.ts`,
 * `http.ts` and `errors.ts`.
 */
import ts from 'typescript';

import { pageHeader, finalizePage, table, typeCell } from './mdx.mjs';
import { classPropertyTable } from './class-props.mjs';
import { rootClientMethods } from './families.mjs';
import { TYPE_FORMAT, mdxDoc, signatureText, moduleExports } from './ts-nodes.mjs';
import { renderTypeSection } from './type-render.mjs';

/** @param {ts.SourceFile} sourceFile @param {string} name @returns {ts.InterfaceDeclaration} */
function findInterface(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(statement) && statement.name.text === name) return statement;
  }
  throw new Error(`interface ${name} was not found in ${sourceFile.fileName}`);
}

/** @param {ts.SourceFile} sourceFile @param {string} name @returns {ts.TypeAliasDeclaration} */
function findTypeAlias(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (ts.isTypeAliasDeclaration(statement) && statement.name.text === name) return statement;
  }
  throw new Error(`type alias ${name} was not found in ${sourceFile.fileName}`);
}

/** @param {ts.SourceFile} sourceFile @param {string} name @returns {ts.FunctionDeclaration} */
function findFunction(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
  }
  throw new Error(`function ${name} was not found in ${sourceFile.fileName}`);
}

/** @param {ts.TypeChecker} checker @param {ts.PropertySignature} member */
function familyRow(checker, member) {
  const name = member.name.getText();
  const type = checker.typeToString(checker.getTypeAtLocation(member), member, TYPE_FORMAT);
  return [`[\`${name}\`](/reference/sdk/${name})`, typeCell(type)];
}

/**
 * `## createClient` and `## AgentWorkspaceClient` (the family table), from `sdk/src/index.ts`.
 * @param {ts.TypeChecker} checker @param {ts.SourceFile} indexFile
 */
function renderIndexSections(checker, indexFile) {
  const createClientFn = findFunction(indexFile, 'createClient');
  const createClientSection = [
    '## createClient',
    '',
    mdxDoc(createClientFn),
    '',
    `\`\`\`ts\n${signatureText(checker, 'createClient', createClientFn)}\n\`\`\``,
  ].join('\n');

  const clientInterface = findInterface(indexFile, 'AgentWorkspaceClient');
  // Declaration order is the order `createClient` builds the object in, which is also the site's
  // navigation order for `resources/*.mdx` — kept as-is rather than sorted alphabetically.
  const familyRows = clientInterface.members.flatMap((member) =>
    ts.isPropertySignature(member) ? [familyRow(checker, member)] : [],
  );
  const clientSection = [
    '## AgentWorkspaceClient',
    '',
    mdxDoc(clientInterface),
    '',
    'One property per resource family.',
    '',
    table(['Family', 'Type'], familyRows),
  ].join('\n');

  // The interface's own operations — the ones that belong to no family, such as `me()`. A method
  // signature contributes no `reference/sdk/<family>.mdx` page, because there is no client class
  // behind it; without this section it would be absent from the generated reference altogether
  // while every other gate stayed green. Declaration order, like the family table above.
  const methods = rootClientMethods(indexFile);
  const methodSections = methods.map((method) => {
    const name = method.name.getText();
    return [
      `#### ${name}`,
      '',
      mdxDoc(method),
      '',
      `\`\`\`ts\n${signatureText(checker, name, method)}\n\`\`\``,
    ].join('\n');
  });
  const methodsSection =
    methods.length === 0
      ? ''
      : [
          '',
          '',
          '### Methods',
          '',
          'Operations on the client itself, belonging to no resource family.',
          '',
          methodSections.join('\n\n'),
        ].join('\n');

  return `${createClientSection}\n\n${clientSection}${methodsSection}`;
}

/**
 * `## ClientOptions` and `## RequestOptions`, from `sdk/src/http.ts`.
 * @param {ts.TypeChecker} checker @param {ts.SourceFile} httpFile
 */
function renderOptionInterfaces(checker, httpFile) {
  return ['ClientOptions', 'RequestOptions']
    .map((name) => {
      const node = findInterface(httpFile, name);
      const type = checker.getTypeAtLocation(node);
      return [`## ${name}`, '', mdxDoc(node), '', renderTypeSection(checker, type, node)].join(
        '\n',
      );
    })
    .join('\n\n');
}

/**
 * `## ClientAuth`, from `sdk/src/http.ts` — the union, each member as its own mini table.
 * @param {ts.TypeChecker} checker @param {ts.SourceFile} httpFile
 */
function renderClientAuth(checker, httpFile) {
  const alias = findTypeAlias(httpFile, 'ClientAuth');
  const type = checker.getTypeAtLocation(alias);
  const members = type.isUnion() ? type.types : [type];
  const memberSections = members.map((member) => {
    const label = checker.typeToString(member, alias, TYPE_FORMAT);
    return `**\`${label}\`**\n\n${renderTypeSection(checker, member, alias)}`;
  });
  return ['## ClientAuth', '', mdxDoc(alias), '', 'One of:', '', memberSections.join('\n\n')].join(
    '\n',
  );
}

/**
 * Every class `errors.ts` exports, in declaration order, each as public-property table + class
 * TSDoc. The list is read from the module rather than written here, so a new public error class
 * cannot ship without its reference section.
 * @param {ts.TypeChecker} checker @param {ts.SourceFile} errorsFile
 */
function renderErrorClasses(checker, errorsFile) {
  const classes = moduleExports(checker, errorsFile)
    .flatMap((entry) =>
      entry.kind === 'class' && ts.isClassDeclaration(entry.node)
        ? [{ name: entry.name, node: entry.node }]
        : [],
    )
    .sort((left, right) => left.node.getStart() - right.node.getStart());
  if (classes.length === 0) throw new Error('errors.ts exports no error class');
  return classes
    .map(({ name, node }) =>
      [`## ${name}`, '', mdxDoc(node), '', classPropertyTable(checker, node)].join('\n'),
    )
    .join('\n\n');
}

/**
 * @param {ts.TypeChecker} checker
 * @param {{ readonly indexFile: ts.SourceFile, readonly httpFile: ts.SourceFile, readonly errorsFile: ts.SourceFile }} files
 */
export function renderClientPage(checker, files) {
  const header = pageHeader({
    title: 'Client',
    description:
      'createClient, ClientOptions, ClientAuth, RequestOptions, and the SDK error types.',
    sources: [
      'packages/sdk/src/index.ts',
      'packages/sdk/src/http.ts',
      'packages/sdk/src/errors.ts',
    ],
  });
  const body = [
    renderIndexSections(checker, files.indexFile),
    renderOptionInterfaces(checker, files.httpFile),
    renderClientAuth(checker, files.httpFile),
    renderErrorClasses(checker, files.errorsFile),
  ].join('\n\n');
  return finalizePage(`${header}\n${body}`);
}
