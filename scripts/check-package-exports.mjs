import { spawnSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);
const JAVASCRIPT_EXTENSIONS = new Set(['.cjs', '.js', '.mjs']);
const IGNORED_DIRECTORIES = new Set(['.next', 'coverage', 'dist', 'node_modules']);
// This test-only escape hatch deliberately throws when imported outside Vitest. Its existence and
// artifact are still checked; executing it in production mode would test the guard, not linkage.
const INTENTIONALLY_GUARDED_EXPORTS = new Set(['@agent-workspace/core:./db/unscoped']);

/** @typedef {'source' | 'artifacts'} ValidationMode */
/**
 * @typedef PackageManifest
 * @property {string=} name
 * @property {string=} type
 * @property {unknown=} exports
 * @property {unknown=} main
 * @property {unknown=} types
 * @property {unknown=} bin
 */
/**
 * @typedef Workspace
 * @property {string} directory
 * @property {PackageManifest} manifest
 * @property {string} manifestPath
 */
/** @typedef {{ condition: string, target: string }} ConditionalTarget */

/** @param {string} filePath */
async function exists(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/** @param {string} repositoryRoot @returns {Promise<Workspace[]>} */
async function packageManifests(repositoryRoot) {
  /** @type {Workspace[]} */
  const manifests = [];
  for (const parent of ['apps', 'packages']) {
    const parentDirectory = path.join(repositoryRoot, parent);
    let entries;
    try {
      entries = await readdir(parentDirectory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(parentDirectory, entry.name);
      const manifestPath = path.join(directory, 'package.json');
      if (!(await exists(manifestPath))) continue;
      /** @type {PackageManifest} */
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifests.push({ directory, manifest, manifestPath });
    }
  }
  return manifests;
}

/** @param {unknown} exportsField @returns {Map<string, unknown>} */
function exportEntries(exportsField) {
  if (typeof exportsField === 'string' || Array.isArray(exportsField)) {
    return new Map([['.', exportsField]]);
  }
  if (exportsField === null || typeof exportsField !== 'object') return new Map();
  const entries = Object.entries(exportsField);
  return entries.some(([key]) => key.startsWith('.'))
    ? new Map(entries)
    : new Map([['.', exportsField]]);
}

/** @param {unknown} value @param {string} [condition] @returns {ConditionalTarget[]} */
function targets(value, condition = 'default') {
  if (typeof value === 'string') return [{ condition, target: value }];
  if (Array.isArray(value)) return value.flatMap((item) => targets(item, condition));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => targets(item, key));
}

/** @param {PackageManifest} manifest */
function manifestEntryTargets(manifest) {
  /** @type {Array<ConditionalTarget & { label: string; importable: boolean }>} */
  const entries = [];
  for (const [exportKey, value] of exportEntries(manifest.exports)) {
    for (const target of targets(value)) {
      const guarded = INTENTIONALLY_GUARDED_EXPORTS.has(`${String(manifest.name)}:${exportKey}`);
      entries.push({
        ...target,
        label: `export ${exportKey} (${target.condition})`,
        importable: target.condition !== 'types' && !guarded,
      });
    }
  }
  if (typeof manifest.main === 'string') {
    entries.push({ label: 'main', condition: 'main', target: manifest.main, importable: true });
  }
  if (typeof manifest.types === 'string') {
    entries.push({ label: 'types', condition: 'types', target: manifest.types, importable: false });
  }
  if (typeof manifest.bin === 'string') {
    entries.push({ label: 'bin', condition: 'bin', target: manifest.bin, importable: false });
  } else if (manifest.bin !== null && typeof manifest.bin === 'object') {
    for (const [name, value] of Object.entries(manifest.bin)) {
      if (typeof value === 'string') {
        entries.push({
          label: `bin ${name}`,
          condition: 'bin',
          target: value,
          importable: false,
        });
      }
    }
  }
  return entries;
}

/** @param {string} packageDirectory @param {string} target */
function sourceCandidates(packageDirectory, target) {
  const relativeTarget = target.replace(/^\.\//u, '');
  const sourceRelative = relativeTarget.startsWith('dist/')
    ? `src/${relativeTarget.slice('dist/'.length)}`
    : relativeTarget;
  const stem = sourceRelative.replace(/\.d\.ts$|\.[cm]?jsx?$/u, '');
  // Non-script assets (for example styles.css) are copied verbatim, so their source is the same
  // file name under src/.
  return [
    path.join(packageDirectory, sourceRelative),
    ...['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs'].map((extension) =>
      path.join(packageDirectory, `${stem}${extension}`),
    ),
  ];
}

/** @param {string} target */
function targetIsSafe(target) {
  if (!target.startsWith('./')) return false;
  const segments = target.slice(2).split('/');
  return !segments.includes('..') && !path.isAbsolute(target);
}

/**
 * @param {Workspace} workspace
 * @param {{ label: string, condition: string, target: string }} entry
 * @param {ValidationMode} mode
 */
async function validateTarget(workspace, entry, mode) {
  const { label, condition, target } = entry;
  /** @type {string[]} */
  const errors = [];
  const packageName = workspace.manifest.name ?? workspace.manifestPath;
  if (!targetIsSafe(target)) {
    return [`${packageName} ${label} has unsafe target ${target}`];
  }
  if (
    condition === 'default' &&
    workspace.directory.includes(`${path.sep}packages${path.sep}`) &&
    /\.[cm]?tsx?$/u.test(target)
  ) {
    errors.push(`${packageName} ${label} exposes TypeScript at runtime: ${target}`);
  }
  const absoluteTarget = path.resolve(workspace.directory, target);
  const targetExists = await exists(absoluteTarget);
  if (mode === 'artifacts' && !targetExists) {
    errors.push(`${packageName} ${label} is missing built artifact ${target}`);
  } else if (
    mode === 'source' &&
    !targetExists &&
    !(await Promise.all(sourceCandidates(workspace.directory, target).map(exists))).some(Boolean)
  ) {
    errors.push(`${packageName} ${label} does not resolve to source: ${target}`);
  }
  return errors;
}

/** @param {Workspace[]} workspaces @param {ValidationMode} mode */
async function validateManifests(workspaces, mode) {
  /** @type {string[]} */
  const errors = [];
  for (const workspace of workspaces) {
    const packageName = workspace.manifest.name ?? workspace.manifestPath;
    const entries = exportEntries(workspace.manifest.exports);
    if (entries.size === 0) {
      errors.push(`${packageName} must declare package exports`);
      continue;
    }
    for (const exportKey of entries.keys()) {
      if (exportKey.includes('*')) {
        errors.push(`${packageName} export ${exportKey} must name an explicit public entrypoint`);
      }
    }
    for (const entry of manifestEntryTargets(workspace.manifest)) {
      errors.push(...(await validateTarget(workspace, entry, mode)));
    }
  }
  return errors;
}

/** @param {Workspace[]} workspaces @param {string} repositoryRoot */
async function validateArchitectureAliases(workspaces, repositoryRoot) {
  /** @type {{ compilerOptions?: { paths?: Record<string, unknown> } }} */
  const config = JSON.parse(
    await readFile(path.join(repositoryRoot, 'tsconfig.architecture.json'), 'utf8'),
  );
  // Workspace members live in two scopes: the published packages under `@indx-workspace`, every
  // private one under `@agent-workspace` (ADR-0082).
  const configured = new Set(
    Object.keys(config.compilerOptions?.paths ?? {}).filter((key) =>
      /^@(?:agent|indx)-workspace\//u.test(key),
    ),
  );
  const declared = new Set(
    workspaces.flatMap(({ manifest }) =>
      [...exportEntries(manifest.exports).keys()].map((exportKey) =>
        exportKey === '.' ? String(manifest.name) : `${String(manifest.name)}${exportKey.slice(1)}`,
      ),
    ),
  );
  return [
    ...[...declared]
      .filter((specifier) => !configured.has(specifier))
      .map((specifier) => `tsconfig.architecture.json is missing declared export ${specifier}`),
    ...[...configured]
      .filter((specifier) => !declared.has(specifier))
      .map((specifier) => `tsconfig.architecture.json exposes undeclared subpath ${specifier}`),
  ];
}

/** @param {string} directory @returns {Promise<string[]>} */
async function sourceFiles(directory) {
  /** @type {string[]} */
  const files = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (IGNORED_DIRECTORIES.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(entryPath)));
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(entryPath);
  }
  return files;
}

/** @param {string} sourceText @param {string} fileName */
function importSpecifiers(sourceText, fileName) {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, false);
  /** @type {string[]} */
  const specifiers = [];
  /** @param {import('typescript').Node} node */
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return specifiers;
}

/** @param {string} filePath @param {Workspace[]} workspaces */
function containingWorkspace(filePath, workspaces) {
  return workspaces.find(
    ({ directory }) => filePath === directory || filePath.startsWith(`${directory}${path.sep}`),
  );
}

/** @param {string} specifier @param {Workspace[]} workspaces */
function importedWorkspace(specifier, workspaces) {
  return workspaces.find(
    ({ manifest }) =>
      specifier === manifest.name || specifier.startsWith(`${String(manifest.name)}/`),
  );
}

/** @param {string} filePath @param {string} specifier @param {Workspace[]} workspaces @param {string} repositoryRoot */
function validateSpecifier(filePath, specifier, workspaces, repositoryRoot) {
  if (specifier.startsWith('.')) {
    const destination = path.resolve(path.dirname(filePath), specifier);
    const target = containingWorkspace(destination, workspaces);
    const source = containingWorkspace(filePath, workspaces);
    if (
      target &&
      target !== source &&
      target.directory.startsWith(path.join(repositoryRoot, 'packages'))
    ) {
      return `${path.relative(repositoryRoot, filePath)} imports inside ${String(target.manifest.name)}; use its public package entrypoint`;
    }
    return undefined;
  }
  const target = importedWorkspace(specifier, workspaces);
  if (!target) return undefined;
  const targetName = String(target.manifest.name);
  const subpath = specifier === targetName ? '.' : `.${specifier.slice(targetName.length)}`;
  if (!exportEntries(target.manifest.exports).has(subpath)) {
    return `${path.relative(repositoryRoot, filePath)} imports undeclared subpath ${specifier}`;
  }
  return undefined;
}

/** @param {Workspace[]} workspaces @param {string} repositoryRoot */
async function validateImports(workspaces, repositoryRoot) {
  const files = (
    await Promise.all(
      ['apps', 'packages', 'scripts', 'tests'].map((directory) =>
        sourceFiles(path.join(repositoryRoot, directory)),
      ),
    )
  ).flat();
  /** @type {string[]} */
  const errors = [];
  for (const filePath of files) {
    const sourceText = await readFile(filePath, 'utf8');
    for (const specifier of importSpecifiers(sourceText, filePath)) {
      const error = validateSpecifier(filePath, specifier, workspaces, repositoryRoot);
      if (error) errors.push(error);
    }
  }
  return errors;
}

/** @param {Workspace[]} workspaces */
async function validateImportableArtifacts(workspaces) {
  /** @type {string[]} */
  const errors = [];
  const imported = new Set();
  for (const workspace of workspaces) {
    const packageName = workspace.manifest.name ?? workspace.manifestPath;
    for (const entry of manifestEntryTargets(workspace.manifest)) {
      if (!entry.importable || !JAVASCRIPT_EXTENSIONS.has(path.extname(entry.target))) continue;
      const absoluteTarget = path.resolve(workspace.directory, entry.target);
      if (imported.has(absoluteTarget) || !(await exists(absoluteTarget))) continue;
      imported.add(absoluteTarget);
      const importedModule = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          'await import(process.argv[1])',
          pathToFileURL(absoluteTarget).href,
        ],
        { cwd: workspace.directory, encoding: 'utf8' },
      );
      if (importedModule.status !== 0) {
        const detail = (importedModule.stderr || importedModule.stdout).trim();
        errors.push(`${packageName} ${entry.label} could not be imported: ${detail}`);
      }
    }
  }
  return errors;
}

/**
 * Validate public package declarations against source or, after a full build, exact artifacts.
 * @param {{ repositoryRoot?: string, mode?: ValidationMode }} [options]
 */
export async function validatePackageExports(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? process.cwd());
  const mode = options.mode ?? 'source';
  const workspaces = await packageManifests(repositoryRoot);
  const errors = [
    ...(await validateManifests(workspaces, mode)),
    ...(await validateArchitectureAliases(workspaces, repositoryRoot)),
    ...(await validateImports(workspaces, repositoryRoot)),
  ];
  if (mode === 'artifacts') errors.push(...(await validateImportableArtifacts(workspaces)));
  return { errors, workspaceCount: workspaces.length };
}

/** @param {readonly string[]} argv @returns {ValidationMode} */
function modeFromArguments(argv) {
  if (argv.length === 0) return 'source';
  if (argv.length === 1 && argv[0] === '--artifacts') return 'artifacts';
  throw new Error('Usage: node scripts/check-package-exports.mjs [--artifacts]');
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(path.resolve(invokedPath)).href === import.meta.url
) {
  const mode = modeFromArguments(process.argv.slice(2));
  const result = await validatePackageExports({ mode });
  if (result.errors.length > 0) {
    process.stderr.write(`${result.errors.map((error) => `- ${error}`).join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `Package exports valid in ${mode} mode for ${String(result.workspaceCount)} workspaces.\n`,
    );
  }
}
