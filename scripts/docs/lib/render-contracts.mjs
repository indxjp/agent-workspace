/**
 * `reference/contracts/<module>.mdx` (brief §D) — `index` plus each of the 17 subpath modules of
 * `@indx-workspace/contracts`, one `## <ExportName>` per export, **sorted alphabetically** (the
 * banner says so, since the brief allows either order).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import { pageHeader, finalizePage, packageRelativePath } from './mdx.mjs';
import { mdxDoc, signatureText, moduleExports } from './ts-nodes.mjs';
import { renderTypeSection } from './type-render.mjs';
import { isZodSchemaType, findShapeObjectLiteral, shapeDocMap } from './zod-shape.mjs';
import { resolveProbeType } from './ts-project.mjs';
import { renderLiteralConst } from './literal-values.mjs';

/**
 * The `exports` subpaths of `packages/contracts/package.json` other than `.` (the index),
 * alphabetical, read from the manifest that declares them — so a new subpath renders a page and
 * `docs:check` reports it `missing` until the page is committed, instead of the module being
 * silently undocumented.
 * @param {string} repoRoot @returns {readonly string[]}
 */
export function contractsModules(repoRoot) {
  const manifestPath = path.join(repoRoot, 'packages/contracts/package.json');
  /** @type {{ readonly exports: Readonly<Record<string, unknown>> }} */
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return Object.keys(manifest.exports)
    .filter((key) => key !== '.')
    .map((key) => key.replace(/^\.\//u, ''))
    .sort();
}

/**
 * A `const` export that is a Zod schema: TSDoc + the `z.infer` shape as a property table.
 * @param {ts.TypeChecker} checker @param {ts.Program} program
 * @param {ts.VariableDeclaration} declaration @param {ts.Symbol} declaringSymbol
 * @param {readonly NamedType[]} aliases
 */
function renderZodSchema(checker, program, declaration, declaringSymbol, aliases) {
  const shape =
    declaration.initializer === undefined
      ? null
      : findShapeObjectLiteral(declaration.initializer, declaration.getSourceFile());
  const docs = shape === null ? undefined : shapeDocMap(shape);
  const declaringModule = declaration.getSourceFile().fileName;
  const outputType = resolveProbeType(program, checker, declaringModule, declaringSymbol.getName());
  return renderTypeSection(checker, outputType, declaration, docs, aliases);
}

/** @typedef {import('./type-render.mjs').NamedType} NamedType */

/**
 * The module's exported type aliases and interfaces, so a nested schema's output type is printed
 * by the name a consumer imports (`readonly RunResource[]`) instead of its expanded shape.
 * @param {ts.TypeChecker} checker @param {readonly import('./ts-nodes.mjs').ModuleExport[]} entries
 * @returns {readonly NamedType[]}
 */
function exportedNamedTypes(checker, entries) {
  return entries.flatMap((entry) =>
    ts.isInterfaceDeclaration(entry.node) || ts.isTypeAliasDeclaration(entry.node)
      ? [{ name: entry.name, type: checker.getTypeAtLocation(entry.node), declaration: entry.node }]
      : [],
  );
}

/**
 * A non-schema `const`: an array/object of literal members, or a single scalar value.
 * @param {ts.VariableDeclaration} declaration
 */
function renderPlainConst(declaration) {
  return declaration.initializer === undefined ? '' : renderLiteralConst(declaration.initializer);
}

/**
 * @param {ts.TypeChecker} checker @param {ts.Program} program
 * @param {import('./ts-nodes.mjs').ModuleExport} entry @param {readonly NamedType[]} aliases
 */
function renderExport(checker, program, entry, aliases) {
  const doc = mdxDoc(entry.node);
  const heading = `## ${entry.name}`;
  if (entry.kind === 'function' && ts.isFunctionDeclaration(entry.node)) {
    const signature = signatureText(checker, entry.name, entry.node);
    return [heading, '', doc, '', `\`\`\`ts\n${signature}\n\`\`\``].join('\n\n');
  }
  if (
    (entry.kind === 'interface' || entry.kind === 'type') &&
    !ts.isVariableDeclaration(entry.node)
  ) {
    const type = checker.getTypeAtLocation(entry.node);
    // A type must not be printed as its own name: the section is where it is expanded.
    const others = aliases.filter((alias) => alias.name !== entry.name);
    const body = renderTypeSection(checker, type, entry.node, undefined, others);
    return [heading, '', doc, '', body].join('\n\n');
  }
  // 'variable': a Zod schema constant renders its inferred shape; anything else is a literal.
  if (ts.isVariableDeclaration(entry.node)) {
    const schemaType = checker.getTypeAtLocation(entry.node);
    const body = isZodSchemaType(schemaType)
      ? renderZodSchema(checker, program, entry.node, entry.symbol, aliases)
      : renderPlainConst(entry.node);
    return [heading, '', doc, '', body].join('\n\n');
  }
  return [heading, '', doc].join('\n\n');
}

/**
 * @param {ts.TypeChecker} checker @param {ts.Program} program
 * @param {string} moduleLabel `'index'` or a subpath name @param {ts.SourceFile} sourceFile
 */
export function renderContractsModulePage(checker, program, moduleLabel, sourceFile) {
  const entries = moduleExports(checker, sourceFile);
  const sourceFileNames = [
    sourceFile.fileName,
    ...entries.map((entry) => entry.node.getSourceFile().fileName),
  ];
  const sources = [...new Set(sourceFileNames.map(packageRelativePath))].sort();
  const header = pageHeader({
    title: moduleLabel === 'index' ? 'contracts' : moduleLabel,
    description:
      moduleLabel === 'index'
        ? 'The @indx-workspace/contracts root entry: identifiers and the error envelope.'
        : `The @indx-workspace/contracts/${moduleLabel} exports, sorted alphabetically.`,
    sources,
  });
  const aliases = exportedNamedTypes(checker, entries);
  const body = entries.map((entry) => renderExport(checker, program, entry, aliases)).join('\n\n');
  return finalizePage(`${header}\n${body}`);
}
