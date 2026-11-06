/**
 * Where a specifier points, as the compiler answers it (ADR-0030), for the in-memory store gate
 * (`store.in-memory-gate.test.ts`).
 *
 * This used to expand a specifier through an alias table built out of the tracked configuration
 * files. That table was a model of a resolver, and verification rounds walked past it repeatedly —
 * through a `paths` alias, then through a `paths` block reached by an `extends` target whose
 * extension is not `.json` and which TypeScript loads verbatim. So the table is gone:
 * {@link createStoreResolver} asks `ts.resolveModuleName` and compares the resolved path — put
 * through `realpathSync`, as is the store module's own path.
 */
import { existsSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';

import ts from 'typescript';

import { relativeReal, type TrackedFiles } from './store.gate-files';

/** The repository's root configuration, whose options every other config in the tree extends. */
const ROOT_CONFIG = 'tsconfig.json';

/**
 * One parsed TypeScript project: the options a specifier inside it resolves through, and the set
 * of files the project compiles.
 */
interface Project {
  readonly configPath: string;
  readonly options: ts.CompilerOptions;
  readonly cache: ts.ModuleResolutionCache;
  readonly files: ReadonlySet<string>;
}

/** The host `ts.getParsedCommandLineOfConfigFile` reads a `tsconfig.json` through. */
const parseConfigHost: ts.ParseConfigFileHost = {
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
 * Parse one tracked configuration into a project, membership included, so that `extends` —
 * including a target whose extension is not `.json`, which TypeScript loads verbatim when the
 * file exists — `baseUrl`, `paths` and the `files`/`include`/`exclude` globs are the compiler's
 * answer and not this gate's.
 *
 * Membership is the **program**, not `parsed.fileNames`. Those are the project's *root* names;
 * the program `tsc -p` builds is that set plus everything the roots import, and an imported file
 * resolves its own specifiers through this project's options. Round 5 reached the store through
 * the difference: a file dropped out of `apps/web`'s `include` was still in the program
 * `tsc -p apps/web/tsconfig.json` builds, while a gate reading root names alone handed it to
 * whichever nested configuration claimed it.
 */
function parseProject(root: string, relative: string): Project {
  const configPath = path.join(root, relative);
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, parseConfigHost);
  if (parsed === undefined) {
    throw new Error(`${relative} did not parse, so this gate cannot resolve anything under it.`);
  }
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  return {
    configPath: relative,
    options: parsed.options,
    cache: ts.createModuleResolutionCache(
      path.dirname(configPath),
      (fileName) => (ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase()),
      parsed.options,
    ),
    files: new Set(program.getSourceFiles().map((file) => relativeReal(file.fileName))),
  };
}

/** Is `configPath`'s directory at or above `relative`? */
const sitsAbove = (configPath: string, relative: string): boolean => {
  const directory = path.posix.dirname(configPath);
  return directory === '.' || relative.startsWith(`${directory}/`);
};

/**
 * The projects a module's specifiers are resolved under, for every module of the tree.
 *
 * **The union of three sets, never a choice between them** — every project whose program contains
 * the module, the repository root `tsconfig.json`, and every tracked project whose configuration
 * file sits at or above it. The last two are this gate's choice rather than the compiler's answer.
 *
 * Taking the union rather than preferring the owners is the correction round 5 forced: the
 * earlier version returned the owning projects exclusively whenever there were any, so a nested
 * `tsconfig.json` claiming a file `apps/web`'s `exclude` had just dropped became the only project
 * consulted, and `apps/web`'s `paths` were discarded. Adding a configuration file adds projects
 * and removes none, so with the union no configuration file can subtract a context.
 */
function loadContexts(files: TrackedFiles): (relative: string) => readonly Project[] {
  const trackedConfigs = files.tracked.filter((file) => /(?:^|\/)tsconfig[^/]*\.json$/u.test(file));
  if (!trackedConfigs.includes(ROOT_CONFIG)) {
    throw new Error(
      `${ROOT_CONFIG} is not tracked. This gate resolves a module that no project compiles under ` +
        'the repository root options, and cannot do that while there are none.',
    );
  }
  const allProjects = trackedConfigs.map((config) => parseProject(files.root, config));
  const compilingProjects = allProjects.filter((project) => project.files.size > 0);
  const rootProject = allProjects.find((project) => project.configPath === ROOT_CONFIG);
  if (rootProject === undefined) {
    throw new Error(`${ROOT_CONFIG} is tracked but produced no project, so this gate cannot run.`);
  }
  return (relative) => {
    const owners = compilingProjects.filter((project) => project.files.has(relative));
    const above = allProjects.filter(
      (project) => project !== rootProject && sitsAbove(project.configPath, relative),
    );
    return [...new Set<Project>([...owners, rootProject, ...above])];
  };
}

export interface StoreResolver {
  /**
   * Does this specifier, written in `from`, name the store module under **any** project whose
   * program contains `from`, or under the widened set? The union is deliberate: adding a
   * configuration file to the tree adds contexts and removes none, and the resolution is monotone
   * in its contexts, so an importer this gate already classifies cannot be taken away by adding
   * one.
   */
  namesTheStore(from: string, specifier: string): boolean;
  /**
   * Does one string read at an arbitrary call site name the store module?
   *
   * The same two questions as {@link StoreResolver.namesTheStore} — the compiler once per
   * context, then the filesystem — with neither of its two failures. A string handed to an
   * arbitrary call is not known to be a specifier, so one that resolves to nothing is a string
   * rather than a reference this gate could not decide. Measured: `fetch('/api/agents')` in
   * `apps/web/components/agents/agent-form.tsx` is why this exists beside `namesTheStore` rather
   * than calling it — through `namesTheStore` that string is a path naming no file, and the gate
   * fails on the form component.
   */
  stringNamesTheStore(from: string, candidate: string): boolean;
}

/** The existing file a relative or absolute `specifier` spells, written from `absolute`, if any. */
function fileAsWritten(absolute: string, specifier: string): string | null {
  if (!specifier.startsWith('.') && !path.isAbsolute(specifier)) return null;
  const asWritten = path.resolve(path.dirname(absolute), specifier);
  return existsSync(asWritten) && statSync(asWritten).isFile() ? asWritten : null;
}

export function createStoreResolver(files: TrackedFiles, storeModule: string): StoreResolver {
  const contextsFor = loadContexts(files);

  /** The file the compiler resolves `specifier` to under `context`, repository-relative. */
  const compilerResolution = (
    context: Project,
    specifier: string,
    absolute: string,
  ): string | null => {
    const resolved = ts.resolveModuleName(
      specifier,
      absolute,
      context.options,
      ts.sys,
      context.cache,
    );
    const file = resolved.resolvedModule?.resolvedFileName;
    return file === undefined ? null : relativeReal(file);
  };

  /**
   * Every file one specifier points at — one answer per project that compiles the importing file,
   * as repository-relative real paths.
   *
   * TypeScript is asked once per context, and the filesystem once more. A path naming a file the
   * compiler has no type for, such as a stylesheet, is loaded by a bundler at exactly the path the
   * specifier spells, so that path is **added** to the answer rather than used only when every
   * context declines — which keeps this function monotone in its contexts: one more context can
   * only add a resolution, never replace one. What is left over is a built-in module, which names
   * no file anywhere; and a path naming nothing, which is a hard failure — a reference this gate
   * cannot decide (ADR-0015). A bare specifier every context declines is a package none of them
   * can find from that file, and it reaches no module at all.
   */
  const resolutionsOf = (from: string, specifier: string): readonly string[] => {
    const absolute = path.join(files.root, from);
    const contexts = contextsFor(from);
    const resolved = new Set<string>();
    for (const context of contexts) {
      const file = compilerResolution(context, specifier, absolute);
      if (file !== null) resolved.add(file);
    }
    const asWritten = fileAsWritten(absolute, specifier);
    if (asWritten !== null) resolved.add(relativeReal(asWritten));
    if (resolved.size > 0) return [...resolved];
    if (isBuiltin(specifier)) return [];
    if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
      throw new Error(
        `${from} imports "${specifier}", a path that TypeScript (through ` +
          `${contexts.map((context) => context.configPath).join(', ')}) cannot resolve and that ` +
          'names no file on disk. This gate decides where a reference points by resolving it, so ' +
          'a path it cannot resolve is a reference it cannot decide (ADR-0015).',
      );
    }
    return [];
  };

  return {
    namesTheStore: (from, specifier) => resolutionsOf(from, specifier).includes(storeModule),
    stringNamesTheStore(from, candidate) {
      const absolute = path.join(files.root, from);
      const byCompiler = contextsFor(from).some(
        (context) => compilerResolution(context, candidate, absolute) === storeModule,
      );
      if (byCompiler) return true;
      const asWritten = fileAsWritten(absolute, candidate);
      return asWritten !== null && relativeReal(asWritten) === storeModule;
    },
  };
}
