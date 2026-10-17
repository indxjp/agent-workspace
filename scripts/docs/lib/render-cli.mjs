/**
 * `reference/cli/commands.mdx` (brief §E) — every command-factory call (`command('<path>',
 * '<usage>', '<summary>', …)` or `credentialFreeCommand(…)`, see {@link COMMAND_FACTORIES}) in
 * `packages/aw/src/commands/*.ts`, grouped by family in `commands/index.ts`'s `COMMANDS` order,
 * plus the global flags (`help.ts` `GLOBAL_FLAGS`) and exit codes (`output.ts` `EXIT_CODE`).
 */
import ts from 'typescript';

import { pageHeader, finalizePage, mdxProse } from './mdx.mjs';
import { renderObjectLiteral, unwrapExpression } from './literal-values.mjs';

/** @param {ts.SourceFile} sourceFile @param {string} name @returns {ts.VariableDeclaration} */
function findConst(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration;
    }
  }
  throw new Error(`const ${name} was not found in ${sourceFile.fileName}`);
}

/**
 * The identifiers spread into `COMMANDS`, in order: `['workspaceCommands', 'teamCommands', …]`.
 * @param {ts.SourceFile} indexFile @returns {readonly string[]}
 */
export function commandArrayOrder(indexFile) {
  const declaration = findConst(indexFile, 'COMMANDS');
  if (declaration.initializer === undefined) return [];
  const array = unwrapExpression(declaration.initializer);
  if (!ts.isArrayLiteralExpression(array)) return [];
  return array.elements.flatMap((element) => {
    if (ts.isSpreadElement(element) && ts.isIdentifier(element.expression)) {
      return [element.expression.text];
    }
    return [];
  });
}

/**
 * `importedName -> './module.js'`, from `commands/index.ts`'s own import declarations.
 * @param {ts.SourceFile} indexFile @returns {ReadonlyMap<string, string>}
 */
export function importSpecifiers(indexFile) {
  /** @type {Map<string, string>} */
  const specifiers = new Map();
  for (const statement of indexFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    for (const element of bindings.elements) {
      specifiers.set(element.name.text, statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

/**
 * @typedef {{
 *   readonly path: string,
 *   readonly usage: string,
 *   readonly summary: string,
 * }} CommandCall
 */

/**
 * The `packages/aw/src/command.ts` helpers that build a `Command`, each taking the literal path,
 * usage and summary as its first three arguments. `tests/docs/render-cli.test.ts` checks this set
 * against every exported function of `command.ts` that returns a command, so a new helper cannot
 * drop its commands from the reference silently.
 * @type {ReadonlySet<string>}
 */
export const COMMAND_FACTORIES = new Set(['command', 'credentialFreeCommand']);

/**
 * Every command-factory call ({@link COMMAND_FACTORIES}) reachable in a file, in source order,
 * with its three literal arguments already read. A factory call whose path, usage or summary is
 * not a string literal is a generator error, not a silently missing command.
 * @param {ts.SourceFile} sourceFile @returns {readonly CommandCall[]}
 */
export function commandCalls(sourceFile) {
  /** @type {CommandCall[]} */
  const calls = [];
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      COMMAND_FACTORIES.has(node.expression.text)
    ) {
      const [pathArg, usageArg, summaryArg] = node.arguments;
      if (
        pathArg === undefined ||
        usageArg === undefined ||
        summaryArg === undefined ||
        !ts.isStringLiteralLike(pathArg) ||
        !ts.isStringLiteralLike(usageArg) ||
        !ts.isStringLiteralLike(summaryArg)
      ) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        throw new Error(
          `${sourceFile.fileName}:${line + 1}:${character + 1}: ${node.expression.text}(...) needs a string-literal path, usage and summary`,
        );
      }
      calls.push({ path: pathArg.text, usage: usageArg.text, summary: summaryArg.text });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return calls;
}

/** @param {CommandCall} call */
function renderCommand(call) {
  const usageLine = call.usage === '' ? `aw ${call.path}` : `aw ${call.path} ${call.usage}`;
  return [
    `## aw ${call.path}`,
    '',
    mdxProse(call.summary),
    '',
    `\`\`\`\n${usageLine}\n\`\`\``,
  ].join('\n');
}

/** @param {ts.Expression} expression @returns {string} */
function templateText(expression) {
  return ts.isStringLiteralLike(expression) ? expression.text : expression.getText();
}

/** @param {ts.SourceFile} helpFile */
function renderGlobalFlags(helpFile) {
  const declaration = findConst(helpFile, 'GLOBAL_FLAGS');
  const text = declaration.initializer === undefined ? '' : templateText(declaration.initializer);
  return ['## Global flags', '', `\`\`\`text\n${text.trim()}\n\`\`\``].join('\n');
}

/** @param {ts.SourceFile} outputFile */
function renderExitCodes(outputFile) {
  const declaration = findConst(outputFile, 'EXIT_CODE');
  const literal =
    declaration.initializer === undefined ? undefined : unwrapExpression(declaration.initializer);
  if (literal === undefined || !ts.isObjectLiteralExpression(literal)) {
    throw new Error('EXIT_CODE is not an object literal');
  }
  return ['## Exit codes', '', renderObjectLiteral(literal, ['Name', 'Code'])].join('\n');
}

/**
 * @param {{ readonly indexFile: ts.SourceFile, readonly helpFile: ts.SourceFile, readonly outputFile: ts.SourceFile }} files
 * @param {ReadonlyMap<string, ts.SourceFile>} commandFilesByIdentifier `workspaceCommands -> workspaces.ts`'s `SourceFile`
 */
export function renderCliPage(files, commandFilesByIdentifier) {
  const header = pageHeader({
    title: 'CLI commands',
    description: 'Every `aw` command, its usage and summary, plus the global flags and exit codes.',
    sources: [
      'packages/aw/src/commands/index.ts',
      'packages/aw/src/help.ts',
      'packages/aw/src/output.ts',
      'packages/aw/src/commands/*.ts',
    ],
  });
  const order = commandArrayOrder(files.indexFile);
  const commandSections = order
    .flatMap((identifier) => {
      const sourceFile = commandFilesByIdentifier.get(identifier);
      if (sourceFile === undefined) throw new Error(`no command file resolved for ${identifier}`);
      return commandCalls(sourceFile);
    })
    .map(renderCommand)
    .join('\n\n');
  const body = [
    renderGlobalFlags(files.helpFile),
    renderExitCodes(files.outputFile),
    commandSections,
  ].join('\n\n');
  return finalizePage(`${header}\n${body}`);
}
