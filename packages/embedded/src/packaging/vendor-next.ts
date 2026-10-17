import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import { findPackageJSON } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { nodeFileTrace } from '@vercel/nft';
import { z } from 'zod';

import { EmbeddedBuildError } from './errors.ts';

/** The packages the web server needs that the runtime carries itself instead of installing them. */
const VENDORED_ROOTS = ['next', 'react', 'react-dom'] as const;

const manifestSchema = z.looseObject({
  name: z.string().min(1),
  dependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
  peerDependenciesMeta: z
    .record(z.string(), z.looseObject({ optional: z.boolean().optional() }))
    .optional(),
});

/**
 * The installed roots of {@link VENDORED_ROOTS} and of everything they need: `dependencies` and
 * required peers, never `optionalDependencies` (`@next/swc-*`, `sharp`: a build compiler and an
 * image optimiser this app does not use, and native binaries of the build machine's platform).
 * Keyed by real package directory, valued by package name.
 */
function vendoredPackages(webManifest: string): ReadonlyMap<string, string> {
  const roots = new Map<string, string>();
  const queue: { name: string; from: string }[] = VENDORED_ROOTS.map((name) => ({
    name,
    from: webManifest,
  }));
  for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
    const manifestPath = findPackageJSON(item.name, pathToFileURL(item.from));
    if (manifestPath === undefined) {
      throw new EmbeddedBuildError('external_unresolved', `${item.name} does not resolve`);
    }
    const real = realpathSync(manifestPath);
    const directory = path.dirname(real);
    if (roots.has(directory)) continue;
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(real, 'utf8')));
    roots.set(directory, manifest.name);
    const optional = manifest.peerDependenciesMeta ?? {};
    for (const name of [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}).filter((peer) => !optional[peer]?.optional),
    ]) {
      queue.push({ name, from: real });
    }
  }
  return roots;
}

/** Every file the `.nft.json` traces under `buildDirectory` list, as real absolute paths. */
function nftTracedFiles(buildDirectory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(buildDirectory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.nft.json')) continue;
    const trace = z
      .object({ files: z.array(z.string()) })
      .parse(JSON.parse(readFileSync(path.join(entry.parentPath, entry.name), 'utf8')));
    files.push(...trace.files.map((file) => path.resolve(entry.parentPath, file)));
  }
  return files;
}

/**
 * A traced file the production server never reads: a source map, or one of Next's development
 * runtimes, which the trace of `next.js` reaches only through the `dev: true` branch.
 */
export function isDevelopmentOnly(file: string): boolean {
  return file.endsWith('.map') || file.endsWith('.runtime.dev.js');
}

/**
 * Copy into `nodeModulesDirectory` the files the production server loads from the vendored
 * packages: what Next's own build traces list (`next-server.js`, every server page), and what
 * `next/dist/server/next.js`, the programmatic entry `startWeb` imports, reaches. Returns the names
 * of the vendored packages, which the published manifest then does not depend on.
 */
export async function vendorTracedNext(
  root: string,
  webDirectory: string,
  buildDirectory: string,
  nodeModulesDirectory: string,
): Promise<ReadonlySet<string>> {
  const webManifest = path.join(webDirectory, 'package.json');
  const packages = vendoredPackages(webManifest);
  const nextDirectory = [...packages].find(([, name]) => name === 'next')?.[0];
  if (nextDirectory === undefined) {
    throw new EmbeddedBuildError('external_unresolved', 'next does not resolve from apps/web');
  }
  const traced = await nodeFileTrace([path.join(nextDirectory, 'dist/server/next.js')], {
    base: root,
  });
  const files = new Set<string>();
  for (const file of [
    ...nftTracedFiles(buildDirectory),
    ...[...traced.fileList].map((file) => path.resolve(root, file)),
  ]) {
    try {
      files.add(realpathSync(file));
    } catch {
      // A trace may name a file another platform's build has; it is not on this disk.
    }
  }
  const names = packageNames(packages);
  for (const directory of packages.keys()) files.add(path.join(directory, 'package.json'));
  for (const file of files) {
    const target = vendoredTarget(file, packages, nodeModulesDirectory);
    if (target === undefined) continue;
    await mkdir(path.dirname(target), { recursive: true });
    await cp(file, target);
  }
  return names;
}

/**
 * The names of the vendored `packages` (real directory → name). One name from two directories is
 * two versions of one package, and `dist/node_modules` can hold only one.
 */
export function packageNames(packages: ReadonlyMap<string, string>): ReadonlySet<string> {
  const byName = new Map<string, string>();
  for (const [directory, name] of packages) {
    const previous = byName.get(name);
    if (previous !== undefined && previous !== directory) {
      throw new EmbeddedBuildError(
        'external_version_conflict',
        `${name} is needed from both ${previous} and ${directory}; one copy can be vendored`,
      );
    }
    byName.set(name, directory);
  }
  return new Set(byName.keys());
}

/**
 * Where the traced `file` goes under `nodeModulesDirectory`: `<name>/<path in the package>` for a
 * file of a vendored package, and nowhere for any other file or a development-only one.
 */
export function vendoredTarget(
  file: string,
  packages: ReadonlyMap<string, string>,
  nodeModulesDirectory: string,
): string | undefined {
  if (isDevelopmentOnly(file)) return undefined;
  for (const [directory, name] of packages) {
    if (file.startsWith(directory + path.sep)) {
      return path.join(nodeModulesDirectory, name, path.relative(directory, file));
    }
  }
  return undefined;
}
