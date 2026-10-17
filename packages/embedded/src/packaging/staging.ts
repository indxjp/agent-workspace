import { readFileSync, realpathSync } from 'node:fs';
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { findPackageJSON } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import { EmbeddedBuildError } from './errors.ts';

/** One package the runtime loads at run time, and where to resolve it from, in order. */
export interface ExternalRequest {
  readonly name: string;
  /** Absolute paths of files to resolve `name` from; the first that resolves it wins. */
  readonly from: readonly string[];
}

/** An installed package, as its `package.json` describes it. */
export interface InstalledPackage {
  readonly version: string;
  readonly manifestPath: string;
  /** The peers it needs installed beside it: `peerDependencies` not marked optional. */
  readonly requiredPeers: readonly string[];
  /** Its `dependencies` in a scope the runtime pins as one family (`PINNED_FAMILY_SCOPE`). */
  readonly familyDependencies: readonly string[];
}

/**
 * The scope whose packages release in lock-step but declare each other with caret ranges, so a fresh
 * `npm install` floats them to the newest release: pi 1.0.2 imported an export that pi-codemode
 * 1.2.0 removed. Its dependencies in the same scope are staged at the installed version too.
 */
const PINNED_FAMILY_SCOPE = '@earendil-works/';

/** Finds the package `name` resolves to from the file `base`, or `undefined`. */
export type PackageResolver = (name: string, base: string) => InstalledPackage | undefined;

const installedManifestSchema = z.looseObject({
  version: z.string().min(1),
  peerDependencies: z.record(z.string(), z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  peerDependenciesMeta: z
    .record(z.string(), z.looseObject({ optional: z.boolean().optional() }))
    .optional(),
});

/** The resolver of the real build: Node's own resolution, through `module.findPackageJSON`. */
export const resolveInstalledPackage: PackageResolver = (name, base) => {
  let manifestPath: string | undefined;
  try {
    manifestPath = findPackageJSON(name, pathToFileURL(base));
  } catch {
    // Not resolvable from `base`: the caller tries its next base, then reports it unresolved.
    return undefined;
  }
  if (manifestPath === undefined) return undefined;
  // Node loads a package from its real path, so its own imports and peers resolve from there,
  // not from the workspace symlink it was found through.
  manifestPath = realpathSync(manifestPath);
  const manifest = installedManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
  const optional = manifest.peerDependenciesMeta ?? {};
  return {
    version: manifest.version,
    manifestPath,
    requiredPeers: Object.keys(manifest.peerDependencies ?? {}).filter(
      (peer) => optional[peer]?.optional !== true,
    ),
    familyDependencies: name.startsWith(PINNED_FAMILY_SCOPE)
      ? Object.keys(manifest.dependencies ?? {}).filter((dependency) =>
          dependency.startsWith(PINNED_FAMILY_SCOPE),
        )
      : [],
  };
};

function firstResolution(
  request: ExternalRequest,
  resolve: PackageResolver,
): { readonly installed: InstalledPackage; readonly base: string } {
  for (const base of request.from) {
    const installed = resolve(request.name, base);
    if (installed !== undefined) return { installed, base };
  }
  throw new EmbeddedBuildError(
    'external_unresolved',
    `${request.name} is imported by ${request.from.join(' or ')} but no installed package.json ` +
      'resolves from there',
  );
}

/**
 * The `dependencies` of the staging manifest: every requested external, plus the required peers and pinned-family dependencies
 * of each (recursively), at the exact version installed, sorted by name. Fails on a package that
 * resolves from nowhere, and on one that two importers resolve to two versions.
 */
export function resolveStagingDependencies(
  requests: readonly ExternalRequest[],
  resolve: PackageResolver,
): ReadonlyMap<string, string> {
  const resolved = new Map<string, { readonly version: string; readonly via: string }>();
  const queue = [...requests];
  for (let request = queue.shift(); request !== undefined; request = queue.shift()) {
    const { installed, base } = firstResolution(request, resolve);
    const previous = resolved.get(request.name);
    if (previous !== undefined) {
      if (previous.version !== installed.version) {
        throw new EmbeddedBuildError(
          'external_version_conflict',
          `${request.name} resolves to ${previous.version} from ${previous.via} and to ` +
            `${installed.version} from ${base}; the package can depend on only one`,
        );
      }
      continue;
    }
    resolved.set(request.name, { version: installed.version, via: base });
    for (const peer of [...installed.requiredPeers, ...installed.familyDependencies]) {
      queue.push({ name: peer, from: [installed.manifestPath] });
    }
  }
  return new Map(
    [...resolved.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, { version }]) => [name, version]),
  );
}

/**
 * The workspace manifest pins every staged dependency at exactly its installed version, so the
 * bundle's external imports also link from `packages/embedded` in the repository, and it pins no
 * third-party package the build does not stage. `workspace:` members are not pins.
 */
export function checkWorkspacePins(
  staged: ReadonlyMap<string, string>,
  workspaceDependencies: Readonly<Record<string, string>>,
): void {
  for (const [name, version] of staged) {
    const pin = workspaceDependencies[name];
    if (pin === undefined) {
      throw new EmbeddedBuildError(
        'external_not_pinned',
        `${name}@${version} is external but packages/embedded/package.json does not pin it; ` +
          `add "${name}": "${version}" to its dependencies`,
      );
    }
    if (pin !== version) {
      throw new EmbeddedBuildError(
        'external_pin_mismatch',
        `packages/embedded/package.json pins ${name} at ${pin}, but ${version} is installed; ` +
          'the pin must be that exact version',
      );
    }
  }
  for (const [name, specifier] of Object.entries(workspaceDependencies)) {
    if (!specifier.startsWith('workspace:') && !staged.has(name)) {
      throw new EmbeddedBuildError(
        'pin_not_imported',
        `packages/embedded/package.json pins ${name}, which neither the bundle nor the web ` +
          'build imports and no imported package requires as a peer or pinned-family dependency',
      );
    }
  }
}

/**
 * The on-demand packages that every start does not already need: `onDemand` without the names in
 * `required`. A name in both must resolve to one version, since the package can carry only one.
 */
export function onDemandOnly(
  required: ReadonlyMap<string, string>,
  onDemand: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const only = new Map<string, string>();
  for (const [name, version] of onDemand) {
    const pinned = required.get(name);
    if (pinned === undefined) only.set(name, version);
    else if (pinned !== version) {
      throw new EmbeddedBuildError(
        'external_version_conflict',
        `${name} is required at ${pinned} but an on-demand import resolves it to ${version}`,
      );
    }
  }
  return only;
}

/** An engine adapter's directory, `packages/engine-<id>/`, in a posix-separated path. */
const ENGINE_ADAPTER_DIRECTORY = /\/packages\/engine-([a-z\d-]+)\//u;

/**
 * The packages each engine adapter loads on demand, by engine id: the on-demand imports from
 * `packages/engine-<id>/`, with their required peers and pinned family, less what every start
 * already installs. This is exactly what a project that picks the engine must add.
 */
export function enginePackages(
  onDemand: readonly ExternalRequest[],
  required: ReadonlyMap<string, string>,
  resolve: PackageResolver,
): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const byEngine = new Map<string, ExternalRequest[]>();
  for (const request of onDemand) {
    for (const importer of request.from) {
      const engine = ENGINE_ADAPTER_DIRECTORY.exec(importer.split(path.sep).join('/'))?.[1];
      if (engine !== undefined) byEngine.set(engine, [...(byEngine.get(engine) ?? []), request]);
    }
  }
  return new Map(
    [...byEngine]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([engine, requests]) => [
        engine,
        onDemandOnly(required, resolveStagingDependencies(requests, resolve)),
      ]),
  );
}

/**
 * Fails the build when the engine packages a project is told to install (`declared`, the SDK's
 * `ENGINE_PACKAGES`) differ from what the bundled adapters load (`bundled`): a project that
 * followed the table would then miss a package, or carry one nothing loads. The message is the
 * table to paste.
 */
export function checkEnginePackages(
  bundled: ReadonlyMap<string, ReadonlyMap<string, string>>,
  declared: Readonly<Record<string, Readonly<Record<string, string>>>>,
): void {
  const expected = Object.fromEntries(
    [...bundled].map(([engine, packages]) => [engine, Object.fromEntries(packages)]),
  );
  const canonical = (table: Readonly<Record<string, Readonly<Record<string, string>>>>): string =>
    JSON.stringify(
      Object.keys(table)
        .sort()
        .map((engine) => [engine, Object.entries(table[engine] ?? {}).sort()]),
    );
  if (canonical(expected) !== canonical(declared)) {
    throw new EmbeddedBuildError(
      'engine_packages_drift',
      'ENGINE_PACKAGES in packages/sdk/src/project/dependencies.ts does not match the packages ' +
        `the bundled engine adapters load; it must be:\n${JSON.stringify(expected, null, 2)}`,
    );
  }
}

/** The workspace-manifest fields the published manifest keeps; nothing else is copied. */
export const STAGED_FIELDS = [
  'name',
  'version',
  'description',
  'license',
  'homepage',
  'repository',
  'bugs',
  'keywords',
  'engines',
  'type',
  'exports',
  'bin',
] as const;

/**
 * The published `package.json`: the whitelisted fields of the workspace manifest, the `required`
 * packages as `dependencies`, the `onDemand` ones as optional peers (an engine's SDK, a cloud
 * driver's client: npm installs none of them unless the project names it), and public access.
 * No `private`, `scripts`, `devDependencies`, `nx` or `workspace:` specifier can reach it,
 * because none of them is copied.
 */
export function stagingManifest(
  workspaceManifest: Readonly<Record<string, unknown>>,
  required: ReadonlyMap<string, string>,
  onDemand: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const manifest: Record<string, unknown> = {};
  for (const field of STAGED_FIELDS) {
    if (workspaceManifest[field] !== undefined) manifest[field] = workspaceManifest[field];
  }
  manifest['dependencies'] = Object.fromEntries(required);
  if (onDemand.size > 0) {
    manifest['peerDependencies'] = Object.fromEntries(onDemand);
    manifest['peerDependenciesMeta'] = Object.fromEntries(
      [...onDemand.keys()].map((name) => [name, { optional: true }]),
    );
  }
  manifest['publishConfig'] = { access: 'public' };
  return manifest;
}

/** What `publish/` holds besides `package.json`, relative to the package directory. */
const STAGED_PATHS = [
  'dist/bin.js',
  'dist/launch.js',
  'dist/chunks',
  'dist/node_modules',
  'dist/web',
  'dist/migrations',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
] as const;

/** The number and total bytes of the files under `directory`. */
async function measure(directory: string): Promise<{ files: number; bytes: number }> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    files += 1;
    bytes += (await stat(path.join(entry.parentPath, entry.name))).size;
  }
  return { files, bytes };
}

/**
 * Write `publish/`: the generated manifest, formatted as Prettier formats JSON, and the
 * whitelisted files. Returns the count and bytes of what a pack of it carries.
 */
export async function writeStaging(
  packageDirectory: string,
  manifest: Readonly<Record<string, unknown>>,
): Promise<{ files: number; bytes: number }> {
  const publishDirectory = path.join(packageDirectory, 'publish');
  await rm(publishDirectory, { recursive: true, force: true });
  await mkdir(path.join(publishDirectory, 'dist'), { recursive: true });
  await writeFile(
    path.join(publishDirectory, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  for (const staged of STAGED_PATHS) {
    await cp(path.join(packageDirectory, staged), path.join(publishDirectory, staged), {
      recursive: true,
    });
  }
  return measure(publishDirectory);
}
