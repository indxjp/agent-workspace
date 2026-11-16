import { isBuiltin } from 'node:module';
import path from 'node:path';

import ts from 'typescript';

import { REPO_ROOT, SDK_BOUNDARY } from './boundaries.js';
import { asRecord, isFile, packageNameOf, realPath } from './packages.js';
import { packageManifests, readTracked, trackedSet } from './tracked.js';

/**
 * A `tsconfig` diagnostic about the project's *input file list*, which this gate never reads.
 *
 * 18002 is "the `files` list is empty" and 18003 is "no inputs were found"; the repository root
 * `tsconfig.json` deliberately carries `"files": []` and `"include": []` because it holds options
 * and compiles nothing. This gate reads `ParsedCommandLine.options` and never `fileNames`, so
 * neither says anything about whether the options came back intact. Every other error is a config
 * this gate could not read, and it throws.
 */
const CONFIG_DIAGNOSTICS_ABOUT_INPUTS = new Set([18002, 18003]);

const CONFIG_HOST: ts.ParseConfigFileHost = {
  useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  readDirectory: (rootDir, extensions, excludes, includes, depth) =>
    ts.sys.readDirectory(rootDir, extensions, excludes, includes, depth),
  fileExists: (file) => ts.sys.fileExists(file),
  readFile: (file) => ts.sys.readFile(file),
  getCurrentDirectory: () => REPO_ROOT,
  onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
    throw new Error(
      `a tsconfig this gate needs could not be read: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
    );
  },
};

const optionsByConfig = new Map<string, ts.CompilerOptions>();

function configErrorSummary(configPath: string, fatal: readonly ts.Diagnostic[]): string {
  const details = fatal
    .map((d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`)
    .join('; ');
  return `${configPath} reported ${fatal.length} configuration error(s), so the options this gate resolves with are not the ones the compiler would use: ${details}`;
}

/**
 * The compiler options of one `tsconfig.json`, with its whole `extends` chain applied.
 *
 * `ts.getParsedCommandLineOfConfigFile` is the API `tsc` itself uses, so an `extends` target whose
 * extension is not `.json`, a `baseUrl`, or a `paths` block declared two configs up all arrive
 * without this file knowing they exist. `allowJs` and `resolveJsonModule` are forced on: both only
 * widen what resolves, which is the safe direction, since otherwise a `.js` or `.json` reference
 * from a project that has not enabled them would come back unresolved and fail as undecidable.
 */
function optionsForConfig(configPath: string): ts.CompilerOptions {
  const cached = optionsByConfig.get(configPath);
  if (cached !== undefined) return cached;
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, CONFIG_HOST);
  if (parsed === undefined) {
    throw new Error(`${configPath} could not be parsed, so this gate cannot resolve against it.`);
  }
  const fatal = parsed.errors.filter(
    (diagnostic) =>
      diagnostic.category === ts.DiagnosticCategory.Error &&
      !CONFIG_DIAGNOSTICS_ABOUT_INPUTS.has(diagnostic.code),
  );
  if (fatal.length > 0) throw new Error(configErrorSummary(configPath, fatal));
  const options: ts.CompilerOptions = { ...parsed.options, allowJs: true, resolveJsonModule: true };
  optionsByConfig.set(configPath, options);
  return options;
}

/**
 * The project a file resolves in: the nearest `tsconfig.json` above it, as an editor and
 * type-aware ESLint search. It throws rather than falling back to a default option set, because a
 * file with no project cannot have its references resolved the way anything else here would.
 */
function optionsForFile(absoluteFile: string): ts.CompilerOptions {
  const configPath = ts.findConfigFile(
    path.dirname(absoluteFile),
    (file) => ts.sys.fileExists(file),
    'tsconfig.json',
  );
  if (configPath === undefined) {
    throw new Error(
      `no tsconfig.json was found above ${absoluteFile}, so this gate has no project to resolve its module references against.`,
    );
  }
  return optionsForConfig(configPath);
}

/**
 * What a reference points at. `'builtin'` is a decision, not a skip: node's own `isBuiltin` says
 * the specifier names the runtime, which is not a package in this tree. `'unresolved'` is the
 * refusal ADR-0030 clause 3 asks for, and the caller turns it into a failure naming the file.
 */
export type Resolution =
  | { readonly kind: 'resolved'; readonly file: string; readonly through: string }
  | { readonly kind: 'builtin' }
  | { readonly kind: 'unresolved' };

function resolvedThrough(
  specifier: string,
  fromFile: string,
  through: string,
): Resolution | undefined {
  const resolved = ts.resolveModuleName(specifier, fromFile, optionsForFile(fromFile), ts.sys)
    .resolvedModule?.resolvedFileName;
  return resolved === undefined
    ? undefined
    : { kind: 'resolved', file: realPath(resolved), through };
}

/**
 * A **relative** specifier TypeScript declines (`./globals.css`, an extension its resolver has no
 * rule for) is joined onto the importing file's directory and accepted when that exact file
 * exists. This is the definitional arm of relative resolution: it introduces no alias and can
 * only name a file this repository already contains.
 */
function resolveRelativeFile(absoluteContainingFile: string, specifier: string): Resolution {
  const joined = path.resolve(path.dirname(absoluteContainingFile), specifier);
  if (!isFile(joined)) return { kind: 'unresolved' };
  return { kind: 'resolved', file: realPath(joined), through: 'the relative path it spells' };
}

/**
 * Resolve one specifier the way the toolchain would, and canonicalise the answer. Nothing here
 * compares specifier text against anything. The arms, in order:
 *
 *   1. the project that owns the importing file;
 *   2. a relative specifier TypeScript declines, joined onto the importer's directory;
 *   3. node builtins, which are the runtime and not a package;
 *   4. an example app's own install ({@link resolveAsExampleInstalls});
 *   5. a bare specifier that resolves nowhere, resolved once more from {@link SDK_BOUNDARY}, a
 *      file inside the package that declares the confined SDK. A committed probe's
 *      `@anthropic-ai/claude-agent-sdk` resolves to nothing in this tree because its README tells
 *      a reader to install it in a scratch directory. This arm is over-eager in the safe
 *      direction: it can only ever add a file to the detected set.
 */
export function resolveSpecifier(absoluteContainingFile: string, specifier: string): Resolution {
  const own = resolvedThrough(specifier, absoluteContainingFile, 'the project that owns the file');
  if (own !== undefined) return own;
  if (specifier.startsWith('.')) return resolveRelativeFile(absoluteContainingFile, specifier);
  if (isBuiltin(specifier)) return { kind: 'builtin' };
  const installed = resolveAsExampleInstalls(absoluteContainingFile, specifier);
  if (installed !== undefined) return installed;
  const boundary = path.join(REPO_ROOT, SDK_BOUNDARY);
  return (
    resolvedThrough(specifier, boundary, 'the package that declares the confined SDK') ?? {
      kind: 'unresolved',
    }
  );
}

/**
 * Does this string, read at a call site in this file, name a module that really resolves?
 *
 * The call-site classifier's whole question, asked of the compiler for the reason ADR-0030 gives:
 * a string that resolves to a module is one the toolchain would load, whatever the gate thinks
 * the surrounding call does. A builtin is not a module in this tree, and a string that resolves
 * nowhere names nothing that could be loaded.
 */
export function stringNamesAModule(containingFile: string, candidate: string): string | null {
  if (candidate === '') return null;
  const resolution = resolveSpecifier(path.join(REPO_ROOT, containingFile), candidate);
  return resolution.kind === 'resolved' ? resolution.file : null;
}

/**
 * Where the example apps live: customer-shaped projects that import only the published
 * `@indx-workspace/*` packages and are not pnpm workspace members, so nothing installs them in
 * this checkout (`examples/README.md`, issue #1531, ADR-0165).
 */
const EXAMPLES_ROOT = 'examples';

/**
 * The example app a tracked file belongs to, as `examples/<id>`, or `null`. An example app is a
 * directory directly under {@link EXAMPLES_ROOT} holding a tracked `package.json` and
 * `benchmark.ts`: the shape `tests/apps/registry.ts` registers, derived here from the tracked
 * tree rather than listed (ADR-0027).
 */
export function exampleAppOf(file: string): string | null {
  const [root, id, ...rest] = file.split('/');
  if (root !== EXAMPLES_ROOT || id === undefined || rest.length === 0) return null;
  const dir = `${root}/${id}`;
  return trackedSet.has(`${dir}/package.json`) && trackedSet.has(`${dir}/benchmark.ts`)
    ? dir
    : null;
}

const INSTALLED_BLOCKS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

function declaredNames(manifest: string): string[] {
  const parsed = asRecord(JSON.parse(readTracked(manifest)) as unknown);
  if (parsed === null) {
    throw new Error(`${manifest} is not a JSON object, so its dependencies cannot be read.`);
  }
  return INSTALLED_BLOCKS.flatMap((block) => Object.keys(asRecord(parsed[block]) ?? {}));
}

/** The directory of the workspace package published under `name`, or `null`. */
function workspacePackageDir(name: string): string | null {
  for (const manifest of packageManifests) {
    if (!/^packages\/[^/]+\/package\.json$/u.test(manifest)) continue;
    const parsed = asRecord(JSON.parse(readTracked(manifest)) as unknown);
    if (parsed?.['name'] === name) return path.posix.dirname(manifest);
  }
  return null;
}

/**
 * A bare specifier from a file of an example app, resolved as the example's own `npm install`
 * would place it: only a package the example's `package.json` declares, and only from inside the
 * workspace package of one of the `@indx-workspace/*` packages it declares. `undefined` when the
 * file is not an example's, the specifier names no package the example declares, or no such
 * package resolves it; the caller's remaining arms then decide it.
 *
 * Every answer is a real resolved file, so it is held to the SDK-ownership check like any other:
 * an example that imported the SDK would resolve to it (or be refused) and fail this gate.
 */
function resolveAsExampleInstalls(
  absoluteContainingFile: string,
  specifier: string,
): Resolution | undefined {
  const example = exampleAppOf(
    path.relative(REPO_ROOT, absoluteContainingFile).split(path.sep).join('/'),
  );
  const packageName = packageNameOf(specifier);
  if (example === null || packageName === null) return undefined;
  const declared = declaredNames(`${example}/package.json`);
  if (!declared.includes(packageName)) return undefined;
  const installs = declared
    .filter((name) => name.startsWith('@indx-workspace/'))
    .sort((a, b) => a.localeCompare(b))
    .map(workspacePackageDir)
    .filter((dir): dir is string => dir !== null);
  for (const dir of installs) {
    const resolved = resolvedThrough(
      specifier,
      path.join(REPO_ROOT, dir, 'package.json'),
      `the install of ${example}, reached through ${dir}`,
    );
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}
