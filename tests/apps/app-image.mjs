#!/usr/bin/env node
/* global console */
/**
 * An example app's image, built from this checkout (issues #1531, #2112).
 *
 * An example is a customer's project: its `package.json` pins the published `@indx-workspace/*`
 * packages and its generated `Dockerfile` installs them with `npm ci` from a `package-lock.json`
 * that `npm create` writes beside it. The examples ship no lockfile, because the versions they pin
 * are this checkout's and are not on the public registry until a release (ADR-0165). So the build
 * context is never `examples/<id>` itself: it is a copy of it, locked against the loopback
 * registry of this checkout's packed packages (`package-server.mjs`), and the image is built with
 * `--network host` so the `Dockerfile`'s `npm ci` reaches that registry. The apps lane builds its
 * images this way, and so does the live Cloud Run preview, through this file's command:
 *
 *   node tests/apps/app-image.mjs --app <id> --work <dir> -- <docker buildx build flags...>
 *
 * It packs the published packages (run it after building them), serves them, copies and locks
 * `examples/<id>` into `<dir>/images/<id>`, runs `docker buildx build <flags> --network host
 * <context>`, and stops the registry. It exits with the build's status.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { packPackages } from '../app-kit/run.mjs';
import { spawnPackageServer } from './package-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXAMPLES = path.join(ROOT, 'examples');

/** What the copy of an example leaves behind: a developer's install and build output. */
const SKIPPED = /(?:^|[\\/])(?:node_modules|\.next)(?:[\\/]|$)/u;

/** The file the lock step writes into the build context, which the `Dockerfile` copies. */
export const LOCKFILE = 'package-lock.json';

/**
 * A fresh copy of `examples/<id>` at `copy`, without `node_modules` or `.next`: the image build
 * context before it is locked, and the lane's install copy.
 *
 * @param {string} id @param {string} copy
 */
export function copyExample(id, copy) {
  rmSync(copy, { recursive: true, force: true });
  cpSync(path.join(EXAMPLES, id), copy, {
    recursive: true,
    filter: (source) => !SKIPPED.test(source),
  });
}

/**
 * The `npm` arguments that write {@link LOCKFILE} into a copied context against `registry`,
 * installing nothing.
 *
 * @param {string} registry
 */
export function lockArguments(registry) {
  return ['install', '--package-lock-only', '--no-audit', '--no-fund', '--registry', registry];
}

/** @param {readonly string[]} argv */
export function parseArguments(argv) {
  const split = argv.indexOf('--');
  const own = split < 0 ? argv : argv.slice(0, split);
  const build = split < 0 ? [] : argv.slice(split + 1);
  /** @param {string} flag */
  const value = (flag) => {
    const index = own.indexOf(flag);
    const found = index < 0 ? undefined : own[index + 1];
    if (found === undefined || found.startsWith('--'))
      throw new Error(`${flag} <value> is required`);
    return found;
  };
  const app = value('--app');
  if (!/^[a-z][a-z0-9-]*$/u.test(app)) throw new Error(`--app ${app} is not an example id`);
  return { app, work: path.resolve(value('--work')), build };
}

async function main() {
  const { app, work, build } = parseArguments(process.argv.slice(2));
  console.log(`== packing the @indx-workspace packages into ${work}/packs`);
  const tarballs = packPackages(path.join(work, 'packs'));
  const packages = await spawnPackageServer(tarballs, work);
  try {
    const context = path.join(work, 'images', app);
    copyExample(app, context);
    const locked = spawnSync('npm', lockArguments(packages.url), {
      cwd: context,
      stdio: 'inherit',
    });
    if (locked.status !== 0) {
      console.error(`npm install --package-lock-only exited ${String(locked.status)}`);
      return 1;
    }
    const built = spawnSync('docker', ['buildx', 'build', ...build, '--network', 'host', context], {
      stdio: 'inherit',
    });
    return built.status ?? 1;
  } finally {
    packages.close();
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
