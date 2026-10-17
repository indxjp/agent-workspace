#!/usr/bin/env node
/* global console, fetch, setTimeout, clearTimeout */
/**
 * The slice-1 exit test (S1-19, issue #457): the four commands a new user runs, on a clean Linux
 * container, against this checkout's own packages, timed against the 600 s budget, with no file
 * edited by hand.
 *
 *   pnpm build && node tests/journey/run.mjs
 *
 * Outside the timer it packs the eight `@indx-workspace` packages (`scripts/release/pack-packages.mjs`)
 * and publishes them to a digest-pinned Verdaccio (`verdaccio.yaml`: the scope is local only, the
 * rest proxies npmjs), so the run does not depend on what npm serves (ADR-0082 D5; the published
 * packages are proven by `install-live`, ADR-0130). It starts the fake Anthropic
 * API (`../generated-project/fake-anthropic.mjs`, unchanged) on the host's loopback, starts the
 * digest-pinned Playwright image as the clean machine (`--network host`, `--user pwuser`, no
 * repository mount and no Docker socket, so `aw dev` runs the `local` driver), and installs
 * `@playwright/test` into `/runner` with an npm cache of its own, so the user's cache stays cold.
 *
 * Timed, each step on its own and the whole on the wall clock: `npm create @indx-workspace@latest
 * demo`, answered on a terminal (`script` gives it one) as a user answers it, the recommended answer
 * to every setup question except the brand colour, `#c0392b` (`JOURNEY_BRAND_COLOUR`), which is
 * not the widget's default, so the launcher's colour proves `surfaces/main.ts` reached the widget;
 * then `npm install`, `npm run dev` until `ready`, `signed in` and the `widget:` line, and
 * `widget.e2e.mjs`. The fake key (`sk-ant-e2e-fake-<random>`) reaches `aw dev` through that one
 * `docker exec`'s environment, never a file or an argument. The record goes to
 * `<work>/journey-timings.json`, to stdout and to `$GITHUB_STEP_SUMMARY`; a run that fails inside
 * the timed part writes the same file with the steps it finished, the step that failed and the
 * wall clock until then (`finished: false`, no budget verdict).
 *
 * Untimed afterwards: `demo/` holds only what `npm create` wrote (tool-owned paths aside); a copy
 * with an `mcp()` tool on engine `pi` is refused with `422 engine_capability_unsupported [mcp]`; a
 * Viewer key is refused with `403 forbidden`; the widget answers on an allowed origin and is
 * refused on another, and so is a cross-origin `<Chat baseUrl>` from `@indx-workspace/react`
 * (`origins.e2e.mjs`, issues #622 and #680); a thumbs-down in the widget becomes an eval case that
 * `aw eval` fails (`feedback.e2e.mjs`, issue #620); and `npm run dev` again, without `ANTHROPIC_*`,
 * keeps the versions and answers through the persisted model connection with the original key.
 *
 * Then the slice-2 exit test (S2-08, issue #550), in the same container. The fake model is
 * `fake-anthropic-tools.mjs` (the slice-1 fake plus one tool turn), and a loopback orders API
 * serves its own OpenAPI document. Each block is timed on its own clock and budget:
 * B2 (60 s) writes a new colour into `surfaces/main.ts` and waits for the launcher to show it;
 * B3b (900 s) hand-writes `tools/orders.ts` and adds it to the agent, restarts `aw dev` with
 * `ORDERS_TOKEN` (`orders-e2e-<random>`, passed like the fake key) and asks the widget; B3a (900 s)
 * runs `npm create` answering `openapi` and `apis/orders.openapi.json`, copies the document there
 * (the developer's input, the one file allowed to appear) and asks the widget, with no file setup
 * wrote edited afterwards. Each must call `GET /orders/<nonce>` with the token, and the reply must
 * carry the order's data. The records go under `budgets` in `journey-timings.json`, B1's staying
 * at the top level. Untimed, under a second `JOURNEY_CHECKS_TIMEOUT_MS` cap: a
 * `policy.permissions.runCommands: false` ceiling makes `aw dev` and `aw check` print the server's
 * `403 policy_cannot_widen [permissions.runCommands]`, and the agent saved before it answers with
 * `Bash` no longer offered to the model; and the token is in no project file but the sealed store,
 * no log, transcript or model request, and not in the runtime's `/proc/<pid>/environ`.
 *
 * `--live` (issue #609; the nightly `journey-live` workflow) runs the same journey against the real
 * Anthropic API: no fake starts, `aw dev` gets `ANTHROPIC_API_KEY` from this process's environment
 * (the run stops before any Docker work, naming the variable, if it is unset or blank), and only
 * the checks that read the fake's own records (its reply, its tool turn, the tools it was offered)
 * are skipped. Every other check is the same in both modes: the widget shows an answer from a run
 * that finished `completed`, and the orders API saw the tool's request. Each widget answer's
 * first-token latency goes to `firstTokenSeconds` in `journey-timings.json`, beside `model`.
 *
 * It needs Docker and npm on a Linux host. Environment: `JOURNEY_WORK_DIR` (unset or blank: a new
 * temporary directory), `JOURNEY_REGISTRY_PORT` (4873, at most 65535),
 * `JOURNEY_PREPARE_TIMEOUT_MS` (10 minutes: the cap on packing, publishing, pulling and the runner
 * install) and `JOURNEY_CHECKS_TIMEOUT_MS` (10 minutes: the cap on every untimed check after the
 * journey), each a positive integer or the run stops naming it; a cap that runs out is named too.
 * `JOURNEY_REGISTRY` (issue #608; unset or blank: Verdaccio as above) is the post-publish smoke:
 * set to `https://registry.npmjs.org/`, no Verdaccio starts, nothing is packed or published, and
 * the clean machine installs what that registry serves (`docs/release/README.md`).
 * The registry token lives in a temporary directory of its own, removed when the run ends. It never
 * publishes to a public registry and pushes no tag.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

import { SETUP_QUESTIONS } from '@indx-workspace/contracts/setup';

import { PUBLISHED_PACKAGES } from '../../scripts/release/pack-packages.mjs';
import { run } from '../generated-project/project.mjs';
import { positiveIntegerVariable } from '../generated-project/run.mjs';
import { createAnthropicToolsHandler, createOrdersApi } from './fake-anthropic-tools.mjs';
import {
  JOURNEY_BRAND_COLOUR,
  JOURNEY_BUDGET_SECONDS,
  JOURNEY_LOOK_CHANGE_BUDGET_SECONDS,
  JOURNEY_TOOL_BUDGET_SECONDS,
  JourneyFailure,
  agentIdOf,
  agentNameOfSource,
  assertReplyRecorded,
  assertSecretAbsent,
  assertServerRefusal,
  assertToolAnswer,
  assertToolCallSeen,
  assertToolOffered,
  assertUnchanged,
  assertWithinBudget,
  createAnswerFor,
  firstHourSummaryMarkdown,
  firstTokenOf,
  journeyMode,
  splitFirstHour,
  mcpAgentSource,
  devOrigin,
  parseDevLine,
  redact,
  registryOf,
  remainingMs,
  scrubbedEvidence,
  stepSummaryMarkdown,
  stringMapOf,
  stubExpectation,
  timingsReport,
  toolAgentSource,
  totalLine,
  unfinishedSummaryMarkdown,
  unfinishedJourneyRecord,
  unfinishedTimingsReport,
  withSurfaceColour,
  workDirectoryOf,
} from './harness.mjs';

const PARENT = '..';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, PARENT, PARENT);

/** Verdaccio 6.10.4, pinned by its multi-arch index digest. */
export const VERDACCIO_IMAGE =
  'verdaccio/verdaccio:6.10.4@sha256:43c4067288b050422265407ea2fe747e511fcd0c407a85ec90ab9a326d9400cd';

/**
 * The clean machine: Playwright's Ubuntu 24.04 image (Node 24, user `pwuser`, browsers in
 * `/ms-playwright`), pinned by digest. Its version is the root `@playwright/test` devDependency's.
 */
export const PLAYWRIGHT_IMAGE =
  'mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f';

const PREPARE_BUDGET_MS = 10 * 60_000;
const CHECKS_BUDGET_MS = 10 * 60_000;
const PREPARE_VARIABLE = 'JOURNEY_PREPARE_TIMEOUT_MS';
const CHECKS_VARIABLE = 'JOURNEY_CHECKS_TIMEOUT_MS';
/**
 * How many prompts `npm create` may ask before the journey takes it for a question asked again:
 * every setup question, plus npm's install prompt and create's file-list confirmation (C20).
 */
const MAX_CREATE_ANSWERS = SETUP_QUESTIONS.length + 2;
const PLAYWRIGHT_PACKAGE = '@playwright/test';
const CREATE_PACKAGE = '@indx-workspace@latest';
export const FAKE_KEY_PREFIX = 'sk-ant-e2e-fake-';
const NONCE_PREFIX = 'e2e-nonce-';
const CONNECTOR_NAME = 'journey-mcp';
/** A loopback MCP URL nothing listens on: the check refuses the engine before anything dials it. */
const CONNECTOR_URL = 'http://127.0.0.1:9/mcp';

/** Paths inside the clean machine (POSIX). */
export const HOME = '/home/pwuser';
const WORK_IN = `${HOME}/work`;
const DEMO_IN = `${WORK_IN}/demo`;
const DEMO_MCP_IN = `${WORK_IN}/demo-mcp`;
const RUNNER_IN = '/runner';
const RUNNER_CACHE_IN = `${RUNNER_IN}/.npm`;
const PID_FILE_IN = '/tmp/dev.pid';
const CONNECTOR_FILE_IN = '/tmp/journey-connector.json';
const HARNESS_IN = `${RUNNER_IN}/tests/journey/harness.mjs`;
const CONFIG_IN = `${RUNNER_IN}/playwright.journey.config.mjs`;

const CONFIG_FILE = 'playwright.journey.config.mjs';
const SPEC_FILE = 'widget.e2e.mjs';
const VIEWER_SPEC_FILE = 'viewer.e2e.mjs';
const TOOLS_SPEC_FILE = 'tools.e2e.mjs';
const RELEASE_SPEC_FILE = 'release.e2e.mjs';
const FEEDBACK_SPEC_FILE = 'feedback.e2e.mjs';
const PINNED_SPEC_FILE = 'pinned.e2e.mjs';
const ORIGINS_SPEC_FILE = 'origins.e2e.mjs';
/** The stopwatch's exec cap: the spec's 10 min test timeout plus a minute (ci.yml's 25 min step). */
const FIRST_HOUR_EXEC_MS = 11 * 60_000;
const FIRST_HOUR_SPEC_FILE = 'first-hour.e2e.mjs';
/** The page whose shell block the first-hour stopwatch runs unchanged. */
const QUICKSTART_PAGE = path.join('docs', 'sdk', 'site', 'getting-started', 'quickstart.mdx');
const HARNESS_FILE = 'harness.mjs';

/** S2-08's second project, made by setup with the OpenAPI tool (B3a). */
const DEMO_TOOLS_IN = `${WORK_IN}/demo-tools`;
/** The colour B2 writes into `surfaces/main.ts`: neither the default nor B1's brand colour. */
const JOURNEY_COLOUR = '#16a085';
/** Where the developer puts the orders API's document, in both B3 projects. */
const ORDERS_DOCUMENT = 'apis/orders.openapi.json';
/** The variable `secret('ORDERS_TOKEN')` names: what setup derives from `orders.openapi.json`. */
const ORDERS_TOKEN_VARIABLE = 'ORDERS_TOKEN';
const ORDERS_TOKEN_PREFIX = 'orders-e2e-';
/** B3b's hand-written tool: the plan's form, allowing the one read operation it needs. */
const ORDERS_TOOL_SOURCE = [
  "import { openapiTool, secret } from '@indx-workspace/sdk/define';",
  '',
  'export default openapiTool({',
  "  name: 'orders',",
  `  spec: '${ORDERS_DOCUMENT}',`,
  `  auth: secret('${ORDERS_TOKEN_VARIABLE}'),`,
  "  allow: ['GET /orders/*'],",
  '});',
  '',
].join('\n');
/**
 * The promotion bar (issue #619) the journey appends to `agent-workspace.yaml` before B3b, so the
 * `aw dev` B3b restarts enforces it; `policy` is then the file's last mapping.
 */
const PROMOTION_BAR_YAML = 'policy:\n  promotion:\n    minEvalScore: 1\n';
/** The ceiling the untimed check appends under {@link PROMOTION_BAR_YAML}'s `policy` (C13). */
const CEILING_YAML = '  permissions:\n    runCommands: false\n';

/**
 * A setup question's prompt text, read from `SETUP_QUESTIONS` so the journey answers what
 * `npm create` actually asks.
 *
 * @param {string} id
 */
function promptOf(id) {
  const question = SETUP_QUESTIONS.find((candidate) => candidate.id === id);
  if (question === undefined) throw new JourneyFailure(`setup asks no question ${id}`);
  return question.prompt;
}

/**
 * What `aw dev` prints when it gives up: its own `error:` line, or C6's warning that the `default`
 * model connection could not be created (the runtime keeps running, but no turn can finish).
 */
const REFUSAL_LINE = /^(?:error: |warning: could not set up the "default" model connection)/u;

/** Every secret of this run, removed from anything it prints or writes as evidence. */
export const SECRETS = new Set();

/** @param {string} text */
export function scrub(text) {
  let clean = text;
  for (const secret of SECRETS) clean = redact(clean, secret);
  return clean;
}

/** @param {string} text */
export function say(text) {
  console.log(scrub(text));
}

/** @param {number} deadline epoch milliseconds */
function remaining(deadline) {
  return remainingMs(deadline, Date.now(), PREPARE_VARIABLE);
}

/**
 * A command's timeout under the untimed checks' cap: its own `capMs`, or what is left of the cap.
 *
 * @param {number} deadline epoch milliseconds @returns {(capMs: number) => number}
 */
function checksLimit(deadline) {
  return (capMs) => Math.min(capMs, remainingMs(deadline, Date.now(), CHECKS_VARIABLE));
}

/**
 * `docker exec` in the clean machine: no `-t`, so npm exec takes yes on a non-TTY. Its output is
 * streamed (scrubbed) and collected. Asynchronous, so the fake provider keeps answering.
 *
 * @param {string} container @param {readonly string[]} command
 * @param {{ workdir?: string, user?: string, env?: Readonly<Record<string, string>>,
 *   input?: string, timeoutMs: number, quiet?: boolean }} options
 * @returns {Promise<{ status: number | null, output: string, stdout: string }>}
 */
export function exec(container, command, options) {
  const args = ['exec'];
  if (options.input !== undefined) args.push('--interactive');
  if (options.workdir !== undefined) args.push('--workdir', options.workdir);
  if (options.user !== undefined) args.push('--user', options.user);
  // `--env NAME` with no value: docker reads the value from its own environment, so a secret is
  // never on a command line.
  for (const name of Object.keys(options.env ?? {})) args.push('--env', name);
  args.push(container, ...command);
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      env: { ...process.env, ...options.env },
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let stdout = '';
    /** @param {boolean} isStdout @param {Buffer} chunk */
    const collect = (isStdout, chunk) => {
      const text = chunk.toString('utf8');
      output += text;
      if (isStdout) stdout += text;
      if (options.quiet !== true) process.stdout.write(scrub(text));
    };
    child.stdout?.on('data', (chunk) => collect(true, chunk));
    child.stderr?.on('data', (chunk) => collect(false, chunk));
    if (options.input !== undefined) child.stdin?.end(options.input);
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (status) => {
      clearTimeout(timer);
      resolve({ status, output, stdout });
    });
  });
}

/**
 * `exec` that must exit 0, or the run stops with the command and its (scrubbed) output.
 *
 * @param {string} container @param {readonly string[]} command
 * @param {Parameters<typeof exec>[2]} options
 */
export async function execOk(container, command, options) {
  const result = await exec(container, command, options);
  if (result.status !== 0) {
    throw new JourneyFailure(
      `${command.join(' ')} exited ${String(result.status)}\n${scrub(result.output)}`,
    );
  }
  return result;
}

/**
 * `npm create` on a terminal, answered as a user answers it. `script` (util-linux, in every Ubuntu
 * image) gives the command a pseudo-terminal, so create asks its setup questions; each prompt it
 * waits on is answered by {@link createAnswerFor} over `docker exec --interactive`'s stdin. It
 * must exit 0 after at most {@link MAX_CREATE_ANSWERS} answers.
 *
 * @param {string} container @param {string} command one shell command line, no secret in it
 * @param {{ workdir: string, timeoutMs: number, answers: Readonly<Record<string, string>> }} options
 *   `answers` by prompt text; every other question takes the recommended answer
 * @returns {Promise<void>}
 */
function execAnswering(container, command, options) {
  // CI=false: the runner sets CI, and create asks nothing when CI is set (#879).
  const args = [
    'exec',
    '--interactive',
    '--env',
    'CI=false',
    '--workdir',
    options.workdir,
    container,
  ];
  args.push('script', '--quiet', '--return', '--flush', '--command', command, '/dev/null');
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let screen = '';
    let answers = 0;
    /** @type {JourneyFailure | null} */
    let refused = null;
    /** @param {Buffer} chunk */
    const collect = (chunk) => {
      const text = chunk.toString('utf8');
      output += text;
      screen += text;
      process.stdout.write(scrub(text));
      const answer = createAnswerFor(screen, options.answers);
      if (answer === null) return;
      answers += 1;
      if (answers > MAX_CREATE_ANSWERS) {
        refused = new JourneyFailure(
          `${command} asked more than ${String(MAX_CREATE_ANSWERS)} questions; an answer was refused`,
        );
        child.kill('SIGKILL');
        return;
      }
      screen = '';
      child.stdin.write(`${answer}\n`);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (status) => {
      clearTimeout(timer);
      child.stdin.destroy();
      if (refused !== null) reject(refused);
      else if (status === 0) resolve();
      else reject(new JourneyFailure(`${command} exited ${String(status)}\n${scrub(output)}`));
    });
  });
}

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

/**
 * A throwaway Verdaccio user; its token goes into `publish.npmrc` (mode 0600) in `secrets`, a
 * temporary directory of its own that the run removes when it ends, and nowhere else.
 *
 * @param {string} url @param {string} secrets
 */
async function publisherConfig(url, secrets) {
  const password = randomBytes(18).toString('base64url');
  SECRETS.add(password);
  const response = await fetch(`${url}-/user/org.couchdb.user:journey`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'journey', password, type: 'user', roles: [] }),
  });
  /** @type {unknown} */
  const body = await response.json().catch(() => null);
  const token =
    typeof body === 'object' && body !== null && 'token' in body && typeof body.token === 'string'
      ? body.token
      : '';
  if (!response.ok || token === '') {
    throw new JourneyFailure(`Verdaccio refused the publisher (HTTP ${String(response.status)})`);
  }
  SECRETS.add(token);
  const file = path.join(secrets, 'publish.npmrc');
  const host = new URL(url).host;
  writeFileSync(file, `//${host}/:_authToken=${token}\n`, { mode: 0o600 });
  return file;
}

/**
 * Pack the published packages in publish order and publish each to the throwaway registry.
 *
 * @param {string} work @param {string} secrets @param {string} registryUrl
 * @param {number} deadline
 */
export async function publishPackages(work, secrets, registryUrl, deadline) {
  const packs = path.join(work, 'packs');
  const printed = run(
    process.execPath,
    [path.join(ROOT, 'scripts', 'release', 'pack-packages.mjs'), '--out', packs],
    { cwd: ROOT, timeoutMs: Math.min(900_000, remaining(deadline)) },
  );
  const tarballs = printed
    .trim()
    .split(/\r?\n/u)
    .filter((line) => line !== '');
  if (tarballs.length !== PUBLISHED_PACKAGES.length) {
    throw new JourneyFailure(
      `pack-packages printed ${String(tarballs.length)} tarballs, not ${String(PUBLISHED_PACKAGES.length)}`,
    );
  }
  const userconfig = await publisherConfig(registryUrl, secrets);
  for (const tarball of tarballs) {
    say(`== publishing ${path.basename(tarball)} to ${registryUrl}`);
    // `--tag latest` is explicit: npm 11 refuses a prerelease without a tag. The registry is
    // given on the command line, and the user config holds only that registry's token.
    run(
      'npm',
      [
        'publish',
        tarball,
        '--tag',
        'latest',
        '--registry',
        registryUrl,
        '--userconfig',
        userconfig,
      ],
      { cwd: work, timeoutMs: Math.min(300_000, remaining(deadline)) },
    );
  }
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
async function serveOnLoopback(listener, what) {
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
  await execOk(name, ['mkdir', '-p', WORK_IN], {
    timeoutMs: Math.min(60_000, remaining(deadline)),
  });
}

/**
 * `/runner`: the browser tests, their config and the harness, with `@playwright/test` installed from
 * a cache of its own, so the user's npm cache stays cold for the timed steps.
 *
 * @param {string} machine @param {string} work @param {number} deadline
 */
async function prepareRunner(machine, work, deadline) {
  const stage = path.join(work, 'runner');
  mkdirSync(path.join(stage, 'tests', 'journey'), { recursive: true });
  copyFileSync(path.join(ROOT, CONFIG_FILE), path.join(stage, CONFIG_FILE));
  for (const file of [
    SPEC_FILE,
    VIEWER_SPEC_FILE,
    TOOLS_SPEC_FILE,
    RELEASE_SPEC_FILE,
    FEEDBACK_SPEC_FILE,
    PINNED_SPEC_FILE,
    ORIGINS_SPEC_FILE,
    FIRST_HOUR_SPEC_FILE,
    HARNESS_FILE,
  ]) {
    copyFileSync(path.join(HERE, file), path.join(stage, 'tests', 'journey', file));
  }
  copyFileSync(path.join(ROOT, QUICKSTART_PAGE), path.join(stage, 'quickstart.mdx'));
  writeFileSync(
    path.join(stage, 'package.json'),
    `${JSON.stringify({ name: 'journey-runner', private: true }, null, 2)}\n`,
  );
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
 * One `npm run dev` in the clean machine, read line by line.
 *
 * @param {string} machine @param {string} workdir @param {Readonly<Record<string, string>>} env
 */
export function startDev(machine, workdir, env) {
  const args = ['exec', '--workdir', workdir];
  for (const name of Object.keys(env)) args.push('--env', name);
  args.push(machine, 'sh', '-c', `echo $$ > ${PID_FILE_IN}; exec npm run dev`);
  const child = spawn('docker', args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return watchDev(child, {
    // Ctrl+C as a terminal sends it: SIGINT to the whole process group `npm run dev` leads (the
    // pid file's pid; `docker exec` starts it as a session and group leader). SIGINT to npm alone
    // stops nothing: npm forwards it to `sh -c aw dev`, and the shell neither exits nor passes it
    // on, so `aw` never hears it. A clean stop is aw's 0 or its interrupted 130.
    interrupt: async (limit) => {
      await execOk(machine, ['sh', '-c', `kill -s INT -- "-$(cat ${PID_FILE_IN})"`], {
        timeoutMs: limit(30_000),
      });
    },
    // What is still alive is the evidence a hung stop leaves: the process that ignored the
    // signal, or a grandchild still holding the exec's output open.
    survivors: async () =>
      (
        await exec(machine, ['ps', '-eo', 'pid,ppid,pgid,stat,etime,args', '--forest'], {
          timeoutMs: 30_000,
          quiet: true,
        })
      ).output,
    cleanExits: [0, 130],
  });
}

/**
 * A running `aw dev` (any machine) read line by line: what it printed, whether it is ready and
 * signed in, and how to stop it.
 *
 * @param {import('node:child_process').ChildProcessByStdio<null, import('node:stream').Readable, import('node:stream').Readable>} child
 * @param {{ interrupt: (limit: (capMs: number) => number) => Promise<void>,
 *   survivors: () => Promise<string>, cleanExits: readonly (number | null)[] | null }} how
 *   `interrupt` sends Ctrl+C to what `child` started; `cleanExits` are the exit codes of a clean
 *   stop (or a death by the SIGINT itself), or null when the machine can only kill (Windows has
 *   no SIGINT for a process tree)
 */
export function watchDev(child, how) {
  const state = {
    log: '',
    ready: /** @type {string | null} */ (null),
    signedIn: false,
    widget: /** @type {string | null} */ (null),
    modelConnection: false,
    /** How many `synced:` lines it printed. */
    syncs: 0,
    warning: /** @type {string | null} */ (null),
    /** The bootstrap admin's email, from the ready screen's console row. */
    adminEmail: /** @type {string | null} */ (null),
    exit: /** @type {number | null | undefined} */ (undefined),
  };
  let pending = '';
  /** Echo and log one piece of output, scrubbed. @param {string} text */
  const echo = (text) => {
    state.log += text;
    process.stdout.write(scrub(text));
  };
  /**
   * Whole lines only, each parsed before it is echoed.
   *
   * @param {Buffer} chunk
   */
  const read = (chunk) => {
    pending += chunk.toString('utf8');
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const parsed = parseDevLine(line);
      if (parsed?.kind === 'adminSignIn') state.adminEmail ??= parsed.email;
      echo(`${line}\n`);
      const origin = devOrigin(parsed);
      if (origin !== null) state.ready ??= origin;
      if (parsed?.kind === 'signedIn') state.signedIn = true;
      else if (parsed?.kind === 'widget') state.widget ??= parsed.src;
      else if (parsed?.kind === 'modelConnection') state.modelConnection = true;
      else if (parsed?.kind === 'synced') state.syncs += 1;
      else if (REFUSAL_LINE.test(line.trim())) state.warning ??= line.trim();
    }
  };
  child.stdout.on('data', read);
  child.stderr.on('data', read);
  /** The signal that ended it, if one did (macOS reports our SIGINT this way, with no code). */
  let signal = /** @type {NodeJS.Signals | null} */ (null);
  /** @type {Promise<number | null>} */
  const exited = new Promise((resolve) => {
    child.once('close', (code, closeSignal) => {
      signal = closeSignal;
      if (pending !== '') echo(pending);
      pending = '';
      state.exit = code;
      resolve(code);
    });
  });

  /**
   * Until `predicate` holds for what `aw dev` printed, or a refusal, an exit or the timeout, each
   * failure naming the line `missing()` says is still missing.
   *
   * @param {(current: typeof state) => boolean} predicate @param {() => string} missing
   * @param {number} timeoutMs
   */
  async function until(predicate, missing, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (state.warning !== null) throw new JourneyFailure(`aw dev: ${scrub(state.warning)}`);
      if (state.exit !== undefined) {
        throw new JourneyFailure(
          `npm run dev exited ${String(state.exit)} before the ${missing()} line`,
        );
      }
      if (predicate(state)) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new JourneyFailure(
      `npm run dev printed no ${missing()} line within ${String(Math.round(timeoutMs / 1000))} s`,
    );
  }

  return {
    state,
    exited,
    until,
    /** Until `ready`, `signed in` and the `widget:` line, or a refusal. @param {number} timeoutMs */
    async untilWidget(timeoutMs) {
      await until(
        (current) => current.ready !== null && current.signedIn && current.widget !== null,
        () => (state.ready === null ? 'ready' : state.signedIn ? 'widget:' : 'signed in'),
        timeoutMs,
      );
      if (state.ready === null || state.widget === null) {
        throw new JourneyFailure('npm run dev reported no ready or widget: line');
      }
      return { ready: state.ready, widget: state.widget };
    },
    /** @param {(capMs: number) => number} limit */
    async stop(limit) {
      await how.interrupt(limit);
      const waitMs = limit(90_000);
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve('timeout'), waitMs);
      });
      const code = await Promise.race([exited, timeout]);
      clearTimeout(timer);
      if (code === 'timeout') {
        throw new JourneyFailure(
          `npm run dev did not stop within ${String(Math.round(waitMs / 1000))} s of SIGINT; still running:\n${scrub(await how.survivors())}`,
        );
      }
      const diedOfSigint = code === null && signal === 'SIGINT';
      if (
        how.cleanExits !== null &&
        !diedOfSigint &&
        !how.cleanExits.includes(/** @type {number | null} */ (code))
      ) {
        throw new JourneyFailure(
          `npm run dev exited ${String(code)} (signal ${signal ?? 'none'}) on SIGINT, not cleanly`,
        );
      }
    },
    kill() {
      if (state.exit === undefined) child.kill('SIGKILL');
    },
  };
}

/**
 * The browser step in the clean machine; its first-token latency, in seconds. In stub mode the
 * spec also sees the fake's own wording.
 *
 * @param {string} machine @param {string} baseUrl @param {string} nonce @param {number} timeoutMs
 * @param {boolean} live
 */
async function widgetTest(machine, baseUrl, nonce, timeoutMs, live) {
  const result = await execOk(
    machine,
    ['npx', 'playwright', 'test', '--config', CONFIG_IN, SPEC_FILE],
    {
      workdir: RUNNER_IN,
      env: {
        JOURNEY_BASE_URL: baseUrl,
        JOURNEY_NONCE: nonce,
        JOURNEY_DEMO_DIR: DEMO_IN,
        JOURNEY_BRAND_COLOUR,
        ...stubExpectation(live, `Fake Anthropic reply to ${nonce}`),
        npm_config_cache: RUNNER_CACHE_IN,
      },
      timeoutMs,
    },
  );
  return firstTokenOf(result.output);
}

/**
 * The first-hour stopwatch (issue #700): `first-hour.e2e.mjs` in the clean machine, then its
 * record to `first-hour-timings.json` and the job summary. Its timeout is its own, not B1's.
 *
 * @param {string} machine @param {string} work @param {Readonly<Record<string, string>>} anthropic @param {boolean} live
 */
async function firstHourStopwatch(machine, work, anthropic, live) {
  const out = `${WORK_IN}/first-hour.json`;
  // Only `npx playwright` gets the runner cache; the spec strips it for the user's commands.
  try {
    await execOk(
      machine,
      ['npx', 'playwright', 'test', '--config', CONFIG_IN, FIRST_HOUR_SPEC_FILE],
      {
        workdir: RUNNER_IN,
        env: {
          ...anthropic,
          ...stubExpectation(live, 'Fake Anthropic reply'),
          JOURNEY_FIRST_HOUR_DIR: `${WORK_IN}/fh`,
          JOURNEY_FIRST_HOUR_OUT: out,
          JOURNEY_QUICKSTART: `${RUNNER_IN}/quickstart.mdx`,
          npm_config_cache: RUNNER_CACHE_IN,
        },
        timeoutMs: FIRST_HOUR_EXEC_MS,
      },
    );
  } finally {
    // A failing run keeps the timings it measured; a missing record never hides the failure.
    const record = await exec(machine, ['cat', out], { timeoutMs: 60_000, quiet: true });
    if (record.status === 0) {
      writeFileSync(path.join(work, 'first-hour-timings.json'), record.stdout);
      appendSummary(firstHourSummaryMarkdown(JSON.parse(record.stdout).steps));
    }
  }
  say('journey: first-hour stopwatch written to first-hour-timings.json');
}

/** @param {string} machine @param {number} timeoutMs @param {string} [dir] */
async function snapshotDemo(machine, timeoutMs, dir = DEMO_IN) {
  const result = await execOk(machine, ['node', HARNESS_IN, 'snapshot', dir], {
    timeoutMs,
    quiet: true,
  });
  return stringMapOf(result.stdout, 'harness.mjs snapshot');
}

function nonce() {
  return `${NONCE_PREFIX}${randomBytes(8).toString('hex')}`;
}

/**
 * Writes `contents` to `file` (absolute, in the clean machine) over the exec's stdin, creating
 * its directory: what a person saving a file in an editor does.
 *
 * @param {string} machine @param {string} file @param {string} contents @param {number} timeoutMs
 */
async function writeIn(machine, file, contents, timeoutMs) {
  await execOk(machine, ['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', file], {
    input: contents,
    timeoutMs,
    quiet: true,
  });
}

/** @param {string} machine @param {string} file @param {number} timeoutMs */
async function readIn(machine, file, timeoutMs) {
  return (await execOk(machine, ['cat', file], { timeoutMs, quiet: true })).stdout;
}

/**
 * One test of `tools.e2e.mjs`, picked by `grep` (`look change` or `tool answer`); its output.
 *
 * @param {string} machine @param {string} baseUrl @param {string} grep
 * @param {Readonly<Record<string, string>>} env @param {number} timeoutMs
 */
async function toolsTest(machine, baseUrl, grep, env, timeoutMs) {
  const result = await execOk(
    machine,
    ['npx', 'playwright', 'test', '--config', CONFIG_IN, TOOLS_SPEC_FILE, '--grep', grep],
    {
      workdir: RUNNER_IN,
      env: { JOURNEY_BASE_URL: baseUrl, ...env, npm_config_cache: RUNNER_CACHE_IN },
      timeoutMs,
    },
  );
  return result.output;
}

/**
 * Issue #618: write `evals/<agent>.yaml` with two cases the stub model answers deterministically
 * (the orders tool for a prompt with a nonce, the slice-1 reply for one without), run
 * `aw eval <agent> --json`, and require 2/2, score 1 and a stored id. Says the step's seconds.
 *
 * @param {string} machine @param {{ readonly source: string }} agent
 * @param {readonly { nonce: string | null, toolNames: readonly string[] }[]} toolRequests
 * @param {string} toolNonce a nonce whose turn offered the orders tool, to read the tool's name
 * @param {(capMs: number) => number} limit
 */
async function evaluateAgainstStub(machine, agent, toolRequests, toolNonce, limit) {
  const started = performance.now();
  const name = agentNameOfSource(agent.source);
  const tool = toolRequests
    .filter((request) => request.nonce === toolNonce)
    .flatMap((request) => request.toolNames)
    .find((toolName) => toolName.endsWith('__getOrderByOrderNumber'));
  if (tool === undefined) throw new JourneyFailure('no model request offered the orders tool');
  const evalNonce = nonce();
  const cases = [
    'cases:',
    '  - name: order status uses the tool',
    `    input: "What is the status of order ${evalNonce}?"`,
    `    expect: { tool: ${JSON.stringify(tool)}, contains: ["order-data-${evalNonce}"] }`,
    '  - name: no refund promises',
    '    input: "I want my money back now"',
    '    expect: { notContains: ["refund"] }',
    '',
  ].join('\n');
  await writeIn(machine, `${DEMO_IN}/evals/${name}.yaml`, cases, limit(30_000));
  const result = await execOk(machine, ['npx', 'aw', 'eval', name, '--json'], {
    workdir: DEMO_IN,
    timeoutMs: limit(240_000),
    quiet: true,
  });
  /** @type {{ id?: unknown, passed?: unknown, total?: unknown, score?: unknown, results?: unknown }} */
  const evaluation = JSON.parse(result.stdout);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  if (
    evaluation.passed !== 2 ||
    evaluation.total !== 2 ||
    evaluation.score !== 1 ||
    typeof evaluation.id !== 'string' ||
    !uuid.test(evaluation.id)
  ) {
    throw new JourneyFailure(`aw eval did not pass 2/2: ${JSON.stringify(evaluation.results)}`);
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  say(`journey: aw eval ${name} passed 2/2, stored as evaluation ${evaluation.id} (${seconds}s)`);
}

/**
 * The project's one agent file, `agents/<name>.ts`.
 *
 * @param {string} machine @param {(capMs: number) => number} limit
 */
async function agentFile(machine, limit) {
  const listing = await execOk(machine, ['ls', 'agents'], {
    workdir: DEMO_IN,
    timeoutMs: limit(30_000),
    quiet: true,
  });
  const files = listing.stdout.split('\n').filter((file) => file.endsWith('.ts'));
  const [file] = files;
  if (file === undefined || files.length !== 1) {
    throw new JourneyFailure(`demo/agents holds ${String(files.length)} agent files, not one`);
  }
  const source = await execOk(machine, ['cat', `agents/${file}`], {
    workdir: DEMO_IN,
    timeoutMs: limit(30_000),
    quiet: true,
  });
  return { file: `agents/${file}`, source: source.stdout };
}

/**
 * A copy of `demo/` whose agent has an `mcp()` tool on engine `pi` (no MCP client): `aw check`
 * must refuse it with `422 engine_capability_unsupported [mcp]`. The connector is created through
 * `aw` first, because the save pipeline resolves names before it checks capabilities.
 *
 * @param {string} machine @param {{ file: string, source: string }} agent
 * @param {(capMs: number) => number} limit
 */
async function checkMcpOnPi(machine, agent, limit) {
  await execOk(machine, ['sh', '-c', `cat > ${CONNECTOR_FILE_IN}`], {
    input: JSON.stringify({ name: CONNECTOR_NAME, transport: 'http', url: CONNECTOR_URL }),
    timeoutMs: limit(30_000),
  });
  await execOk(machine, ['npx', 'aw', 'connectors', 'create', '--file', CONNECTOR_FILE_IN], {
    workdir: DEMO_IN,
    timeoutMs: limit(120_000),
  });
  await execOk(
    machine,
    [
      'sh',
      '-c',
      `mkdir ${DEMO_MCP_IN} && tar -C ${DEMO_IN} --exclude=./node_modules --exclude=./.agent-workspace -cf - . | tar -C ${DEMO_MCP_IN} -xf - && ln -s ../demo/node_modules ${DEMO_MCP_IN}/node_modules`,
    ],
    { timeoutMs: limit(120_000) },
  );
  await execOk(machine, ['sh', '-c', `cat > ${DEMO_MCP_IN}/${agent.file}`], {
    input: mcpAgentSource(agent.source, CONNECTOR_NAME),
    timeoutMs: limit(30_000),
  });
  const check = await exec(machine, ['npx', 'aw', 'check'], {
    workdir: DEMO_MCP_IN,
    timeoutMs: limit(180_000),
  });
  const expected = `${agent.file}: 422 engine_capability_unsupported [mcp]`;
  if (
    check.status !== 1 ||
    !check.output.split('\n').some((line) => line.trim().endsWith(expected))
  ) {
    throw new JourneyFailure(
      `aw check on mcp() with engine pi exited ${String(check.status)} without "${expected}"`,
    );
  }
  say(`journey: ${expected}`);
}

/**
 * A Viewer key cannot save: `aw check` with it is refused with `403 forbidden`. `viewer.e2e.mjs`
 * mints the key as a person does on the local runtime, signed in to the workspace in the browser
 * as the bootstrap admin, because `aw` holds the local runtime's own key, which may not mint one
 * (S1-21). The ready screen names the admin but never prints the password (BH061-011), so it is
 * read from `.agent-workspace/secrets/local-secrets.json` and reaches the spec through that one
 * `docker exec`'s environment.
 *
 * @param {string} machine @param {string} baseUrl
 * @param {string | null} email
 * @param {(capMs: number) => number} limit
 */
async function checkViewerForbidden(machine, baseUrl, email, limit) {
  if (email === null) {
    throw new JourneyFailure('the first npm run dev named no bootstrap admin to sign in as');
  }
  const secrets = await exec(machine, ['cat', '.agent-workspace/secrets/local-secrets.json'], {
    workdir: DEMO_IN,
    quiet: true,
    timeoutMs: limit(30_000),
  });
  /** @type {unknown} */
  const stored = secrets.status === 0 ? JSON.parse(secrets.stdout) : null;
  const password =
    typeof stored === 'object' && stored !== null && 'BOOTSTRAP_ADMIN_PASSWORD' in stored
      ? stored.BOOTSTRAP_ADMIN_PASSWORD
      : undefined;
  if (typeof password !== 'string') {
    throw new JourneyFailure(
      '.agent-workspace/secrets/local-secrets.json holds no bootstrap admin password',
    );
  }
  SECRETS.add(password);
  const admin = { email, password };
  await execOk(machine, ['npx', 'playwright', 'test', '--config', CONFIG_IN, VIEWER_SPEC_FILE], {
    workdir: RUNNER_IN,
    env: {
      JOURNEY_BASE_URL: baseUrl,
      JOURNEY_DEMO_DIR: DEMO_IN,
      JOURNEY_ADMIN_EMAIL: admin.email,
      JOURNEY_ADMIN_PASSWORD: admin.password,
      npm_config_cache: RUNNER_CACHE_IN,
    },
    timeoutMs: limit(300_000),
  });
  say('journey: a Viewer key is refused with 403 forbidden');
}

/**
 * Issue #622's demo through `origins.e2e.mjs`: with `allowedOrigins` in `surfaces/main.ts`, the
 * one-tag snippet answers on the listed origin and is refused on another, and a `<Chat baseUrl>`
 * page from `@indx-workspace/react` on the listed origin runs a turn while an unlisted one is
 * refused by CORS. It runs before {@link checkPromoteRollback}, while public surfaces still serve
 * `local`, the pointer its edit moves; it puts `surfaces/main.ts` back as it found it.
 *
 * @param {string} machine @param {string} baseUrl @param {(capMs: number) => number} limit
 */
async function checkAllowedOrigins(machine, baseUrl, limit) {
  await execOk(machine, ['npx', 'playwright', 'test', '--config', CONFIG_IN, ORIGINS_SPEC_FILE], {
    workdir: RUNNER_IN,
    env: {
      JOURNEY_BASE_URL: baseUrl,
      JOURNEY_NONCE: nonce(),
      JOURNEY_DEMO_DIR: DEMO_IN,
      npm_config_cache: RUNNER_CACHE_IN,
    },
    timeoutMs: limit(300_000),
  });
  say(
    'journey: the widget and a cross-origin <Chat baseUrl> turn answered on an allowed origin and were refused on another',
  );
}

/**
 * Issue #615's demo through `release.e2e.mjs`: `aw promote` and `aw rollback` move `production`
 * and `aw versions` shows both moves. Public surfaces still serve `local`, and the restart check
 * compares version counts, not pointers, so moving `production` here disturbs no later check.
 *
 * @param {string} machine @param {(capMs: number) => number} limit
 */
async function checkPromoteRollback(machine, limit) {
  await execOk(machine, ['npx', 'playwright', 'test', '--config', CONFIG_IN, RELEASE_SPEC_FILE], {
    workdir: RUNNER_IN,
    env: { JOURNEY_DEMO_DIR: DEMO_IN, npm_config_cache: RUNNER_CACHE_IN },
    timeoutMs: limit(300_000),
  });
  say('journey: aw promote and aw rollback move production, aw versions shows both moves');
}

/**
 * Issue #619's demo through `release.e2e.mjs`, against the `aw dev` started with
 * {@link PROMOTION_BAR_YAML} and after `evals/<agent>.yaml` passed: a failing case blocks
 * promotion, and fixing it lets promotion through.
 *
 * @param {string} machine @param {(capMs: number) => number} limit
 */
async function checkPromotionGate(machine, limit) {
  const output = await execOk(
    machine,
    ['npx', 'playwright', 'test', '--config', CONFIG_IN, RELEASE_SPEC_FILE],
    {
      workdir: RUNNER_IN,
      env: {
        JOURNEY_DEMO_DIR: DEMO_IN,
        JOURNEY_PROMOTION_BAR: '1',
        npm_config_cache: RUNNER_CACHE_IN,
      },
      timeoutMs: limit(600_000),
    },
  );
  const line = /journey: the promotion gate [^\n]*/u.exec(output.output)?.[0];
  say(line ?? 'journey: the promotion gate refused a failing case and passed the fix');
}

/**
 * Issue #620: a thumbs-down in the widget, listed by `aw feedback --negative`, added with
 * `aw eval add-case --yes`, makes `aw eval` fail on that case. `feedback.e2e.mjs` puts
 * `evals/<agent>.yaml` back as it found it.
 *
 * @param {string} machine @param {string} baseUrl @param {(capMs: number) => number} limit
 */
async function checkFeedbackFails(machine, baseUrl, limit) {
  await execOk(machine, ['npx', 'playwright', 'test', '--config', CONFIG_IN, FEEDBACK_SPEC_FILE], {
    workdir: RUNNER_IN,
    env: {
      JOURNEY_BASE_URL: baseUrl,
      JOURNEY_NONCE: nonce(),
      JOURNEY_DEMO_DIR: DEMO_IN,
      npm_config_cache: RUNNER_CACHE_IN,
    },
    timeoutMs: limit(300_000),
  });
  say('journey: a thumbs-down in the widget and from aw runs rate became eval cases aw eval fails');
}

/**
 * Issue #612: a conversation open on v1 keeps answering as v1 after v2 is pushed, and (issue #618)
 * `aw eval <agent> <v1>` answers as v1 while `local` is on v2. `pinned.e2e.mjs` puts the agent file
 * and `evals/<agent>.yaml` back as it found them.
 *
 * @param {string} machine @param {string} baseUrl @param {(capMs: number) => number} limit
 */
async function checkPinnedVersion(machine, baseUrl, limit) {
  await execOk(machine, ['npx', 'playwright', 'test', '--config', CONFIG_IN, PINNED_SPEC_FILE], {
    workdir: RUNNER_IN,
    env: {
      JOURNEY_BASE_URL: baseUrl,
      JOURNEY_NONCE: nonce(),
      JOURNEY_DEMO_DIR: DEMO_IN,
      npm_config_cache: RUNNER_CACHE_IN,
    },
    timeoutMs: limit(300_000),
  });
  say(
    'journey: an open conversation stayed on v1 after v2 was pushed, and aw eval v1 answered as v1',
  );
}

/**
 * @param {string} machine @param {string} agentId @param {(capMs: number) => number} limit
 */
async function versionsOf(machine, agentId, limit) {
  const listing = await execOk(
    machine,
    ['npx', 'aw', 'agents', 'versions', 'list', agentId, '--json'],
    {
      workdir: DEMO_IN,
      timeoutMs: limit(120_000),
      quiet: true,
    },
  );
  return JSON.stringify(JSON.parse(listing.stdout));
}

/**
 * @param {string} evidence @param {string} name @param {string} text
 */
function writeEvidence(evidence, name, text) {
  writeFileSync(path.join(evidence, name), scrub(text));
}

/**
 * The container's Playwright report and test results, through the same {@link SECRETS} pass as
 * the logs: a text file is redacted in place, a binary file holding a secret is removed.
 *
 * @param {string} machine @param {string} evidence
 */
function copyEvidence(machine, evidence) {
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

async function main() {
  // Before any Docker work: `--live` without its key stops here, naming the secret.
  const args = process.argv.slice(2);
  // `--first-hour` (issue #700) runs only the first-hour stopwatch, in place of the journey.
  const { firstHour, rest } = splitFirstHour(args);
  const mode = journeyMode(rest, process.env);
  if (mode.live) SECRETS.add(mode.apiKey);
  // Read once; no child (npm, the publish, the docker CLI) inherits it. Only `aw dev`'s exec gets
  // it, by name, from `mode.apiKey`.
  delete process.env['ANTHROPIC_API_KEY'];
  const work = path.resolve(
    workDirectoryOf(process.env['JOURNEY_WORK_DIR']) ??
      mkdtempSync(path.join(tmpdir(), 'journey-')),
  );
  mkdirSync(work, { recursive: true });
  const evidence = path.join(work, 'evidence');
  mkdirSync(evidence, { recursive: true });
  const registryPort = positiveIntegerVariable('JOURNEY_REGISTRY_PORT', 4873, { max: 65_535 });
  const prepareMs = positiveIntegerVariable(PREPARE_VARIABLE, PREPARE_BUDGET_MS);
  const checksMs = positiveIntegerVariable(CHECKS_VARIABLE, CHECKS_BUDGET_MS);
  const deadline = Date.now() + prepareMs;
  // The post-publish smoke (issue #608): a named registry replaces Verdaccio and the publish.
  const published = registryOf(process.env['JOURNEY_REGISTRY']);
  const registryUrl = published ?? `http://127.0.0.1:${String(registryPort)}/`;
  const suffix = randomBytes(4).toString('hex');
  const registry = `journey-registry-${suffix}`;
  const machine = `journey-machine-${suffix}`;
  /** The registry token's directory: never under `work`, removed however the run ends. */
  const secrets = mkdtempSync(path.join(tmpdir(), 'journey-secrets-'));
  /** @type {import('../generated-project/fake-anthropic.mjs').FakeRequestRecord[]} */
  const requests = [];
  /** @type {import('./fake-anthropic-tools.mjs').ToolRequestRecord[]} */
  const toolRequests = [];
  /** Every model request's raw body, for the secret check. @type {string[]} */
  const bodies = [];
  /** @type {import('./fake-anthropic-tools.mjs').OrdersCall[]} */
  const calls = [];
  const ordersApi = createOrdersApi(calls);
  /** @type {ReturnType<typeof startDev>[]} */
  const devs = [];
  /** @type {{ port: number, close: () => void } | undefined} */
  let fake;
  /** @type {{ port: number, close: () => void } | undefined} */
  let orders;
  /**
   * The timed part's progress, so a failure inside it still leaves the timings it measured.
   * @type {JourneyProgress | undefined}
   */
  let timing;

  try {
    if (published !== null) {
      say(`== installing the published packages from ${registryUrl}`);
    } else {
      say(`== starting Verdaccio on ${registryUrl}`);
      await startRegistry(registry, registryPort, deadline);
      say('== packing and publishing the eight @indx-workspace packages');
      await publishPackages(work, secrets, registryUrl, deadline);
    }

    const fakeKey = `${FAKE_KEY_PREFIX}${randomBytes(16).toString('hex')}`;
    SECRETS.add(fakeKey);
    /**
     * The one switch point (issue #609): the real API under the repository secret, or the fake on
     * the host's loopback. Every check but the fake's own records runs the same in both.
     * @type {Record<string, string>}
     */
    let anthropic;
    if (mode.live) {
      anthropic = { ANTHROPIC_API_KEY: mode.apiKey };
      say('== live: the real Anthropic API, under ANTHROPIC_API_KEY');
    } else {
      fake = await startFakeProvider(requests, toolRequests, bodies);
      anthropic = {
        ANTHROPIC_API_KEY: fakeKey,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${String(fake.port)}`,
      };
      say(`== fake Anthropic API on 127.0.0.1:${String(fake.port)}`);
    }
    orders = await serveOnLoopback(ordersApi.handler, 'the orders API');
    const ordersOrigin = `http://127.0.0.1:${String(orders.port)}`;
    say(`== orders API on ${ordersOrigin}`);
    say('== starting the clean machine');
    await startMachine(machine, registryUrl, deadline);
    say('== preparing /runner');
    await prepareRunner(machine, work, deadline);

    if (firstHour) {
      await firstHourStopwatch(machine, work, anthropic, mode.live);
      process.exitCode = 0;
      return;
    }

    const started = performance.now();
    /** Each timed step may use what is left of the budget, plus a minute to report it. */
    const stepTimeout = () =>
      Math.max(30_000, JOURNEY_BUDGET_SECONDS * 1000 - (performance.now() - started) + 60_000);
    /** @type {{ name: string, seconds: number }[]} */
    const steps = [];
    /** @type {JourneyProgress} */
    const progress = { started, steps, current: null, reported: false };
    timing = progress;
    /** @param {string} name @param {() => Promise<void>} step */
    const timed = (name, step) => timedStep(progress, name, step);

    await timed(
      `npm create @indx-workspace@latest demo (brand colour ${JOURNEY_BRAND_COLOUR})`,
      async () => {
        await execAnswering(machine, `npm create ${CREATE_PACKAGE} demo`, {
          workdir: WORK_IN,
          timeoutMs: stepTimeout(),
          answers: { [promptOf('embedder.brandColour')]: JOURNEY_BRAND_COLOUR },
        });
      },
    );
    // Inside the wall clock: the budget covers the harness's work between the steps too.
    const created = await snapshotDemo(machine, stepTimeout());

    await timed('npm install', async () => {
      await execOk(machine, ['npm', 'install'], { workdir: DEMO_IN, timeoutMs: stepTimeout() });
    });

    /** @type {{ ready: string, widget: string } | undefined} */
    let lines;
    await timed('npm run dev', async () => {
      const dev = startDev(machine, DEMO_IN, anthropic);
      devs.push(dev);
      lines = await dev.untilWidget(stepTimeout());
      if (!dev.state.modelConnection) {
        throw new JourneyFailure('aw dev printed no "model connection: default (anthropic)" line');
      }
    });
    if (lines === undefined) throw new JourneyFailure('npm run dev reported no lines');
    const baseUrl = new URL(lines.ready).origin;
    if (new URL(lines.widget).origin !== baseUrl) {
      throw new JourneyFailure(`the widget line names another origin than ${baseUrl}`);
    }

    const firstNonce = nonce();
    let firstToken = 0;
    await timed('widget answers', async () => {
      firstToken = await widgetTest(machine, baseUrl, firstNonce, stepTimeout(), mode.live);
      if (!mode.live) assertReplyRecorded(requests, firstNonce, fakeKey);
    });
    const wallSeconds = (performance.now() - started) / 1000;

    const report = timingsReport({ steps, wallSeconds });
    for (const step of report.steps) say(`journey: ${step.name} ${String(step.seconds)} s`);
    say(`journey: sum of the steps ${String(report.stepsSeconds)} s`);
    say(totalLine(report));
    /** @type {JourneyTimings} */
    const timings = {
      file: path.join(work, 'journey-timings.json'),
      model: mode.live ? 'live' : 'fake',
      b1: report,
      firstTokenSeconds: {},
      budgets: {},
    };
    appendSummary(stepSummaryMarkdown(report));
    recordFirstToken(timings, 'b1', firstToken);
    writeTimings(timings);
    progress.reported = true;
    assertWithinBudget(report);

    const limit = checksLimit(Date.now() + checksMs);
    assertUnchanged('demo', created, await snapshotDemo(machine, limit(120_000)));
    say('journey: demo/ unchanged after create (runtime-owned paths excluded)');

    const agent = await agentFile(machine, limit);
    await checkMcpOnPi(machine, agent, limit);
    await checkViewerForbidden(machine, baseUrl, devs[0]?.state.adminEmail ?? null, limit);
    await checkAllowedOrigins(machine, baseUrl, limit);
    await checkPromoteRollback(machine, limit);
    await checkFeedbackFails(machine, baseUrl, limit);
    await checkPinnedVersion(machine, baseUrl, limit);

    const agentList = await execOk(machine, ['npx', 'aw', 'agents', 'list', '--json'], {
      workdir: DEMO_IN,
      timeoutMs: limit(120_000),
      quiet: true,
    });
    const agentId = agentIdOf(agentList.stdout, agentNameOfSource(agent.source));
    const versionsBefore = await versionsOf(machine, agentId, limit);
    const first = devs[0];
    if (first === undefined) throw new JourneyFailure('no npm run dev to stop');
    await first.stop(limit);

    const second = startDev(machine, DEMO_IN, {});
    devs.push(second);
    const again = await second.untilWidget(limit(180_000));
    if (second.state.modelConnection) {
      throw new JourneyFailure(
        'the restart created the model connection again: it did not persist',
      );
    }
    if ((await versionsOf(machine, agentId, limit)) !== versionsBefore) {
      throw new JourneyFailure('the agent versions changed across the restart');
    }
    const secondNonce = nonce();
    await widgetTest(machine, new URL(again.ready).origin, secondNonce, limit(240_000), mode.live);
    // The original key: the persisted connection's secret still decrypts after the restart.
    if (!mode.live) assertReplyRecorded(requests, secondNonce, fakeKey);
    say(
      'journey: after a restart without ANTHROPIC_*, the same versions answer with the persisted key',
    );

    // S2-08: B2, B3b and B3a, each on its own clock, in the same container after B1.
    const ordersToken = `${ORDERS_TOKEN_PREFIX}${randomBytes(16).toString('hex')}`;
    SECRETS.add(ordersToken);
    const ordersEnv = { [ORDERS_TOKEN_VARIABLE]: ordersToken };
    const ordersDocument = ordersApi.document(ordersOrigin);
    /** @param {number} capMs */
    const uncapped = (capMs) => capMs;

    // B2: the clock runs from the write of surfaces/main.ts to the launcher showing the colour.
    const surface = await readIn(machine, `${DEMO_IN}/surfaces/main.ts`, 30_000);
    await timedBlock(
      timings,
      {
        key: 'lookChange',
        label: 'B2 look change',
        budgetSeconds: JOURNEY_LOOK_CHANGE_BUDGET_SECONDS,
      },
      async (step, timeout) => {
        await step(`write ${JOURNEY_COLOUR} into surfaces/main.ts`, async () => {
          await writeIn(
            machine,
            `${DEMO_IN}/surfaces/main.ts`,
            withSurfaceColour(surface, JOURNEY_COLOUR),
            timeout(),
          );
        });
        await step(`the launcher shows ${JOURNEY_COLOUR}`, async () => {
          await toolsTest(
            machine,
            new URL(again.ready).origin,
            'look change',
            { JOURNEY_COLOUR },
            timeout(),
          );
        });
      },
    );

    // Issue #619: the bar B3b's restart picks up, untimed. No version is promoted before B3b's.
    await execOk(machine, ['sh', '-c', 'cat >> agent-workspace.yaml'], {
      workdir: DEMO_IN,
      input: PROMOTION_BAR_YAML,
      timeoutMs: 30_000,
    });

    // B3b: from the write of tools/orders.ts to the answer, the stop and the restart included.
    /** @type {ReturnType<typeof startDev> | undefined} */
    let byHand;
    const byHandNonce = nonce();
    await timedBlock(
      timings,
      {
        key: 'toolByHand',
        label: 'B3b openapi tool by hand',
        budgetSeconds: JOURNEY_TOOL_BUDGET_SECONDS,
      },
      async (step, timeout) => {
        await step('write the document, tools/orders.ts and the agent', async () => {
          await writeIn(machine, `${DEMO_IN}/${ORDERS_DOCUMENT}`, ordersDocument, timeout());
          await writeIn(machine, `${DEMO_IN}/tools/orders.ts`, ORDERS_TOOL_SOURCE, timeout());
          await writeIn(
            machine,
            `${DEMO_IN}/${agent.file}`,
            toolAgentSource(agent.source),
            timeout(),
          );
        });
        await step(`restart aw dev with ${ORDERS_TOKEN_VARIABLE}`, async () => {
          await second.stop((capMs) => Math.min(capMs, timeout()));
          // Only the token: the model connection persists from B1.
          byHand = startDev(machine, DEMO_IN, ordersEnv);
          devs.push(byHand);
          await byHand.until(
            (current) => current.ready !== null && current.syncs > 0,
            () => (byHand?.state.ready === null ? 'ready' : 'synced:'),
            timeout(),
          );
        });
        await step('the widget answers with the tool', async () => {
          const ready = byHand?.state.ready ?? null;
          if (ready === null) throw new JourneyFailure('npm run dev printed no ready line');
          const output = await toolsTest(
            machine,
            new URL(ready).origin,
            'tool answer',
            {
              JOURNEY_NONCE: byHandNonce,
              ...stubExpectation(mode.live, `order-data-${byHandNonce}`),
            },
            timeout(),
          );
          assertToolCallSeen(calls, byHandNonce, ordersToken);
          if (!mode.live) assertToolAnswer(requests, byHandNonce);
          recordFirstToken(timings, 'toolByHand', firstTokenOf(output));
        });
      },
    );
    say(`journey: tool call GET /orders/${byHandNonce} seen`);
    // The baseline the ceiling check falsifies: before the ceiling, the agent's Bash is offered.
    if (!mode.live) assertToolOffered(toolRequests, byHandNonce, 'Bash', true);
    // Issue #618: `aw eval` scores local's version on the server against the stub model, while
    // B3b's aw dev is still up. Stub only: a live model's answers are not deterministic.
    if (!mode.live) {
      const evalLimit = checksLimit(Date.now() + checksMs);
      await evaluateAgainstStub(machine, agent, toolRequests, byHandNonce, evalLimit);
      await checkPromotionGate(machine, evalLimit);
    }
    if (byHand === undefined) throw new JourneyFailure('no npm run dev to stop');
    await byHand.stop(uncapped);

    // B3a: from the start of npm create to the answer, with no file edited by hand.
    /** @type {Record<string, string>} */
    let createdTools = {};
    const fromSetupNonce = nonce();
    await timedBlock(
      timings,
      {
        key: 'toolFromSetup',
        label: 'B3a openapi tool from setup',
        budgetSeconds: JOURNEY_TOOL_BUDGET_SECONDS,
      },
      async (step, timeout) => {
        await step(
          `npm create @indx-workspace@latest demo-tools (openapi, ${ORDERS_DOCUMENT})`,
          async () => {
            await execAnswering(machine, `npm create ${CREATE_PACKAGE} demo-tools`, {
              workdir: WORK_IN,
              timeoutMs: timeout(),
              answers: {
                [promptOf('content.internalTools')]: 'openapi',
                [promptOf('content.openapiDocument')]: ORDERS_DOCUMENT,
              },
            });
          },
        );
        createdTools = await snapshotDemo(machine, timeout(), DEMO_TOOLS_IN);
        await step(`copy the orders API's document to ${ORDERS_DOCUMENT}`, async () => {
          // ponytail: document written via cat over exec input; the developer's input, not an edit
          await writeIn(machine, `${DEMO_TOOLS_IN}/${ORDERS_DOCUMENT}`, ordersDocument, timeout());
        });
        await step('npm install', async () => {
          await execOk(machine, ['npm', 'install'], {
            workdir: DEMO_TOOLS_IN,
            timeoutMs: timeout(),
          });
        });
        await step('npm run dev', async () => {
          const dev = startDev(machine, DEMO_TOOLS_IN, { ...anthropic, ...ordersEnv });
          devs.push(dev);
          await dev.untilWidget(timeout());
        });
        await step('the widget answers with the tool', async () => {
          const ready = devs.at(-1)?.state.ready ?? null;
          if (ready === null) throw new JourneyFailure('npm run dev printed no ready line');
          const output = await toolsTest(
            machine,
            new URL(ready).origin,
            'tool answer',
            {
              JOURNEY_NONCE: fromSetupNonce,
              ...stubExpectation(mode.live, `order-data-${fromSetupNonce}`),
            },
            timeout(),
          );
          assertToolCallSeen(calls, fromSetupNonce, ordersToken);
          if (!mode.live) assertToolAnswer(requests, fromSetupNonce);
          recordFirstToken(timings, 'toolFromSetup', firstTokenOf(output));
        });
      },
    );
    say(`journey: tool call GET /orders/${fromSetupNonce} seen`);
    if (!Object.hasOwn(createdTools, 'tools/orders.ts')) {
      throw new JourneyFailure('npm create wrote no tools/orders.ts for the openapi answer');
    }
    assertUnchanged(
      'demo-tools',
      createdTools,
      await snapshotDemo(machine, 120_000, DEMO_TOOLS_IN),
      [ORDERS_DOCUMENT],
    );
    say(`journey: B3a files written: ${Object.keys(createdTools).sort().join(', ')}; none edited`);
    const fromSetup = devs.at(-1);
    if (fromSetup === undefined) throw new JourneyFailure('no npm run dev to stop');
    await fromSetup.stop(uncapped);

    // The ceiling end to end (C13, C14), untimed, under a checks cap of its own.
    const ceilingLimit = checksLimit(Date.now() + checksMs);
    await execOk(machine, ['sh', '-c', 'cat >> agent-workspace.yaml'], {
      workdir: DEMO_IN,
      input: CEILING_YAML,
      timeoutMs: ceilingLimit(30_000),
    });
    const ceilingDev = startDev(machine, DEMO_IN, ordersEnv);
    devs.push(ceilingDev);
    await ceilingDev.until(
      (current) => current.ready !== null && current.log.includes(' policy_cannot_widen'),
      () => (ceilingDev.state.ready === null ? 'ready' : 'policy_cannot_widen'),
      ceilingLimit(240_000),
    );
    // The refused agent prints no surface line, so the origin comes from the ready screen's `try` row.
    const ceilingReady = ceilingDev.state.ready;
    if (ceilingReady === null) throw new JourneyFailure('npm run dev printed no ready line');
    assertServerRefusal(ceilingDev.state.log, agent.file);
    const check = await exec(machine, ['npx', 'aw', 'check'], {
      workdir: DEMO_IN,
      timeoutMs: ceilingLimit(180_000),
    });
    if (check.status !== 1) {
      throw new JourneyFailure(`aw check under the ceiling exited ${String(check.status)}, not 1`);
    }
    assertServerRefusal(check.output, agent.file);
    // The agent saved before the ceiling still answers, composed with Bash denied (S2-04c).
    const ceilingNonce = nonce();
    await toolsTest(
      machine,
      new URL(ceilingReady).origin,
      'tool answer',
      { JOURNEY_NONCE: ceilingNonce, ...stubExpectation(mode.live, `order-data-${ceilingNonce}`) },
      ceilingLimit(300_000),
    );
    assertToolCallSeen(calls, ceilingNonce, ordersToken);
    if (!mode.live) assertToolOffered(toolRequests, ceilingNonce, 'Bash', false);
    say(
      'journey: policy_cannot_widen reported by the server; sync refused; Bash denied at compose',
    );

    // The secret: in no file but the sealed store, no log, no transcript, no request and not in
    // the environment of the runtime aw dev forked.
    const found = await execOk(machine, ['node', HARNESS_IN, 'find', DEMO_IN, DEMO_TOOLS_IN], {
      env: { JOURNEY_SECRET: ordersToken },
      timeoutMs: ceilingLimit(120_000),
      quiet: true,
    });
    const holding = JSON.parse(found.stdout);
    if (!Array.isArray(holding) || holding.length > 0) {
      throw new JourneyFailure(`the token is in files: ${scrub(found.stdout.trim())}`);
    }
    /** @param {string} pidFile */
    const environOf = async (pidFile) =>
      (
        await execOk(
          machine,
          ['sh', '-c', 'tr "\\0" "\\n" < "/proc/$(cat "$1")/environ"', 'sh', pidFile],
          {
            workdir: DEMO_IN,
            timeoutMs: ceilingLimit(30_000),
            quiet: true,
          },
        )
      ).stdout;
    // Positive control: the process aw dev runs in was given the token, so the check can see it.
    if (!(await environOf(PID_FILE_IN)).includes(ordersToken)) {
      throw new JourneyFailure('the environment check cannot see the token');
    }
    const runtimeEnviron = await environOf('.agent-workspace/runtime.pid');
    assertSecretAbsent(
      {
        ...Object.fromEntries(
          devs.map((dev, index) => [`dev-${String(index + 1)}.log`, dev.state.log]),
        ),
        'aw check output': check.output,
        "the runtime's environment": runtimeEnviron,
        'the model requests': bodies.join('\n'),
        'the recorded tool turns': JSON.stringify(toolRequests),
        'the recorded replies': JSON.stringify(requests),
      },
      ordersToken,
    );
    say("journey: token absent from files, logs, transcripts and the runtime's environment");
    await ceilingDev.stop(ceilingLimit);

    say('journey: every check passed');
    process.exitCode = 0;
  } catch (error) {
    if (timing !== undefined && !timing.reported)
      writeUnfinishedTimings(work, timing, mode.live ? 'live' : 'fake');
    // The evidence artifact carries the failure and the failing command's output, not only the log.
    writeEvidence(
      evidence,
      'failure.log',
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    throw error;
  } finally {
    rmSync(secrets, { recursive: true, force: true });
    for (const [index, dev] of devs.entries()) {
      dev.kill();
      writeEvidence(evidence, `dev-${String(index + 1)}.log`, dev.state.log);
    }
    copyEvidence(machine, evidence);
    removeContainer(machine);
    removeContainer(registry);
    fake?.close();
    orders?.close();
  }
}

/**
 * @typedef {{
 *   started: number,
 *   steps: { name: string, seconds: number }[],
 *   current: { name: string, from: number } | null,
 *   reported: boolean,
 * }} JourneyProgress
 */

/**
 * The record of a run that failed inside the timed part: the steps that finished, the one that
 * failed (or the harness work between two steps) and the wall clock until the failure, written
 * where the finished record goes, so the timings the workflow keeps always exist. It never throws,
 * so the failure it records stays the one the run reports.
 *
 * @param {string} work @param {JourneyProgress} timing @param {'fake' | 'live'} model
 */
function writeUnfinishedTimings(work, timing, model) {
  try {
    const report = unfinishedOf(timing, JOURNEY_BUDGET_SECONDS);
    const record = unfinishedJourneyRecord(report, model);
    writeFileSync(path.join(work, 'journey-timings.json'), `${JSON.stringify(record, null, 2)}\n`);
    appendSummary(unfinishedSummaryMarkdown(report));
  } catch (error) {
    say(`journey: the unfinished timings were not written: ${String(error)}`);
  }
}

/**
 * The unfinished record of `timing` as of now, said on stdout.
 *
 * @param {JourneyProgress} timing @param {60 | 600 | 900} budgetSeconds
 */
function unfinishedOf(timing, budgetSeconds) {
  const now = performance.now();
  const failed =
    timing.current === null
      ? { name: 'harness work between the steps', seconds: 0 }
      : { name: timing.current.name, seconds: (now - timing.current.from) / 1000 };
  const report = unfinishedTimingsReport(
    { steps: timing.steps, failed, elapsedSeconds: (now - timing.started) / 1000 },
    budgetSeconds,
  );
  say(
    `journey: ${report.failedStep.name} failed after ${String(report.failedStep.seconds)} s ` +
      `(wall clock ${String(report.elapsedSeconds)} s)`,
  );
  return report;
}

/** Appends Markdown to `$GITHUB_STEP_SUMMARY`, when the workflow gives one. @param {string} markdown */
function appendSummary(markdown) {
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (summary !== undefined && summary !== '') appendFileSync(summary, markdown);
}

/**
 * Runs one timed step of `progress`, recording its seconds and saying them.
 *
 * @param {JourneyProgress} progress @param {string} name @param {() => Promise<void>} step
 */
async function timedStep(progress, name, step) {
  const from = performance.now();
  progress.current = { name, from };
  await step();
  const seconds = (performance.now() - from) / 1000;
  progress.current = null;
  progress.steps.push({ name, seconds });
  say(`journey: ${name} ${seconds.toFixed(1)} s`);
}

/**
 * `journey-timings.json`: B1's record at the top level, as slice 1 wrote it (the manifest reads
 * it there), and S2-08's blocks under `budgets`, finished or not. Issue #609 adds which `model`
 * answered (`fake` or `live`) and each widget answer's first-token latency in seconds
 * (`firstTokenSeconds.b1`, `.toolByHand`, `.toolFromSetup`).
 *
 * @typedef {{ file: string, model: 'fake' | 'live', b1: TimingsReport, firstTokenSeconds: Record<string, number>, budgets: Record<string, TimingsReport | UnfinishedTimingsReport> }} JourneyTimings
 * @typedef {import('./harness.mjs').TimingsReport} TimingsReport
 * @typedef {import('./harness.mjs').UnfinishedTimingsReport} UnfinishedTimingsReport
 */

/** @param {JourneyTimings} timings */
function writeTimings(timings) {
  const record = {
    ...timings.b1,
    model: timings.model,
    firstTokenSeconds: timings.firstTokenSeconds,
    budgets: timings.budgets,
  };
  writeFileSync(timings.file, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * One widget answer's first-token latency (Send to the agent's first text, as the visitor sees
 * it), kept under `firstTokenSeconds.<key>` and said.
 *
 * @param {JourneyTimings} timings @param {string} key @param {number} seconds
 */
function recordFirstToken(timings, key, seconds) {
  timings.firstTokenSeconds[key] = seconds;
  say(`journey: first token (${key}) ${String(seconds)} s`);
  appendSummary(`First token (${key}, Send to the agent's first text): ${String(seconds)} s\n\n`);
}

/**
 * One timed block after B1 (B2, B3b, B3a): its steps on the wall clock against its own budget.
 * `body` gets `step(name, run)` and `timeout()`, what is left of the budget plus a minute to
 * report it. The record is written under `budgets.<key>` whether the block passes or fails, then
 * the total line is said and checked against the budget.
 *
 * @param {JourneyTimings} timings
 * @param {{ key: string, label: string, budgetSeconds: 60 | 900 }} block
 * @param {(step: (name: string, run: () => Promise<void>) => Promise<void>, timeout: () => number) => Promise<void>} body
 */
async function timedBlock(timings, block, body) {
  const started = performance.now();
  /** @type {JourneyProgress} */
  const progress = { started, steps: [], current: null, reported: false };
  const timeout = () =>
    Math.max(30_000, block.budgetSeconds * 1000 - (performance.now() - started) + 60_000);
  try {
    await body((name, run) => timedStep(progress, name, run), timeout);
  } catch (error) {
    try {
      const report = unfinishedOf(progress, block.budgetSeconds);
      timings.budgets[block.key] = report;
      writeTimings(timings);
      appendSummary(unfinishedSummaryMarkdown(report, block.label));
    } catch (unwritten) {
      say(`journey: the ${block.label} timings were not written: ${String(unwritten)}`);
    }
    throw error;
  }
  const report = timingsReport(
    { steps: progress.steps, wallSeconds: (performance.now() - started) / 1000 },
    block.budgetSeconds,
  );
  timings.budgets[block.key] = report;
  writeTimings(timings);
  appendSummary(stepSummaryMarkdown(report, block.label));
  say(totalLine(report, block.label));
  assertWithinBudget(report, block.budgetSeconds);
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(scrub(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
