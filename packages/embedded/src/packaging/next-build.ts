import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { EMBEDDED_NEXT_DIST_DIR } from '../next-config.ts';
import { EmbeddedBuildError, isMissingPath } from './errors.ts';
import { vendorTracedNext } from './vendor-next.ts';

/**
 * The files `next build` rewrites for a custom distDir: it adds the distDir's `types/` to the
 * `include` of `tsconfig.json` and rewrites `next-env.d.ts`. Both are restored byte for byte.
 */
const FILES_NEXT_REWRITES = ['tsconfig.json', 'next-env.d.ts'] as const;

/**
 * Whether a file of the Next build output stays out of `dist/web`: the build cache, the
 * generated route types, the trace files, the file-tracing manifests and source maps. Nothing
 * the production server reads. `relative` is relative to the distDir, with `/` separators.
 */
export function isOmittedFromWebDist(relative: string): boolean {
  const [top] = relative.split('/');
  if (top === 'cache' || top === 'types') return true;
  if (relative === 'trace' || relative.startsWith('trace-')) return true;
  return relative.endsWith('.nft.json') || relative.endsWith('.map');
}

type Snapshot = ReadonlyMap<string, Buffer | null>;

async function snapshot(directory: string): Promise<Snapshot> {
  const saved = new Map<string, Buffer | null>();
  for (const file of FILES_NEXT_REWRITES) {
    try {
      saved.set(file, await readFile(path.join(directory, file)));
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      saved.set(file, null);
    }
  }
  return saved;
}

async function restore(directory: string, saved: Snapshot): Promise<void> {
  for (const [file, bytes] of saved) {
    const target = path.join(directory, file);
    if (bytes === null) await rm(target, { force: true });
    else await writeFile(target, bytes);
  }
}

function webTreeStatus(root: string): string {
  const result = spawnSync('git', ['status', '--porcelain', '--', 'apps/web'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new EmbeddedBuildError(
      'web_tree_changed',
      `git status --porcelain apps/web failed: ${result.stderr || String(result.error)}`,
    );
  }
  return result.stdout;
}

function runNextBuild(webDirectory: string): void {
  const nextBin = createRequire(path.join(webDirectory, 'package.json')).resolve(
    'next/dist/bin/next',
  );
  const result = spawnSync(process.execPath, [nextBin, 'build', '--webpack'], {
    cwd: webDirectory,
    env: {
      ...process.env,
      AW_NEXT_DIST_DIR: EMBEDDED_NEXT_DIST_DIR,
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
    },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new EmbeddedBuildError(
      'next_build_failed',
      `next build --webpack exited with ${String(result.status ?? result.signal)} in ${webDirectory}`,
    );
  }
}

/**
 * `dist/web`: the production webpack build of `apps/web` (ADR-0109), made into
 * `apps/web/.next-embedded` and copied without what the server does not read, plus a generated
 * `next.config.mjs` naming the distDir and `public/` when the app has one.
 *
 * `apps/web` is left exactly as it was: the two files Next rewrites are restored and the build
 * directory removed in a `finally`, and the build fails when `git status --porcelain apps/web`
 * differs from what it was before the build.
 */
export async function buildWeb(
  root: string,
  webDistDirectory: string,
): Promise<ReadonlySet<string>> {
  const webDirectory = path.join(root, 'apps', 'web');
  const buildDirectory = path.join(webDirectory, EMBEDDED_NEXT_DIST_DIR);
  const statusBefore = webTreeStatus(root);
  const saved = await snapshot(webDirectory);
  await rm(buildDirectory, { recursive: true, force: true });
  let vendored: ReadonlySet<string>;
  try {
    runNextBuild(webDirectory);
    const nodeModules = path.join(webDistDirectory, '..', 'node_modules');
    await rm(nodeModules, { recursive: true, force: true });
    vendored = await vendorTracedNext(root, webDirectory, buildDirectory, nodeModules);
    await rm(webDistDirectory, { recursive: true, force: true });
    await mkdir(webDistDirectory, { recursive: true });
    await cp(buildDirectory, path.join(webDistDirectory, EMBEDDED_NEXT_DIST_DIR), {
      recursive: true,
      filter: (source) =>
        !isOmittedFromWebDist(path.relative(buildDirectory, source).split(path.sep).join('/')),
    });
  } finally {
    await restore(webDirectory, saved);
    await rm(buildDirectory, { recursive: true, force: true });
  }
  await writeFile(
    path.join(webDistDirectory, 'next.config.mjs'),
    `export default { distDir: '${EMBEDDED_NEXT_DIST_DIR}' };\n`,
  );
  const publicDirectory = path.join(webDirectory, 'public');
  await cp(publicDirectory, path.join(webDistDirectory, 'public'), { recursive: true }).catch(
    (error: unknown) => {
      if (!isMissingPath(error)) throw error;
    },
  );
  const statusAfter = webTreeStatus(root);
  if (statusAfter !== statusBefore) {
    throw new EmbeddedBuildError(
      'web_tree_changed',
      `the embedded web build changed apps/web:\n${statusAfter}`,
    );
  }
  return vendored;
}
