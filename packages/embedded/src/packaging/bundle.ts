import path from 'node:path';

import { build, type Metafile, type Plugin } from 'esbuild';

import { EmbeddedBuildError } from './errors.ts';
import { packageNameOf } from './externals.ts';

/** One third-party package the bundle leaves external, and the file that imports it. */
interface ExternalImport {
  readonly name: string;
  /** Absolute path of the importing source file: the version is resolved from here. */
  readonly importer: string;
}

/**
 * The esbuild plugin of ADR-0109: a bare specifier whose package is a workspace member is
 * inlined (esbuild resolves it through the member's `exports`, as Node would); every other bare
 * specifier stays external. Relative paths are inlined and builtins stay external, as usual.
 */
export function workspaceInliningPlugin(members: ReadonlySet<string>): Plugin {
  return {
    name: 'inline-workspace-members',
    setup(pluginBuild) {
      // esbuild compiles the filter as a Go regular expression, which has no `u` flag.
      pluginBuild.onResolve({ filter: /^[^./]/ }, (args) => {
        if (args.kind === 'entry-point') return undefined;
        const name = packageNameOf(args.path);
        if (name === undefined || members.has(name)) return undefined;
        return { path: args.path, external: true };
      });
    },
  };
}

/**
 * The bundle's third-party imports, split by when they load. `required` ones load on every start;
 * `onDemand` ones only when a code path that needs them runs (an engine adapter, a cloud driver),
 * so the published manifest makes them optional peers rather than dependencies. Builtins (`node:fs`)
 * and relative externals (the bin's `./launch.js`) are not packages and appear in neither.
 */
export interface ClassifiedExternals {
  readonly required: readonly ExternalImport[];
  readonly onDemand: readonly ExternalImport[];
}

/** The import kinds that load a module as soon as its importer runs. */
const EAGER_KINDS: ReadonlySet<string> = new Set(['import-statement', 'require-call']);

/**
 * Splits the externals of `metafile` by whether a start loads them. The inputs a start loads are
 * the entry, the modules it `import()`s (it defers them only so its argv guard runs first; one of
 * its two launch paths always loads them), and every module those reach by an eager import. An
 * external that one of them imports eagerly is required, and so is any the runtime's own sources
 * (`src/`) import: when this package defers one (`embedded-postgres`), it defers the load, never
 * the need. Every other external is on demand.
 */
export function classifyExternals(
  metafile: Metafile,
  entry: string,
  workingDirectory: string,
): ClassifiedExternals {
  const loaded = new Set<string>();
  const queue = [entry];
  for (let input = queue.shift(); input !== undefined; input = queue.shift()) {
    if (loaded.has(input)) continue;
    loaded.add(input);
    for (const imported of metafile.inputs[input]?.imports ?? []) {
      if (imported.external === true) continue;
      if (EAGER_KINDS.has(imported.kind) || input === entry) queue.push(imported.path);
    }
  }
  const required: ExternalImport[] = [];
  const onDemand: ExternalImport[] = [];
  for (const [input, { imports }] of Object.entries(metafile.inputs)) {
    for (const imported of imports) {
      if (imported.external !== true) continue;
      const name = packageNameOf(imported.path);
      if (name === undefined) continue;
      const external = { name, importer: path.resolve(workingDirectory, input) };
      const ownSource = input.startsWith('src/');
      if (ownSource || (loaded.has(input) && EAGER_KINDS.has(imported.kind))) {
        required.push(external);
      } else {
        onDemand.push(external);
      }
    }
  }
  return { required, onDemand };
}

const SHARED_OPTIONS = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
} as const;

/** Where the launch bundle's split chunks go, relative to `dist/`. */
export const CHUNK_DIRECTORY = 'chunks';

/**
 * `dist/launch.js`: `src/launch.ts` with every workspace member inlined, split at each `import()`
 * into `dist/chunks/`. Splitting keeps an on-demand package's import inside the chunk that needs
 * it, so a start never loads an engine or a cloud SDK the project did not install.
 */
export async function bundleLaunch(
  packageDirectory: string,
  members: ReadonlySet<string>,
): Promise<ClassifiedExternals> {
  const entry = 'src/launch.ts';
  const result = await build({
    ...SHARED_OPTIONS,
    absWorkingDir: packageDirectory,
    entryPoints: [entry],
    outdir: 'dist',
    splitting: true,
    chunkNames: `${CHUNK_DIRECTORY}/[name]-[hash]`,
    plugins: [workspaceInliningPlugin(members)],
  });
  return classifyExternals(result.metafile, entry, packageDirectory);
}

/** `dist/bin.js`: `src/bin.ts` and its local helper, with `./launch.js` left as the one import. */
export async function bundleBin(packageDirectory: string): Promise<void> {
  await build({
    ...SHARED_OPTIONS,
    absWorkingDir: packageDirectory,
    entryPoints: ['src/bin.ts'],
    outfile: 'dist/bin.js',
    splitting: false,
    external: ['./launch.js'],
  });
}

/** The workspace scope a third party owns on npm; no published file may name it (ADR-0109). */
const FOREIGN_SCOPE = '@agent-workspace/';

/** Fails the build when the file `name`, with `contents`, names the private workspace scope. */
export function assertNoForeignScope(name: string, contents: string): void {
  const index = contents.indexOf(FOREIGN_SCOPE);
  if (index === -1) return;
  const line = contents.slice(0, index).split('\n').length;
  throw new EmbeddedBuildError(
    'foreign_scope_in_bundle',
    `${name} names ${FOREIGN_SCOPE}* at line ${String(line)}; an inlined member leaks its ` +
      'private package name into the published bundle',
  );
}
