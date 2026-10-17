/**
 * What `aw deploy` uploads to Vercel: a pruned copy of the part being deployed, never the checkout.
 *
 * `vercel deploy <checkout>` uploads every file one request at a time, and a free team is refused
 * after 5000 (`api-upload-free`, "Too many requests"); a checkout with its `node_modules`, `.nx`
 * and build output is far past that. Vercel's own advice is `--archive=tgz`, which sends one
 * archive (https://vercel.com/docs/cli/deploy, checked 2026-10-09), and this module keeps that
 * archive to what the Vercel build reads. It stages in a temporary directory, so the operator's
 * tree is never written to and two deploys cannot race on a `.vercelignore`.
 *
 * The files a gateway, manager or control-plane build needs are derived, not listed: the rendered
 * build command is `pnpm --filter "{<package>}..." run build`, whose `...` is the package and the
 * workspace packages it depends on, so that closure is read from the `package.json` files. Every
 * other workspace package contributes only its `package.json`, because `pnpm install
 * --frozen-lockfile` compares each importer in `pnpm-lock.yaml` with the workspace it finds.
 */
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  copyFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { VERCEL_FUNCTION_ENTRY } from '../render/vercel.ts';

/** The workspace package globs of `pnpm-workspace.yaml`. */
const WORKSPACE_ROOTS = ['apps', 'packages'] as const;

/** Files at the checkout's root that `pnpm install` and the TypeScript builds read. */
const ROOT_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'LICENSE'];
const ROOT_FILE_PATTERN = /^tsconfig[^/\\]*\.json$/u;

/** Never uploaded from anywhere: dependencies, VCS data, caches, build output, secrets, tests. */
const EXCLUDED_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.nx',
  '.next',
  '.turbo',
  '.vercel',
  'dist',
  'build',
  'coverage',
  'next-env.d.ts',
]);
const EXCLUDED_PATTERN = /\.tsbuildinfo$|\.test\.tsx?$|^\.env(\..*)?$/u;

/** Whether `name`, the last segment of a path inside the upload, stays out of it. */
export function isExcluded(name: string): boolean {
  return EXCLUDED_NAMES.has(name) || EXCLUDED_PATTERN.test(name);
}

interface WorkspacePackage {
  /** Absent when the manifest has none: pnpm still installs it as an importer. */
  readonly name: string | undefined;
  readonly directory: string;
  readonly dependencies: readonly string[];
}

function refusal(file: string, why: string): Error {
  return new Error(`${file} ${why}. Nothing was run.`);
}

async function readManifest(file: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw refusal(file, 'cannot be read as JSON: the upload is derived from it');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw refusal(file, 'is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** The names of the `workspace:` dependencies a manifest declares, the ones `--filter {<dir>}...` follows. */
function workspaceDependencies(manifest: Record<string, unknown>): string[] {
  return ['dependencies', 'devDependencies', 'optionalDependencies'].flatMap((field) => {
    const declared = manifest[field];
    if (typeof declared !== 'object' || declared === null) return [];
    return Object.entries(declared).flatMap(([name, range]) =>
      typeof range === 'string' && range.startsWith('workspace:') ? [name] : [],
    );
  });
}

/** Every workspace package of the checkout, named or not. */
async function workspacePackages(source: string): Promise<WorkspacePackage[]> {
  const packages: WorkspacePackage[] = [];
  for (const root of WORKSPACE_ROOTS) {
    const entries = await readdir(path.join(source, root), { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
      const directory = path.join(source, root, entry.name);
      // A directory without a package.json is not a package; an unreadable one is refused.
      if (!(await readdir(directory)).includes('package.json')) continue;
      const manifest = await readManifest(path.join(directory, 'package.json'));
      const name = manifest['name'];
      packages.push({
        name: typeof name === 'string' ? name : undefined,
        directory: `${root}/${entry.name}`,
        dependencies: workspaceDependencies(manifest),
      });
    }
  }
  return packages;
}

/** `directory` and the directories of the workspace packages it depends on, as `pnpm --filter {<directory>}...` selects. */
function closureOf(
  packages: readonly WorkspacePackage[],
  directory: string,
  source: string,
): ReadonlySet<string> {
  const byName = new Map(
    packages.flatMap((entry) => (entry.name === undefined ? [] : [[entry.name, entry] as const])),
  );
  const start = packages.find((entry) => entry.directory === directory);
  if (start === undefined) {
    throw refusal(
      path.join(source, directory, 'package.json'),
      'is not a workspace package of the platform checkout: point AGENT_WORKSPACE_SOURCE at a platform checkout',
    );
  }
  const closure = new Set([start.directory]);
  const pending = [start];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const name of next.dependencies) {
      const dependency = byName.get(name);
      if (dependency === undefined) {
        throw refusal(
          path.join(source, next.directory, 'package.json'),
          `depends on the workspace package ${name}, which the checkout does not have`,
        );
      }
      if (!closure.has(dependency.directory)) {
        closure.add(dependency.directory);
        pending.push(dependency);
      }
    }
  }
  return closure;
}

/** Copy `from` to `to` without the excluded names, at any depth. */
async function copyTree(from: string, to: string): Promise<void> {
  await cp(from, to, {
    recursive: true,
    filter: (entry) => entry === from || !isExcluded(path.basename(entry)),
  });
}

/** A package's own function entry source, relative to the workspace root. */
const packageEntry = (directory: string): string => path.posix.join(directory, 'src/api/index.ts');

/** What the package's own `tsc` build emits for {@link packageEntry}, relative to the workspace root. */
const compiledEntry = (directory: string): string =>
  path.posix.join(directory, 'dist/api/index.js');

/**
 * Refuses, as {@link stagePlatform} would, a `directory` whose workspace closure the checkout cannot
 * stage, so the deploy can refuse it before the first tool runs. With `functionEntry`, a package
 * that has no `src/api/index.ts` is refused too.
 */
export async function assertStageable(
  source: string,
  directory: string,
  { functionEntry = false }: { readonly functionEntry?: boolean } = {},
): Promise<void> {
  const normalized = path.posix.normalize(directory);
  closureOf(await workspacePackages(source), normalized, source);
  if (functionEntry) await assertFunctionEntry(path.join(source, packageEntry(normalized)));
}

async function assertFunctionEntry(file: string): Promise<void> {
  if ((await stat(file).catch(() => null))?.isFile() !== true) {
    throw refusal(file, 'does not exist: the Vercel project has no function to build');
  }
}

/**
 * Writes the function Vercel looks for at the upload root, `api/index.js`, as a re-export of the
 * entry the package's own build compiles to `dist/api/index.js`: `functions` patterns are matched
 * against the project's root, and the package sits under its own directory in the staged workspace.
 * The file is JavaScript so Vercel only bundles it and never runs its own TypeScript compile, whose
 * "Emit skipped" failure showed no diagnostics (journey run 38009566248).
 */
export async function writeFunctionEntry(staged: string, directory: string): Promise<void> {
  const normalized = path.posix.normalize(directory);
  await assertFunctionEntry(path.join(staged, packageEntry(normalized)));
  const entry = path.join(staged, VERCEL_FUNCTION_ENTRY);
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(entry, `export { default } from '../${compiledEntry(normalized)}';\n`);
}

/**
 * A temporary directory holding the part of the platform checkout that `directory` (for example
 * `packages/gateway`) builds. The caller removes it with {@link removeStaged}.
 */
export async function stagePlatform(source: string, directory: string): Promise<string> {
  const packages = await workspacePackages(source);
  const closure = closureOf(packages, path.posix.normalize(directory), source);
  const staged = await mkdtemp(path.join(tmpdir(), 'aw-vercel-'));
  try {
    for (const name of await readdir(source)) {
      if (ROOT_FILES.includes(name) || ROOT_FILE_PATTERN.test(name)) {
        await copyFile(path.join(source, name), path.join(staged, name));
      }
    }
    for (const { directory: relative } of packages) {
      const from = path.join(source, relative);
      const to = path.join(staged, relative);
      if (closure.has(relative)) {
        await copyTree(from, to);
      } else {
        await mkdir(to, { recursive: true });
        await copyFile(path.join(from, 'package.json'), path.join(to, 'package.json'));
      }
    }
    return staged;
  } catch (error) {
    await removeStaged(staged);
    throw error;
  }
}

/** A temporary directory holding a project directory (the frontend's `web/`) without the excluded names. */
export async function stageDirectory(directory: string): Promise<string> {
  const staged = await mkdtemp(path.join(tmpdir(), 'aw-vercel-'));
  try {
    await copyTree(directory, staged);
    return staged;
  } catch (error) {
    await removeStaged(staged);
    throw error;
  }
}

export async function removeStaged(staged: string): Promise<void> {
  await rm(staged, { recursive: true, force: true });
}
