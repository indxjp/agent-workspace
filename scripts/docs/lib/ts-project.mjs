/**
 * Building `ts.Program`s over the packages the reference site is generated from, and a second
 * "probe" program that lets the checker resolve `z.infer<typeof Schema>` for a Zod schema whose
 * module has no hand-written `type X = z.infer<typeof XSchema>` pair.
 *
 * Reading source through `ts.getParsedCommandLineOfConfigFile` (not `dist`) is the ADR-0054
 * decision: the generator always reflects what the package source declares today.
 */
import path from 'node:path';

import ts from 'typescript';

/** @param {string} configPath @returns {ts.ParsedCommandLine} */
function parseConfig(configPath) {
  const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined };
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
  if (parsed === undefined) {
    throw new Error(`could not parse tsconfig at ${configPath}`);
  }
  return parsed;
}

/**
 * A program built from a package's own `tsconfig.json`, plus its checker.
 * @param {string} configPath
 * @returns {{ program: ts.Program, checker: ts.TypeChecker }}
 */
export function createPackageProgram(configPath) {
  const parsed = parseConfig(configPath);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  return { program, checker: program.getTypeChecker() };
}

/**
 * The source file for an absolute path already loaded by `program`, matched case- and
 * separator-insensitively (TypeScript normalises its own `fileNames` to forward slashes
 * internally, which does not always match a path this generator built with `node:path`). Throws —
 * every module this generator reads is a root file of the package's own tsconfig, so a miss is a
 * generator bug, not a missing file.
 * @param {ts.Program} program @param {string} modulePath @returns {ts.SourceFile}
 */
export function sourceFileOf(program, modulePath) {
  const target = modulePath.replaceAll('\\', '/').toLowerCase();
  const file = program
    .getSourceFiles()
    .find((candidate) => candidate.fileName.toLowerCase() === target);
  if (file === undefined) throw new Error(`${modulePath} is not part of the loaded program`);
  return file;
}

/** @param {string} modulePath */
function virtualProbePath(modulePath) {
  return modulePath.replace(/\.ts$/u, '.__probe__.ts');
}

/**
 * Build a program that is the package's own, plus one virtual sibling file per module that needs
 * one: `export type <ExportName> = import('zod').infer<typeof M.<ExportName>>;` for every
 * requested export, importing the real module. `resolveProbeType` reads the alias back off the
 * returned program, giving the checker's fully resolved output type for a schema whose module
 * never spells `z.infer` for it itself.
 * @param {string} configPath
 * @param {ReadonlyMap<string, readonly string[]>} requests modulePath → export names to probe
 * @returns {{ program: ts.Program, checker: ts.TypeChecker }}
 */
export function buildProbeProgram(configPath, requests) {
  const parsed = parseConfig(configPath);
  /** @type {Map<string, string>} */
  const virtualFiles = new Map();
  for (const [modulePath, exportNames] of requests) {
    if (exportNames.length === 0) continue;
    const specifier = `./${path.basename(modulePath).replace(/\.ts$/u, '.js')}`;
    const lines = [`import type * as M from '${specifier}';`];
    for (const exportName of exportNames) {
      lines.push(`export type ${exportName} = import('zod').infer<typeof M.${exportName}>;`);
    }
    virtualFiles.set(virtualProbePath(modulePath), `${lines.join('\n')}\n`);
  }
  const host = ts.createCompilerHost(parsed.options, true);
  const realGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewFile) => {
    const virtual = virtualFiles.get(fileName);
    if (virtual !== undefined) {
      return ts.createSourceFile(fileName, virtual, ts.ScriptTarget.ES2023, true);
    }
    return realGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewFile);
  };
  const realFileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => virtualFiles.has(fileName) || realFileExists(fileName);
  const realReadFile = host.readFile.bind(host);
  host.readFile = (fileName) => virtualFiles.get(fileName) ?? realReadFile(fileName);
  const rootNames = [...parsed.fileNames, ...virtualFiles.keys()];
  const program = ts.createProgram({ rootNames, options: parsed.options, host });
  return { program, checker: program.getTypeChecker() };
}

/**
 * The resolved `z.infer` output type of a probed export, from the program `buildProbeProgram` built.
 * @param {ts.Program} program @param {ts.TypeChecker} checker
 * @param {string} modulePath @param {string} exportName
 * @returns {ts.Type}
 */
export function resolveProbeType(program, checker, modulePath, exportName) {
  const virtualFile = program.getSourceFile(virtualProbePath(modulePath));
  if (virtualFile === undefined) {
    throw new Error(`no probe file was built for ${modulePath}`);
  }
  for (const statement of virtualFile.statements) {
    if (ts.isTypeAliasDeclaration(statement) && statement.name.text === exportName) {
      return checker.getTypeFromTypeNode(statement.type);
    }
  }
  throw new Error(`no probe alias for ${exportName} in ${modulePath}`);
}
