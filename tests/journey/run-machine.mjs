/* global fetch, setTimeout */
/**
 * The journey's hosts: the throwaway Verdaccio, the clean machine and its `/runner`, the loopback
 * servers the clean machine reaches (the fake provider, the orders API) and the evidence copied
 * out of the machine.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

import { run } from '../generated-project/project.mjs';
import { createAnthropicToolsHandler } from './fake-anthropic-tools.mjs';
import { JourneyFailure, scrubbedEvidence } from './harness.mjs';
import {
  CONFIG_FILE,
  FEEDBACK_SPEC_FILE,
  FILES_SPEC_FILE,
  FIRST_HOUR_SPEC_FILE,
  HARNESS_FILE,
  HERE,
  HOME,
  ORIGINS_SPEC_FILE,
  PINNED_SPEC_FILE,
  PORTAL_SPEC_FILE,
  QUICKSTART_PAGE,
  RELEASE_SPEC_FILE,
  ROOT,
  RUNNER_CACHE_IN,
  RUNNER_IN,
  SECRETS,
  SPEC_FILE,
  TOOLS_SPEC_FILE,
  VIEWER_SPEC_FILE,
  WORK_IN,
  execOk,
  remaining,
} from './run-support.mjs';

/** Verdaccio 6.10.4, pinned by its multi-arch index digest. */
export const VERDACCIO_IMAGE =
  'verdaccio/verdaccio:6.10.4@sha256:43c4067288b050422265407ea2fe747e511fcd0c407a85ec90ab9a326d9400cd';

/**
 * The clean machine: Playwright's Ubuntu 24.04 image (Node 24, user `pwuser`, browsers in
 * `/ms-playwright`), pinned by digest. Its version is the root `@playwright/test` devDependency's.
 */
export const PLAYWRIGHT_IMAGE =
  'mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea';

const PLAYWRIGHT_PACKAGE = '@playwright/test';
/** Every spec and the harness `/runner` runs. */
const RUNNER_FILES = [
  SPEC_FILE,
  VIEWER_SPEC_FILE,
  TOOLS_SPEC_FILE,
  RELEASE_SPEC_FILE,
  FEEDBACK_SPEC_FILE,
  PINNED_SPEC_FILE,
  ORIGINS_SPEC_FILE,
  FILES_SPEC_FILE,
  PORTAL_SPEC_FILE,
  FIRST_HOUR_SPEC_FILE,
  HARNESS_FILE,
];

/** @param {string} url @param {number} deadline */
export async function waitForRegistry(url, deadline) {
  const until = Date.now() + Math.min(120_000, remaining(deadline));
  while (Date.now() < until) {
    try {
      const response = await fetch(`${url}-/ping`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new JourneyFailure(`Verdaccio did not answer on ${url} in time`);
}

/**
 * The digest-pinned Verdaccio (`verdaccio.yaml`), published on the host's loopback at `port`, and
 * answering by the time this returns.
 *
 * @param {string} name @param {number} port @param {number} deadline
 */
export async function startRegistry(name, port, deadline) {
  run(
    'docker',
    [
      'run',
      '--detach',
      '--name',
      name,
      '--publish',
      `127.0.0.1:${String(port)}:4873`,
      '--volume',
      `${path.join(HERE, 'verdaccio.yaml')}:/verdaccio/conf/config.yaml:ro`,
      VERDACCIO_IMAGE,
    ],
    { timeoutMs: Math.min(600_000, remaining(deadline)) },
  );
  await waitForRegistry(`http://127.0.0.1:${String(port)}/`, deadline);
}

/** @param {string} name */
export function removeContainer(name) {
  spawnSync('docker', ['rm', '--force', '--volumes', name], { stdio: 'ignore' });
}

/**
 * An HTTP server on the host's loopback: C2 lets local posture reach plain-HTTP loopback, and the
 * clean machine shares the host's network.
 *
 * @param {import('node:http').RequestListener} listener @param {string} what
 * @returns {Promise<{ port: number, close: () => void }>}
 */
export async function serveOnLoopback(listener, what) {
  const server = createServer(listener);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new JourneyFailure(`${what} has no port`);
  }
  return { port: address.port, close: () => server.close() };
}

/**
 * The fake Anthropic API that also calls the orders tool (`fake-anthropic-tools.mjs`); every
 * request that is not a tool turn gets the slice-1 reply, so B1 sees no change.
 *
 * @param {import('../generated-project/fake-anthropic.mjs').FakeRequestRecord[]} requests
 * @param {import('./fake-anthropic-tools.mjs').ToolRequestRecord[]} toolRequests
 * @param {string[]} bodies
 */
export function startFakeProvider(requests, toolRequests, bodies) {
  const handle = createAnthropicToolsHandler(requests, toolRequests, bodies);
  return serveOnLoopback((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  }, 'the fake provider');
}

/**
 * The version `manifestDir/package.json` pins `name` to, in `dependencies` or `devDependencies`, so
 * the runner matches what the repository tests against.
 *
 * @param {string} manifestDir @param {string} name
 */
export function pinnedVersion(manifestDir, name) {
  /** @type {unknown} */
  const manifest = JSON.parse(readFileSync(path.join(manifestDir, 'package.json'), 'utf8'));
  for (const field of ['dependencies', 'devDependencies']) {
    const pins =
      typeof manifest === 'object' && manifest !== null && field in manifest
        ? manifest[field]
        : null;
    if (
      typeof pins === 'object' &&
      pins !== null &&
      name in pins &&
      typeof pins[name] === 'string'
    ) {
      return pins[name];
    }
  }
  throw new JourneyFailure(`${path.join(manifestDir, 'package.json')} pins no ${name}`);
}

/**
 * The clean machine must run Node 24 or later and hold no Docker, so `aw dev` runs the `local`
 * driver.
 *
 * @param {string} name @param {number} deadline
 */
async function assertCleanMachine(name, deadline) {
  const node = await execOk(name, ['node', '-p', 'process.versions.node'], {
    timeoutMs: Math.min(60_000, remaining(deadline)),
    quiet: true,
  });
  const major = Number(node.stdout.trim().split('.')[0]);
  if (!Number.isSafeInteger(major) || major < 24) {
    throw new JourneyFailure(`the clean machine runs Node ${node.stdout.trim()}, not 24 or later`);
  }
  const docker = await execOk(
    name,
    ['sh', '-c', 'if command -v docker >/dev/null 2>&1; then echo present; else echo absent; fi'],
    { timeoutMs: Math.min(60_000, remaining(deadline)), quiet: true },
  );
  if (docker.stdout.trim() !== 'absent') {
    throw new JourneyFailure('the clean machine has docker; aw dev must run the local driver');
  }
}

/**
 * The clean machine: the Playwright image, on the host network, as `pwuser`, with no repository
 * and no Docker socket. npm resolves from the throwaway registry.
 *
 * @param {string} name @param {string} registryUrl @param {number} deadline
 */
export async function startMachine(name, registryUrl, deadline) {
  run(
    'docker',
    [
      'run',
      '--detach',
      '--name',
      name,
      '--network',
      'host',
      '--user',
      'pwuser',
      '--env',
      `npm_config_registry=${registryUrl}`,
      '--workdir',
      HOME,
      '--entrypoint',
      'sleep',
      PLAYWRIGHT_IMAGE,
      'infinity',
    ],
    { timeoutMs: Math.min(900_000, remaining(deadline)) },
  );
  await assertCleanMachine(name, deadline);
  await execOk(name, ['mkdir', '-p', WORK_IN], {
    timeoutMs: Math.min(60_000, remaining(deadline)),
  });
}

/**
 * The directory `docker cp` turns into `/runner`: the browser tests, their config, the harness,
 * the quickstart page and a manifest of its own.
 *
 * @param {string} work
 */
function stageRunner(work) {
  const stage = path.join(work, 'runner');
  mkdirSync(path.join(stage, 'tests', 'journey'), { recursive: true });
  copyFileSync(path.join(ROOT, CONFIG_FILE), path.join(stage, CONFIG_FILE));
  for (const file of RUNNER_FILES) {
    copyFileSync(path.join(HERE, file), path.join(stage, 'tests', 'journey', file));
  }
  copyFileSync(path.join(ROOT, QUICKSTART_PAGE), path.join(stage, 'quickstart.mdx'));
  writeFileSync(
    path.join(stage, 'package.json'),
    `${JSON.stringify({ name: 'journey-runner', private: true }, null, 2)}\n`,
  );
  return stage;
}

/**
 * `/runner`: the browser tests, their config and the harness, with `@playwright/test` installed from
 * a cache of its own, so the user's npm cache stays cold for the timed steps.
 *
 * @param {string} machine @param {string} work @param {number} deadline
 */
export async function prepareRunner(machine, work, deadline) {
  const stage = stageRunner(work);
  // `/runner` does not exist yet, so `docker cp` creates it as a copy of the staging directory.
  run('docker', ['cp', stage, `${machine}:${RUNNER_IN}`], {
    timeoutMs: Math.min(120_000, remaining(deadline)),
  });
  await execOk(machine, ['chown', '-R', 'pwuser:pwuser', RUNNER_IN], {
    user: 'root',
    timeoutMs: Math.min(60_000, remaining(deadline)),
  });
  const react = path.join(ROOT, 'packages', 'react');
  await execOk(
    machine,
    [
      'npm',
      'install',
      '--no-audit',
      '--no-fund',
      `${PLAYWRIGHT_PACKAGE}@${pinnedVersion(ROOT, PLAYWRIGHT_PACKAGE)}`,
      // What `origins.e2e.mjs` bundles a `<Chat baseUrl>` page from: the published package, as a
      // customer's site would have it, with the React the repository tests against.
      `esbuild@${pinnedVersion(path.join(ROOT, 'packages', 'embedded'), 'esbuild')}`,
      `react@${pinnedVersion(react, 'react')}`,
      `react-dom@${pinnedVersion(react, 'react-dom')}`,
      '@indx-workspace/react',
    ],
    {
      workdir: RUNNER_IN,
      env: { npm_config_cache: RUNNER_CACHE_IN },
      timeoutMs: Math.min(600_000, remaining(deadline)),
    },
  );
}

/**
 * The container's Playwright report and test results, through the same {@link SECRETS} pass as
 * the logs: a text file is redacted in place, a binary file holding a secret is removed.
 *
 * @param {string} machine @param {string} evidence
 */
export function copyEvidence(machine, evidence) {
  for (const directory of ['test-results', 'playwright-report']) {
    const target = path.join(evidence, directory);
    spawnSync('docker', ['cp', `${machine}:${RUNNER_IN}/${directory}`, target], {
      stdio: 'ignore',
    });
    if (!existsSync(target)) continue;
    for (const entry of readdirSync(target, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(entry.parentPath, entry.name);
      const clean = scrubbedEvidence(readFileSync(file), SECRETS);
      if (clean === null) rmSync(file);
      else writeFileSync(file, clean);
    }
  }
}
