import { createHash } from 'node:crypto';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';

import { TOOL_BUNDLE_MAX_BYTES } from '@indx-workspace/contracts/agent-versions';
import { build, type BuildFailure, type Metafile, type Plugin } from 'esbuild';

import { escapes, type LoadedCodeTool } from '../project/load.js';
import { localProblem, type ProjectProblem } from '../project/problems.js';

/** One code tool's run file, bundled into a single ES module (ADR-0118 TS1). */
export interface ToolBundle {
  /** The file that declares the tool, which a refusal of the bundle is attributed to. */
  readonly file: string;
  readonly tool: string;
  /** SHA-256 of `bytes`, lower-case hex: the bundle's address. */
  readonly digest: string;
  readonly bytes: Uint8Array;
}

export type BundleResult =
  | { readonly ok: true; readonly bundle: ToolBundle }
  | { readonly ok: false; readonly problem: ProjectProblem };

/** Lets a CommonJS dependency `require()` a Node built-in from inside an ES module. */
const REQUIRE_SHIM =
  'import { createRequire as __awCreateRequire } from "node:module"; ' +
  'var require = __awCreateRequire(import.meta.url);';

/** The package a path under `node_modules` belongs to, or `undefined` for project code. */
function packageOfPath(file: string): { readonly name: string; readonly root: string } | undefined {
  const marker = `${path.sep}node_modules${path.sep}`;
  const at = file.lastIndexOf(marker);
  if (at === -1) return undefined;
  const parts = file.slice(at + marker.length).split(path.sep);
  const length = parts[0]?.startsWith('@') === true ? 2 : 1;
  const name = parts.slice(0, length).join('/');
  return { name, root: file.slice(0, at + marker.length) + parts.slice(0, length).join(path.sep) };
}

function nativePlugin(found: Set<string>, refused: Set<string>): Plugin {
  return {
    name: 'refuse-native-and-database',
    setup(pluginBuild) {
      // esbuild compiles the filter as a Go regular expression, which has no `u` flag.
      pluginBuild.onResolve({ filter: /\.node$/ }, (args) => {
        found.add(packageOfPath(args.importer)?.name ?? args.path);
        return { path: args.path, external: true };
      });
      // The database layer, which the tool sandbox never contains (ADR-0015, ADR-0118 TS9).
      pluginBuild.onResolve({ filter: /^@agent-workspace\/core(\/|$)/ }, (args) => {
        refused.add(args.path);
        return { path: args.path, external: true };
      });
    },
  };
}

/** The bundled packages that ship a `binding.gyp`, which is how a native addon declares itself. */
async function nativePackages(metafile: Metafile, workingDirectory: string): Promise<string[]> {
  const roots = new Map<string, string>();
  for (const input of Object.keys(metafile.inputs)) {
    const owner = packageOfPath(path.resolve(workingDirectory, input));
    if (owner !== undefined) roots.set(owner.root, owner.name);
  }
  const native: string[] = [];
  for (const [root, name] of roots) {
    const gyp = await access(path.join(root, 'binding.gyp')).then(
      () => true,
      () => false,
    );
    if (gyp) native.push(name);
  }
  return native;
}

function isBuildFailure(error: unknown): error is BuildFailure {
  return error instanceof Error && 'errors' in error && Array.isArray(error.errors);
}

/** `path:line:column: message` for each error esbuild reports, project-relative. */
function failureDetails(failure: BuildFailure): string[] {
  return failure.errors.map(({ text, location }) =>
    location === null
      ? text
      : `${location.file}:${String(location.line)}:${String(location.column + 1)}: ${text}`,
  );
}

/**
 * Bundle `tool`'s run file into one ES module, in memory. Node built-ins stay external; every
 * other import, the project's own dependencies included, is bundled in. The output depends only
 * on the bytes of the files it reaches, so the same source gives the same digest.
 *
 * A refusal is a problem of the file that declares the tool and carries no bundle: a run file
 * missing or outside the project, a source that does not compile, a dependency that needs a
 * native addon (by tool and package name), the database layer, or a bundle over the cap.
 */
export async function bundleCodeTool(root: string, tool: LoadedCodeTool): Promise<BundleResult> {
  const refuse = (code: string, details: readonly string[]): BundleResult => ({
    ok: false,
    problem: localProblem(tool.file, code, details),
  });
  const rootReal = await realpath(root);
  const entry = await realpath(path.join(rootReal, ...tool.run.split('/'))).catch(() => null);
  if (entry === null) return refuse('tool_run_file_missing', [`${tool.name}: ${tool.run}`]);
  if (escapes(path.relative(rootReal, entry))) {
    return refuse('tool_run_file_outside_project', [`${tool.name}: ${tool.run}`]);
  }

  const natives = new Set<string>();
  const databases = new Set<string>();
  let output: Uint8Array;
  let metafile: Metafile;
  try {
    const result = await build({
      absWorkingDir: rootReal,
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      write: false,
      sourcemap: false,
      legalComments: 'none',
      logLevel: 'silent',
      metafile: true,
      banner: { js: REQUIRE_SHIM },
      plugins: [nativePlugin(natives, databases)],
    });
    const [file] = result.outputFiles;
    if (file === undefined) return refuse('tool_bundle_failed', [`${tool.name}: no output`]);
    output = file.contents;
    metafile = result.metafile;
  } catch (error) {
    if (!isBuildFailure(error)) throw error;
    return refuse('tool_bundle_failed', [tool.name, ...failureDetails(error)]);
  }

  for (const name of await nativePackages(metafile, rootReal)) natives.add(name);
  if (natives.size > 0) {
    return refuse(
      'tool_bundle_native_addon',
      [...natives].sort().map((name) => `${tool.name}: ${name}`),
    );
  }
  if (databases.size > 0) {
    return refuse('tool_bundle_database_layer', [tool.name, ...[...databases].sort()]);
  }
  if (output.byteLength > TOOL_BUNDLE_MAX_BYTES) {
    return refuse('tool_bundle_too_large', [
      `${tool.name}: ${String(output.byteLength)} bytes, the limit is ${String(TOOL_BUNDLE_MAX_BYTES)}`,
    ]);
  }
  const digest = createHash('sha256').update(output).digest('hex');
  return { ok: true, bundle: { file: tool.file, tool: tool.name, digest, bytes: output } };
}
