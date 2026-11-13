import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { PUBLISHED_PACKAGES } from '../../scripts/release/pack-packages.mjs';
import { run } from '../generated-project/project.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** What the type check installs: the repository's own TypeScript and type packages. */
export const TYPE_CHECK_PACKAGES = [
  'typescript@npm:@typescript/typescript6@6.0.2',
  '@types/react@19.3.0',
  '@types/node@26.6.6',
  '@types/pg@8.23.1',
];

/**
 * `manifest` with every `@indx-workspace/*` dependency pointing at its tarball, and the same map
 * as `overrides`, so a transitive one resolves there too.
 *
 * @param {Record<string, unknown>} manifest @param {Record<string, string>} tarballs
 */
export function withTarballs(manifest, tarballs) {
  /** @type {Record<string, string>} */
  const specs = {};
  for (const [name, tarball] of Object.entries(tarballs)) specs[name] = `file:${tarball}`;
  /** @param {unknown} section */
  const pinned = (section) =>
    section === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(/** @type {Record<string, string>} */ (section)).map(([name, spec]) => [
            name,
            specs[name] ?? spec,
          ]),
        );
  return {
    ...manifest,
    dependencies: pinned(manifest['dependencies']),
    devDependencies: pinned(manifest['devDependencies']),
    overrides: specs,
  };
}

/**
 * Pack every published package into `directory`: each package's npm name to its tarball. The apps
 * benchmark's `regenerate.mjs` packs the same way.
 *
 * @param {string} directory
 */
export function packPackages(directory) {
  const printed = run(
    process.execPath,
    [
      path.join(ROOT, 'scripts/release/pack-packages.mjs'),
      '--out',
      directory,
      '--packages',
      PUBLISHED_PACKAGES.join(','),
    ],
    { cwd: ROOT, timeoutMs: 600_000 },
  );
  /** @type {Record<string, string>} */
  const tarballs = {};
  for (const tarball of printed.trim().split(/\r?\n/u)) {
    const manifest = JSON.parse(run('tar', ['-xzOf', tarball, 'package/package.json']));
    tarballs[manifest.name] = tarball;
  }
  return tarballs;
}

/** @param {string} file @param {(value: Record<string, unknown>) => Record<string, unknown>} change */
export function editJson(file, change) {
  writeFileSync(
    file,
    `${JSON.stringify(change(JSON.parse(readFileSync(file, 'utf8'))), null, 2)}\n`,
  );
}

/** @param {string} cwd @param {NodeJS.ProcessEnv} env */
export function npmInstall(cwd, env) {
  run('npm', ['install', '--no-audit', '--no-fund'], { cwd, env, timeoutMs: 900_000 });
}

/** @param {string} project @param {NodeJS.ProcessEnv} env */
export function installTypecheckPackages(project, env) {
  run('npm', ['install', '--no-audit', '--no-fund', '--save-dev', ...TYPE_CHECK_PACKAGES], {
    cwd: project,
    env,
    timeoutMs: 600_000,
  });
}

/** @param {string} project @param {NodeJS.ProcessEnv} env */
export function checkProjectTypes(project, env) {
  run('npx', ['--no-install', 'tsc', '--noEmit'], { cwd: project, env });
}
