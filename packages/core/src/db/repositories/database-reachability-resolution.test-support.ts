import { existsSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import {
  databaseSubpaths,
  memoised,
  insideLayer,
  MANIFEST,
  PACKAGE,
  repoRelativeReal,
  repoRoot,
  trackedFiles,
} from './database-reachability-manifest.test-support.js';
import type { UnvouchedCall } from './database-reachability-specifiers.test-support.js';

export interface Edge {
  /** Repository-relative path of the file containing the import. */
  readonly from: string;
  /** The specifier exactly as written. */
  readonly specifier: string;
  /** For a subpath edge, the manifest key it named. `null` for a path edge. */
  readonly subpath: string | null;
  /** The repository-relative file the compiler resolved the specifier to. */
  readonly target: string;
  /**
   * How the specifier named the layer: through the package's `exports` map, or as a path — which
   * after resolution is one thing whether it was written relatively, through a `paths` alias, or
   * through the pnpm workspace symlink.
   */
  readonly via: 'subpath' | 'path';
}

// Resolution uses the union of owning projects, the root project and ancestor configs.
// Adding a config must never remove a context that already reveals a database edge.
const probes = {
  fileExists: memoised((fileName) => ts.sys.fileExists(fileName)),
  directoryExists: memoised((directory) => ts.sys.directoryExists(directory)),
  realpath: memoised((file) => (ts.sys.realpath ?? ((same: string): string => same))(file)),
  getDirectories: memoised((directory) => ts.sys.getDirectories(directory)),
};
const fileSystem: ts.ModuleResolutionHost = {
  ...probes,
  readFile: (fileName): string | undefined => ts.sys.readFile(fileName),
  getCurrentDirectory: (): string => ts.sys.getCurrentDirectory(),
  useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
};

/** The host `ts.getParsedCommandLineOfConfigFile` reads a `tsconfig.json` through. */
export const parseConfigHost: ts.ParseConfigFileHost = {
  useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  readDirectory: (rootDir, extensions, excludes, includes, depth): readonly string[] =>
    ts.sys.readDirectory(rootDir, extensions, excludes, includes, depth),
  fileExists: (fileName): boolean => ts.sys.fileExists(fileName),
  readFile: (fileName): string | undefined => ts.sys.readFile(fileName),
  getCurrentDirectory: (): string => ts.sys.getCurrentDirectory(),
  onUnRecoverableConfigFileDiagnostic: (diagnostic): never => {
    throw new Error(
      'a tsconfig this gate needs could not be read: ' +
        ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
    );
  },
};

/**
 * One parsed TypeScript project: the options a specifier inside it resolves through, and the set of
 * files the project compiles.
 */
interface Project {
  /** Repository-relative path of the configuration file. */
  readonly configPath: string;
  readonly options: ts.CompilerOptions;
  readonly cache: ts.ModuleResolutionCache;
  /** Every file this project's *program* contains, repository-relative and resolved through links. */
  readonly files: ReadonlySet<string>;
}

function parseProject(relative: string): Project {
  const configPath = path.join(repoRoot, relative);
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, parseConfigHost);
  if (parsed === undefined) {
    throw new Error(`${relative} did not parse, so this gate cannot resolve anything under it.`);
  }
  // Each program parses its own files and is dropped as soon as its membership is read. Sharing
  // parsed trees between programs was measured faster but kept every program reachable through
  // them, and the fork ran out of heap; one program alive at a time is the memory bound.
  const host = Object.assign(ts.createCompilerHost(parsed.options), probes);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, host });
  return {
    configPath: relative,
    options: parsed.options,
    cache: ts.createModuleResolutionCache(
      path.dirname(configPath),
      (fileName) => (ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase()),
      parsed.options,
    ),
    files: new Set(program.getSourceFiles().map((file) => repoRelativeReal(file.fileName))),
  };
}

/** The repository's root configuration, whose options every other config in the tree extends. */
const ROOT_CONFIG = 'tsconfig.json';

/** Every tracked TypeScript configuration, found by shape rather than by a list. */
const trackedConfigs = trackedFiles().filter((file) => /(?:^|\/)tsconfig[^/]*\.json$/u.test(file));
if (!trackedConfigs.includes(ROOT_CONFIG)) {
  throw new Error(
    `${ROOT_CONFIG} is not tracked. This gate resolves a module that no project compiles under ` +
      'the repository root options, and cannot do that while there are none.',
  );
}
const allProjects = trackedConfigs.map(parseProject);

/** The projects that compile something. A configuration that compiles nothing claims no file. */
const compilingProjects = allProjects.filter((project) => project.files.size > 0);

const declaredRootProject = allProjects.find((project) => project.configPath === ROOT_CONFIG);
if (declaredRootProject === undefined) {
  throw new Error(`${ROOT_CONFIG} is tracked but produced no project, so this gate cannot run.`);
}
const rootProject: Project = declaredRootProject;

/** Is `configPath`'s directory at or above `relative`? */
const sitsAbove = (configPath: string, relative: string): boolean => {
  const directory = path.posix.dirname(configPath);
  return directory === '.' || relative.startsWith(`${directory}/`);
};

function contextsFor(relative: string): readonly Project[] {
  const owners = compilingProjects.filter((project) => project.files.has(relative));
  const above = allProjects.filter(
    (project) => project !== rootProject && sitsAbove(project.configPath, relative),
  );
  return [...new Set<Project>([...owners, rootProject, ...above])];
}

function resolvedFiles(from: string, specifier: string): readonly string[] {
  const absolute = path.join(repoRoot, from);
  const contexts = contextsFor(from);
  const files = new Set<string>();
  for (const context of contexts) {
    const resolved = ts.resolveModuleName(
      specifier,
      absolute,
      context.options,
      fileSystem,
      context.cache,
    );
    if (resolved.resolvedModule !== undefined) {
      files.add(repoRelativeReal(resolved.resolvedModule.resolvedFileName));
    }
  }
  const onDisk = specifier.startsWith('.') || path.isAbsolute(specifier);
  if (onDisk) {
    const asWritten = path.resolve(path.dirname(absolute), specifier);
    if (existsSync(asWritten) && statSync(asWritten).isFile()) {
      files.add(repoRelativeReal(asWritten));
    }
  }
  if (files.size > 0) return [...files];
  if (isBuiltin(specifier)) return [];
  if (onDisk) {
    throw new Error(
      `${from} imports "${specifier}", a path that TypeScript (through ` +
        `${contexts.map((context) => context.configPath).join(', ')}) cannot resolve and that ` +
        'names no file on disk. This gate decides where a reference points by resolving it, so a ' +
        'path it cannot resolve is a reference it cannot decide (ADR-0015).',
    );
  }
  return [];
}

function layerFileNamedBy(from: string, candidate: string): string | null {
  const absolute = path.join(repoRoot, from);
  for (const context of contextsFor(from)) {
    const resolved = ts.resolveModuleName(
      candidate,
      absolute,
      context.options,
      fileSystem,
      context.cache,
    );
    const file = resolved.resolvedModule?.resolvedFileName;
    if (file !== undefined) {
      const relative = repoRelativeReal(file);
      if (insideLayer(relative)) return relative;
    }
  }
  if (candidate.startsWith('.') || path.isAbsolute(candidate)) {
    const asWritten = path.resolve(path.dirname(absolute), candidate);
    if (existsSync(asWritten) && statSync(asWritten).isFile()) {
      const relative = repoRelativeReal(asWritten);
      if (insideLayer(relative)) return relative;
    }
  }
  return null;
}

export function decideUnvouchedCall(from: string, call: UnvouchedCall): void {
  for (const candidate of call.candidates) {
    const target = layerFileNamedBy(from, candidate);
    if (target === null) continue;
    throw new Error(
      `${from} hands ${JSON.stringify(candidate)} to \`${call.construct}\`, and that string ` +
        `resolves to ${target}, inside the database layer. This gate cannot show the call is not ` +
        'a module load: its callee is neither a construct this gate reads a specifier from nor a ' +
        'name this file binds. Refused rather than passed over (ADR-0031 clause 1). Obtain the ' +
        `layer through ${PACKAGE}/db, or bind the callee in this file so that a reader can see ` +
        'what is being called.',
    );
  }
}

export function edgesFor(from: string, specifier: string): readonly Edge[] {
  if (specifier === `${PACKAGE}/db` || specifier.startsWith(`${PACKAGE}/db/`)) {
    const subpath = `.${specifier.slice(PACKAGE.length)}`;
    // The explicit else. An import of a subpath the manifest does not declare would fail to
    // resolve at build time, but it must fail HERE too, naming the file, rather than leaving this
    // gate to report "no database edges" about a file that is full of them.
    if (!databaseSubpaths.has(subpath)) {
      throw new Error(
        `${from} imports "${specifier}", which ${MANIFEST} does not declare. Declared database ` +
          `subpaths: ${[...databaseSubpaths].sort().join(', ')}.`,
      );
    }
    const files = resolvedFiles(from, specifier);
    if (files.length === 0) {
      throw new Error(
        `${from} imports the declared subpath "${specifier}", and the compiler could not place ` +
          'it. This gate reports the file a specifier resolves to, and cannot report one it does ' +
          'not have.',
      );
    }
    return files.map((file) => ({ from, specifier, subpath, target: file, via: 'subpath' }));
  }

  return resolvedFiles(from, specifier)
    .filter((file) => insideLayer(file))
    .map((file) => ({ from, specifier, subpath: null, target: file, via: 'path' }));
}
