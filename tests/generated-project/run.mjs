#!/usr/bin/env node
/* global console */
/**
 * The generated-project E2E (issue #398): what a new user does, against this checkout.
 *
 *   pnpm build && node tests/generated-project/run.mjs
 *
 * 1. Pack six of the eight `@indx-workspace` packages (`scripts/release/pack-packages.mjs
 *    --packages contracts,platforms,sdk,aw,cli,create`, which also refuses an unpublishable tarball) and
 *    install them into an empty consumer project, the way a user's `npm create` and `npx aw` find
 *    them. `@indx-workspace/embedded` is left out: the v1 Compose project this run generates needs
 *    only the CLI, and the CI job builds only those six packages, so packing embedded would fail
 *    on its missing staging directory. The release and `pnpm release:pack --smoke` pack all eight.
 * 2. Start a throwaway registry on the Docker host and push the platform images the generator pins,
 *    built from this checkout (`images.mjs`); hand them to `create` through the `AW_*_IMAGE`
 *    overrides it already reads.
 * 3. Run `generated-project.e2e.mjs` with Playwright: create, start, setup, chat through the API,
 *    `aw` and the browser, teardown.
 *
 * It needs Docker (with Compose and Buildx), `openssl`, `npm`, `pnpm` and Playwright's Chromium.
 * Run it against a disposable Docker daemon: it starts and removes containers, networks and
 * volumes of its own project, and its registry is left running only until it exits.
 *
 * Environment: `GP_WORK_DIR` (default: a new temporary directory; it must be a path the Docker
 * daemon sees at the same place, because the project bind-mounts the fake provider's files),
 * `GP_REVISION` (`git rev-parse HEAD`), and three numbers, each a positive integer or the run
 * stops naming it: `GP_REGISTRY_PORT` (5000) and `GP_FAKE_CONTROL_PORT` (18081, the fake
 * provider's control port on the host's loopback), both at most 65535, and `GP_PREPARE_TIMEOUT_MS`
 * (30 minutes: the cap on packing, installing and building the images). `GP_WEB_PORT` and
 * `GP_OBJECT_STORE_PORT`, when set, replace the generated `.env`'s `PORT` (3000) and
 * `SEAWEEDFS_PORT` (8333) before `pnpm start`.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { buildPinnedImages, checkoutRevision, remainingBefore } from './images.mjs';
import { run } from './project.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** registry:3.0.0, pinned by its multi-arch index digest. */
export const REGISTRY_IMAGE =
  'docker.io/library/registry@sha256:6c5666b861f3505b116bb9aa9b25175e71210414bd010d92035ff64018f9457e';
// Named per runner: the self-hosted CI host runs several jobs on one Docker daemon at once.
const REGISTRY_CONTAINER = `generated-project-e2e-registry-${(process.env.RUNNER_NAME ?? 'local').replace(/[^\w.-]/gu, '-')}`;

/**
 * The cap on everything before the suite starts (pack, install, four image builds), so that a hung
 * step fails with a message well inside the CI job's `timeout-minutes`. `GP_PREPARE_TIMEOUT_MS`
 * overrides it.
 */
const PREPARE_BUDGET_MS = 30 * 60_000;

/**
 * A numeric harness variable: unset is `fallback`; anything else must be a positive safe integer
 * (and at most `max`), or the run stops with an error naming the variable instead of building with
 * `NaN` or a negative budget.
 *
 * @param {string} name @param {number} fallback
 * @param {{ max?: number }} [options] @param {NodeJS.ProcessEnv} [environment]
 */
export function positiveIntegerVariable(name, fallback, options = {}, environment = process.env) {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  const value = /^\d+$/u.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new Error(`${name} must be a positive integer of at most ${String(max)}, not "${raw}"`);
  }
  return value;
}

/**
 * The Node image the platform images are built from (`Dockerfile`'s `NODE_IMAGE`), digest pinned:
 * the fake provider runs on it, so the E2E pulls nothing the release does not already pull.
 */
export function nodeImageOf(dockerfile) {
  const match = /^ARG NODE_IMAGE=(\S+@sha256:[0-9a-f]{64})$/mu.exec(dockerfile);
  if (match?.[1] === undefined) throw new Error('Dockerfile pins no NODE_IMAGE by digest');
  return match[1];
}

/**
 * Pack the published packages; returns package name to tarball path.
 *
 * @param {string} out @param {number} deadline epoch milliseconds
 */
function packPackages(out, deadline) {
  const printed = run(
    process.execPath,
    [
      path.join(ROOT, 'scripts/release/pack-packages.mjs'),
      '--out',
      out,
      '--packages',
      'contracts,platforms,sdk,aw,cli,create',
    ],
    { cwd: ROOT, timeoutMs: Math.min(600_000, remainingBefore(deadline)) },
  );
  /** @type {Record<string, string>} */
  const tarballs = {};
  for (const tarball of printed.trim().split(/\r?\n/u)) {
    const manifest = JSON.parse(run('tar', ['-xzOf', tarball, 'package/package.json']));
    tarballs[manifest.name] = tarball;
  }
  return tarballs;
}

/**
 * An empty npm project with the tarballs installed: where `npm create` and `npx aw` run.
 *
 * @param {string} directory @param {Record<string, string>} tarballs @param {number} deadline
 */
function installConsumer(directory, tarballs, deadline) {
  mkdirSync(directory, { recursive: true });
  /** @type {Record<string, string>} */
  const dependencies = {};
  for (const [name, tarball] of Object.entries(tarballs)) dependencies[name] = `file:${tarball}`;
  writeFileSync(
    path.join(directory, 'package.json'),
    `${JSON.stringify({ name: 'consumer', private: true, type: 'module', dependencies, overrides: dependencies }, null, 2)}\n`,
  );
  run('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: directory,
    timeoutMs: Math.min(600_000, remainingBefore(deadline)),
  });
}

function startRegistry(port) {
  spawnSync('docker', ['rm', '--force', REGISTRY_CONTAINER], { stdio: 'ignore' });
  run('docker', [
    'run',
    '--detach',
    '--name',
    REGISTRY_CONTAINER,
    '--publish',
    `127.0.0.1:${String(port)}:5000`,
    REGISTRY_IMAGE,
  ]);
}

function stopRegistry() {
  spawnSync('docker', ['rm', '--force', '--volumes', REGISTRY_CONTAINER], { stdio: 'ignore' });
}

async function main() {
  const work = path.resolve(
    process.env['GP_WORK_DIR'] ?? mkdtempSync(path.join(tmpdir(), 'generated-project-e2e-')),
  );
  mkdirSync(work, { recursive: true });
  const registryPort = positiveIntegerVariable('GP_REGISTRY_PORT', 5000, { max: 65_535 });
  const registry = `localhost:${String(registryPort)}`;
  const controlPort = positiveIntegerVariable('GP_FAKE_CONTROL_PORT', 18081, { max: 65_535 });
  const deadline = Date.now() + positiveIntegerVariable('GP_PREPARE_TIMEOUT_MS', PREPARE_BUDGET_MS);

  console.log(`== packing the @indx-workspace packages into ${work}/packs`);
  const tarballs = packPackages(path.join(work, 'packs'), deadline);
  console.log(`== installing them into ${work}/consumer`);
  installConsumer(path.join(work, 'consumer'), tarballs, deadline);

  console.log(`== building the pinned platform images into ${registry}`);
  startRegistry(registryPort);
  try {
    const overrides = buildPinnedImages({
      registry,
      revision: process.env['GP_REVISION'] ?? checkoutRevision(),
      deadline,
    });
    console.log('== running the generated project end to end');
    const result = spawnSync(
      'pnpm',
      ['exec', 'playwright', 'test', '--config', 'playwright.generated-project.config.mjs'],
      {
        cwd: ROOT,
        stdio: 'inherit',
        env: {
          ...process.env,
          GP_WORK_DIR: work,
          GP_CONSUMER_DIR: path.join(work, 'consumer'),
          GP_TARBALLS: JSON.stringify(tarballs),
          GP_IMAGE_OVERRIDES: JSON.stringify(overrides),
          GP_REGISTRY: registry,
          GP_NODE_IMAGE: nodeImageOf(readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')),
          GP_FAKE_CONTROL_PORT: String(controlPort),
        },
      },
    );
    process.exitCode = result.status ?? 1;
  } finally {
    stopRegistry();
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
