/**
 * `pnpm --filter @indx-workspace/embedded build` (ADR-0109): `dist/launch.js`, `dist/bin.js`,
 * `dist/chunks`, `dist/node_modules`, `dist/web`, `dist/migrations` and the staging directory
 * `publish/` the package is packed from — the `outputs` of the Nx `build` target, which must name
 * every one of them or a remote-cache hit restores a `dist/` without it.
 * Node runs this file by stripping its types, so its relative imports name `.ts` files.
 */
import { cp, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENGINE_PACKAGES } from '@indx-workspace/sdk/project';
import { z } from 'zod';

import { EMBEDDED_NEXT_DIST_DIR } from '../next-config.ts';
import { assertNoForeignScope, bundleBin, bundleLaunch, CHUNK_DIRECTORY } from './bundle.ts';
import { EmbeddedBuildError, isMissingPath } from './errors.ts';
import { readWebpackServerExternals } from './externals.ts';
import { buildWeb } from './next-build.ts';
import {
  checkEnginePackages,
  checkWorkspacePins,
  enginePackages,
  type ExternalRequest,
  onDemandOnly,
  resolveInstalledPackage,
  resolveStagingDependencies,
  stagingManifest,
  writeStaging,
} from './staging.ts';
import { readWorkspaceMembers } from './workspace-members.ts';

const packageDirectory = fileURLToPath(new URL('../..', import.meta.url));
const root = path.resolve(packageDirectory, '..', '..');
const distDirectory = path.join(packageDirectory, 'dist');

const workspaceManifestSchema = z.looseObject({
  name: z.string().min(1),
  dependencies: z.record(z.string(), z.string()),
});

/** Everything under `dist/` but the contributor build, which `build-contributor` owns. */
async function cleanDist(): Promise<void> {
  const entries = await readdir(distDirectory).catch((error: unknown) => {
    if (isMissingPath(error)) return [];
    throw error;
  });
  for (const entry of entries) {
    if (entry !== 'contributor') {
      await rm(path.join(distDirectory, entry), { recursive: true, force: true });
    }
  }
}

async function main(): Promise<void> {
  await cleanDist();
  const workspaceManifest = workspaceManifestSchema.parse(
    JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8')),
  );
  const members = await readWorkspaceMembers(root);
  const bundleExternals = await bundleLaunch(packageDirectory, members);
  await bundleBin(packageDirectory);
  const chunks = (await readdir(path.join(distDirectory, CHUNK_DIRECTORY))).map(
    (chunk) => `${CHUNK_DIRECTORY}/${chunk}`,
  );
  for (const bundle of ['launch.js', 'bin.js', ...chunks]) {
    assertNoForeignScope(
      `dist/${bundle}`,
      await readFile(path.join(distDirectory, bundle), 'utf8'),
    );
  }
  const webDistDirectory = path.join(distDirectory, 'web');
  const vendored = await buildWeb(root, webDistDirectory);
  // Third-party files have no reason to name the private scope; checked like the bundle anyway.
  const vendoredFiles = await readdir(path.join(distDirectory, 'node_modules'), {
    withFileTypes: true,
    recursive: true,
  });
  for (const entry of vendoredFiles.filter((file) => file.isFile())) {
    const file = path.join(entry.parentPath, entry.name);
    assertNoForeignScope(path.relative(packageDirectory, file), await readFile(file, 'utf8'));
  }
  await cp(path.join(root, 'migrations'), path.join(distDirectory, 'migrations'), {
    recursive: true,
  });

  // Webpack externals resolve as the server resolves them at run time: from the app, and for
  // Next's own internals from the `next` package the app depends on.
  const webManifest = path.join(root, 'apps', 'web', 'package.json');
  const next = resolveInstalledPackage('next', webManifest);
  if (next === undefined) {
    throw new EmbeddedBuildError('external_unresolved', 'next does not resolve from apps/web');
  }
  const webExternals = await readWebpackServerExternals(
    path.join(webDistDirectory, EMBEDDED_NEXT_DIST_DIR),
  );
  const requests: ExternalRequest[] = [
    ...bundleExternals.required.map(({ name, importer }) => ({ name, from: [importer] })),
    ...[...webExternals].map((name) => ({ name, from: [webManifest, next.manifestPath] })),
  ];
  const onDemandRequests: ExternalRequest[] = bundleExternals.onDemand.map(
    ({ name, importer }) => ({ name, from: [importer] }),
  );
  const required = resolveStagingDependencies(requests, resolveInstalledPackage);
  const onDemand = onDemandOnly(
    required,
    resolveStagingDependencies(onDemandRequests, resolveInstalledPackage),
  );
  const list = (packages: ReadonlyMap<string, string>): string =>
    [...packages].map(([name, version]) => `  ${name}@${version}\n`).join('');
  process.stdout.write(
    `Staged dependencies (${String(required.size)}):\n${list(required)}` +
      `Staged optional peers (${String(onDemand.size)}):\n${list(onDemand)}`,
  );
  checkEnginePackages(
    enginePackages(onDemandRequests, required, resolveInstalledPackage),
    ENGINE_PACKAGES,
  );

  checkWorkspacePins(new Map([...required, ...onDemand]), workspaceManifest.dependencies);
  const staged = await writeStaging(
    packageDirectory,
    stagingManifest(
      workspaceManifest,
      // The runtime carries the traced files of Next and React in dist/node_modules instead.
      new Map([...required].filter(([name]) => !vendored.has(name))),
      onDemand,
    ),
  );
  process.stdout.write(
    `publish/: ${String(staged.files)} files, ${String(staged.bytes)} bytes unpacked\n`,
  );
}

try {
  await main();
} catch (error) {
  const code = error instanceof EmbeddedBuildError ? ` [${error.code}]` : '';
  process.stderr.write(
    `embedded build failed${code}: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
