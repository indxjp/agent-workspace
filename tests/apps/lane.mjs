#!/usr/bin/env node
/* global console, fetch, setTimeout, clearTimeout, AbortSignal */
/**
 * The apps-e2e lane (issue #1531): the cells of the apps benchmark that need an installed app,
 * measured for every app under `examples/` against this checkout's own packages.
 *
 *   pnpm build && node tests/apps/lane.mjs [--app <id>]... [--skip <step>[,<step>]]
 *
 * The packages are packed once. Then, per app, these steps run in order; each step's id is a lane
 * ref an app's `benchmark.ts` may name (`tests/apps/benchmark.test.ts` checks it is one of
 * {@link LANE_STEPS}):
 *
 * - `'regenerate'` (Generated): `commands.sh` again, compared with the app (`regenerate.mjs`).
 * - `'install'`: the app copied to a work directory, its `@indx-workspace/*` packages pointed at
 *   the tarballs (the one edit that is not the developer's), `npm install`, and the repository's
 *   TypeScript and type packages (shortcut: the generated project pins no TypeScript, so
 *   `next build` would install the newest, which dependency-cruiser cannot read, #1510; upgrade
 *   when the template pins it).
 * - `'build'`: `next build`, which type-checks the app (no root gate sees an example).
 * - `'test'` (Agent on data): the app's own `node:test` files under `tests/`, reported per test
 *   (`test-results-reporter.mjs`); the test titled exactly as the app's `agentOnData.ref` must
 *   have run and passed, never skipped, todo or missing (`agentOnDataOutcome`).
 * - `'depcruise'` (No fork): the template's `dependency-cruiser.config.mjs`, which must have
 *   cruised the app's modules, not passed over them.
 * - `'journeys'` (Journeys): `aw dev` on the embedded runtime (no Docker) with the scripted model
 *   (`fake-model.mjs`, the app's `e2e/model-script.json`). The bootstrap Owner signs in to the
 *   console, stores `APP_<NAME>_IDENTITY` there (secrets are an Owner's and `aw dev` holds an Admin
 *   key, #1506) and approves a device code for an `awu_live_` person token, which the app's
 *   `e2e/*.e2e.mjs` send to the app's own API. Their browser signs in through the app's
 *   `/sign-in` at `aw dev`'s development issuer as the same Owner ({@link journeyEnv}, issue
 *   #2075), so the app holds that person's `awo_live_` token and starts and decides runs as them
 *   (`playwright.apps.config.mjs`). They run twice, with the copy's `app/theme.ts` set to each of
 *   {@link JOURNEY_LOCALES}.
 * - `'self-host'` (Self-host): `aw deploy production` plans `single-vm` and `kubernetes` with
 *   `environments.production.apps` naming the app's image, and the rendered `compose.apps.yaml` and
 *   Helm `apps` values must name its image digest and `app_<name>` schema; `npm run image` builds
 *   the image from a fresh copy locked against the lane's loopback registry of the packed packages
 *   (`package-server.mjs`, reached with `--network host`), a throwaway `registry:2` gives its
 *   digest, and once every app is through, the platform boots with every app's image in the
 *   overlay and each answers `/api/health` with `DATABASE_URL` for its own role, never the
 *   platform's. Needs Docker.
 *
 * After every app, one scenario that measures no cell: `'blueprint'` (`blueprint.mjs`, ADR-0166)
 * installs a fixture app blueprint taken from `examples/service-desk` into a fresh copy of
 * `examples/minimal` with `aw blueprint add`, builds and tests it, proposes, applies and refuses
 * updates, and removes it. It runs when `minimal` is among the apps and `--skip` does not name
 * it; when it fails, the run fails.
 *
 * A step that fails, cannot run (Docker missing, `--skip`, a step it needs failed) or proves
 * nothing is a `gap` for its cell, with the reason, never `ok`. The lane then compares: a cell the
 * app claims (`benchmark.ts` for Journeys, Agent on data and Self-host; `ok` for Generated and No
 * fork, which `pnpm test` computes) but the lane measured as a gap fails the run, and so does a
 * journey that fails other than the ones a declared Journeys gap names. A declared gap the lane
 * measured `ok` is a notice to flip it. The verdicts go to `lane-report.json` in the work
 * directory and, in CI, to the job summary.
 *
 * It needs `npm`, network access to the npm registry, Playwright's Chromium and, for Self-host,
 * Docker. Environment: `APPS_WORK_DIR` (default: a new temporary directory, kept when the run
 * fails) and `APPS_LANE_TIMEOUT_MS` (80 minutes: the cap on the whole run).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

import {
  TYPE_CHECK_PACKAGES,
  freePort,
  packPackages,
  signIn,
  signInConfigured,
  startDev,
  storeAppIdentity,
} from '../app-kit/run.mjs';
import { buildPinnedImages, checkoutRevision } from '../generated-project/images.mjs';
import { REGISTRY_IMAGE, positiveIntegerVariable } from '../generated-project/run.mjs';
import { runBlueprintScenario } from './blueprint.mjs';
import { readModelScript, startFakeModel } from './fake-model.mjs';
import { spawnPackageServer } from './package-server.mjs';
import { differingFromExample, regenerate } from './regenerate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXAMPLES = path.join(ROOT, 'examples');
/** The `node --test` reporter the test step writes each test's result with. */
export const TEST_RESULTS_REPORTER = path.join(ROOT, 'tests/apps/test-results-reporter.mjs');

/** The lane's steps, in the order they run; each id is a lane ref. */
export const LANE_STEPS = [
  'regenerate',
  'install',
  'build',
  'test',
  'depcruise',
  'journeys',
  'self-host',
];

/** The benchmark cell each step measures. */
export const STEP_CELLS = {
  regenerate: 'generated',
  install: 'agentOnData',
  build: 'agentOnData',
  test: 'agentOnData',
  depcruise: 'noFork',
  journeys: 'journeys',
  'self-host': 'selfHost',
};

/** The steps each step needs to have passed. */
export const STEP_NEEDS = {
  regenerate: [],
  install: [],
  build: ['install'],
  test: ['install'],
  depcruise: ['install'],
  journeys: ['install'],
  'self-host': ['install'],
};

/**
 * The scenarios that run once, after every app, and measure no benchmark cell; `--skip` takes
 * their ids as it takes a step's. `'blueprint'` runs only when `minimal` is among the apps.
 */
export const LANE_SCENARIOS = ['blueprint'];

/** The cells the lane measures, in the scoreboard's order. */
export const LANE_CELLS = ['generated', 'journeys', 'agentOnData', 'selfHost', 'noFork'];

/** The cells an app declares in `benchmark.ts`; the lane takes the others as claimed `ok`. */
const DECLARED_CELLS = ['journeys', 'agentOnData', 'selfHost'];

/**
 * The command line: every `--app <id>` (default: every registered app) and the steps `--skip`
 * names. Throws naming the first argument it does not take.
 *
 * @param {readonly string[]} argv @param {readonly string[]} registered
 * @returns {{ apps: string[], skip: Set<string> }}
 */
export function parseLaneArgs(argv, registered) {
  /** @type {string[]} */
  const apps = [];
  const skip = new Set();
  for (let at = 0; at < argv.length; at += 2) {
    const [flag, value] = [argv[at], argv[at + 1]];
    if (value === undefined || (flag !== '--app' && flag !== '--skip')) {
      throw new Error('usage: node tests/apps/lane.mjs [--app <id>]... [--skip <step>[,<step>]]');
    }
    if (flag === '--app') {
      if (!registered.includes(value)) throw new Error(`${value} is not a registered app`);
      apps.push(value);
      continue;
    }
    for (const step of value.split(',')) {
      if (!LANE_STEPS.includes(step) && !LANE_SCENARIOS.includes(step)) {
        throw new Error(`${step} is not a lane step`);
      }
      skip.add(step);
    }
  }
  return { apps: apps.length === 0 ? [...registered] : apps, skip };
}

/**
 * Why `step` cannot run, given the outcomes so far and the skipped steps; `undefined` when it can.
 *
 * @param {string} step @param {ReadonlyMap<string, { status: string }>} outcomes
 * @param {ReadonlySet<string>} skip
 */
export function blockedReason(step, outcomes, skip) {
  if (skip.has(step)) return 'skipped by --skip';
  const failed = STEP_NEEDS[step].find((need) => outcomes.get(need)?.status !== 'ok');
  return failed === undefined ? undefined : `needs ${failed}, which did not pass`;
}

/**
 * Each lane cell's verdict from its steps' outcomes: `ok` only when it has steps and every one
 * passed; otherwise a `gap` with each step's reason.
 *
 * @param {ReadonlyMap<string, { status: 'ok' | 'failed' | 'gap', reason: string }>} outcomes
 * @returns {Record<string, { verdict: 'ok' | 'gap', reasons: string[] }>}
 */
export function cellVerdicts(outcomes) {
  /** @type {Record<string, { verdict: 'ok' | 'gap', reasons: string[] }>} */
  const verdicts = {};
  for (const cell of LANE_CELLS) {
    const steps = LANE_STEPS.filter((step) => STEP_CELLS[step] === cell);
    const reasons = steps.flatMap((step) => {
      const outcome = outcomes.get(step);
      if (outcome === undefined) return [`${step}: did not run`];
      return outcome.status === 'ok' ? [] : [`${step}: ${outcome.reason}`];
    });
    verdicts[cell] = { verdict: reasons.length === 0 ? 'ok' : 'gap', reasons };
  }
  return verdicts;
}

/**
 * What the app claims for `cell`: its declared verdict, or `ok` for a computed cell.
 *
 * @param {{ cells: Record<string, { verdict: 'ok' | 'gap' }> }} benchmark @param {string} cell
 */
export function claimedVerdict(benchmark, cell) {
  return DECLARED_CELLS.includes(cell) ? (benchmark.cells[cell]?.verdict ?? 'gap') : 'ok';
}

/**
 * The lane's findings for one app: `failures` (a claimed `ok` measured as a gap, and each journey
 * problem no declared gap excuses) fail the run; `notices` (a declared gap measured `ok`) do not.
 *
 * @param {{ id: string, cells: Record<string, { verdict: 'ok' | 'gap' }> }} benchmark
 * @param {Record<string, { verdict: 'ok' | 'gap', reasons: string[] }>} verdicts
 * @param {readonly string[]} [unexcused] the journeys step's problems no declared gap excuses
 */
export function laneFindings(benchmark, verdicts, unexcused = []) {
  /** @type {string[]} */
  const failures = unexcused.map((problem) => `${benchmark.id}: ${problem}`);
  /** @type {string[]} */
  const notices = [];
  for (const cell of LANE_CELLS) {
    const measured = verdicts[cell]?.verdict ?? 'gap';
    const claimed = claimedVerdict(benchmark, cell);
    if (claimed === 'ok' && measured === 'gap') {
      failures.push(
        `${benchmark.id}.${cell} is claimed ok but measured a gap: ${(verdicts[cell]?.reasons ?? []).join('; ')}`,
      );
    } else if (claimed === 'gap' && measured === 'ok') {
      notices.push(`${benchmark.id}.${cell} is declared a gap but passed; declare it ok`);
    }
  }
  return { failures, notices };
}

/**
 * Every spec of a Playwright JSON report, by title, and whether it passed.
 *
 * @param {{ suites?: unknown[] }} report
 * @returns {{ title: string, ok: boolean }[]}
 */
export function journeyResults(report) {
  /** @type {{ title: string, ok: boolean }[]} */
  const results = [];
  /** @param {any} suite */
  const visit = (suite) => {
    for (const spec of suite?.specs ?? [])
      results.push({ title: spec.title, ok: spec.ok === true });
    for (const child of suite?.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);
  return results;
}

/**
 * The journeys step from the app's results: `ok` when at least one ran and every one passed;
 * else `failed`. A declared Journeys gap excuses exactly the failures of the journeys it names:
 * its ref and each title of its `alsoExcused` (`benchmark.test.ts` allows those on a gap only).
 * Every other failure, and a run with no journey or none of a named title, is `unexcused`, which
 * fails the lane whatever the app declares.
 *
 * @param {{ cells: { journeys: { verdict: 'ok' | 'gap', ref: string, alsoExcused?: readonly string[] } } }} benchmark
 * @param {readonly { title: string, ok: boolean }[]} results
 */
export function journeysOutcome(benchmark, results) {
  const failed = results.filter((result) => !result.ok).map((result) => result.title);
  const { verdict, ref, alsoExcused = [] } = benchmark.cells.journeys;
  const named = [ref, ...alsoExcused];
  const unexcused = failed
    .filter((title) => verdict !== 'gap' || !named.includes(title))
    .map((title) => `the journey '${title}' failed`);
  if (results.length === 0) {
    return { status: 'failed', reason: 'no journey ran', unexcused: ['no journey ran'] };
  }
  const missing = named
    .filter((title) => !results.some((result) => result.title === title))
    .map((title) => `no journey is titled '${title}'`);
  if (missing.length > 0) {
    return { status: 'failed', reason: missing.join('; '), unexcused: [...unexcused, ...missing] };
  }
  return failed.length === 0
    ? { status: 'ok', reason: `${String(results.length)} journeys passed`, unexcused: [] }
    : { status: 'failed', reason: `failed: ${failed.join(', ')}`, unexcused };
}

/**
 * Each settled test of a `test-results-reporter.mjs` file, one JSON line each; a line that is not
 * one is refused rather than read as a pass.
 *
 * @param {string} text
 * @returns {{ title: string, status: 'passed' | 'failed' | 'skipped' | 'todo' }[]}
 */
export function testResults(text) {
  const statuses = ['passed', 'failed', 'skipped', 'todo'];
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const value = JSON.parse(line);
      if (typeof value?.title !== 'string' || !statuses.includes(value?.status)) {
        throw new Error(`not a test result: ${line}`);
      }
      return { title: value.title, status: value.status };
    });
}

/**
 * The test step from the command's exit status and its per-test results: `ok` only when the
 * command passed and a test titled exactly as `agentOnData.ref` ran and passed, every one of that
 * title. A ref test that is missing, skipped or todo makes the step a `gap` naming it.
 *
 * @param {{ cells: { agentOnData: { ref: string } } }} benchmark
 * @param {{ status: number, reason: string }} command
 * @param {readonly { title: string, status: 'passed' | 'failed' | 'skipped' | 'todo' }[]} results
 */
export function agentOnDataOutcome(benchmark, command, results) {
  if (command.status !== 0) return { status: 'failed', reason: command.reason };
  const { ref } = benchmark.cells.agentOnData;
  const named = results.filter((result) => result.title === ref);
  if (named.length === 0) return { status: 'gap', reason: `no test is titled '${ref}'` };
  const unsettled = named.find((result) => result.status !== 'passed');
  if (unsettled !== undefined) {
    return { status: 'gap', reason: `the test '${ref}' is ${unsettled.status}, not passed` };
  }
  return { status: 'ok', reason: `${String(results.length)} tests settled; '${ref}' passed` };
}

/**
 * An app's `agent-workspace.yaml` with a `production` environment on `target` whose `apps` run
 * each app of `apps` (name to image) at {@link appUrl}. The generated file's last block is
 * `environments:`, so the new environment is indented under it; anything else is refused rather
 * than misplaced.
 *
 * @param {string} projectYaml @param {Readonly<Record<string, string>>} apps
 * @param {'single-vm' | 'kubernetes'} target
 */
export function withProductionApps(projectYaml, apps, target) {
  const lines = projectYaml.trimEnd().split('\n');
  const topLevel = lines.filter((line) => /^[a-zA-Z]/u.test(line));
  if (topLevel.at(-1) !== 'environments:') {
    throw new Error('agent-workspace.yaml does not end with its environments block');
  }
  if (/^ {2}production:/mu.test(projectYaml)) {
    throw new Error('agent-workspace.yaml has a production environment already');
  }
  const appLines = Object.entries(apps).flatMap(([name, image]) => [
    `      ${name}:`,
    `        image: ${image}`,
    `        url: ${appUrl(name)}`,
  ]);
  return [
    ...lines,
    '  production:',
    `    target: ${target}`,
    `    url: ${PLATFORM_URL}`,
    '    apps:',
    ...appLines,
    '',
  ].join('\n');
}

/** The platform's URL in the lane's deploy plans: never resolved, never served. */
export const PLATFORM_URL = 'https://platform.apps-lane.test';

/** @param {string} name */
export const appUrl = (name) => `https://${name}.apps-lane.test`;

/** `app_<name>`, the schema and role an app's data lives in (`appSchemaName` of the contracts). */
export const appSchema = (name) => `app_${name.replaceAll('-', '_')}`;

/**
 * A digest reference for an app whose image did not build, so the rendering is still checked: the
 * sha256 of its name, which names no real image.
 *
 * @param {string} name
 */
export function standInImage(name) {
  const digest = createHash('sha256').update(`apps-lane-${name}`).digest('hex');
  return `registry.apps-lane.test/${name}@sha256:${digest}`;
}

/**
 * Why the rendered `compose.apps.yaml` (parsed) does not run app `name` from `image` on its own
 * role; `undefined` when it does.
 *
 * @param {any} compose @param {string} name @param {string} image
 */
export function composeAppsProblem(compose, name, image) {
  const service = compose?.services?.[`app-${name}`];
  if (service === undefined) return `compose.apps.yaml has no app-${name} service`;
  if (service.image !== image) return `app-${name} runs ${String(service.image)}, not ${image}`;
  const url = String(service.environment?.DATABASE_URL ?? '');
  if (!url.startsWith(`postgres://${appSchema(name)}:`)) {
    return `app-${name}'s DATABASE_URL is not for the role ${appSchema(name)}`;
  }
  if (compose.services[`app-${name}-role`] === undefined) {
    return `compose.apps.yaml has no app-${name}-role service creating ${appSchema(name)}`;
  }
  return undefined;
}

/**
 * Why the rendered Helm values (parsed) do not list app `name` with `image` and its schema;
 * `undefined` when they do.
 *
 * @param {any} values @param {string} name @param {string} image
 */
export function helmAppsProblem(values, name, image) {
  const app = (values?.apps ?? []).find((/** @type {any} */ entry) => entry?.name === name);
  if (app === undefined) return `the Helm values list no app ${name}`;
  if (app.image !== image) return `the Helm values run ${String(app.image)}, not ${image}`;
  if (app.schema !== appSchema(name)) {
    return `the Helm values give ${name} the schema ${String(app.schema)}`;
  }
  return app.host === new URL(appUrl(name)).hostname
    ? undefined
    : `the Helm values serve ${name} at ${String(app.host)}`;
}

// ---------------------------------------------------------------------------------------------
// The impure half: everything below runs commands.

/** The line of `aw dev`'s ready screen that names the app's origin. */
const READY_APP = /^ {2}app {7}(http:\/\/127\.0\.0\.1:\d+)$/mu;

/**
 * Run `command` and return its status and output, never throwing.
 *
 * @param {string} command @param {readonly string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number }} [options]
 */
function attempt(command, args, options = {}) {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 900_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { status: result.status ?? -1, stdout: result.stdout ?? '', output };
}

/**
 * {@link attempt} without blocking this process: for a command that needs the lane to keep
 * serving while it runs. The journeys do: the scripted model (`startFakeModel`) answers from this
 * process, and `aw dev`'s output pipes are drained here, so a `spawnSync` would leave every model
 * request of an agent run unanswered (and the run live) until Playwright had given up.
 *
 * @param {string} command @param {readonly string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number }} [options]
 * @returns {Promise<{ status: number, stdout: string, output: string }>}
 */
export function attemptAsync(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 900_000);
    const done = (/** @type {number} */ status) => {
      clearTimeout(timer);
      resolve({ status, stdout, output: `${stdout}${stderr}` });
    };
    child.once('error', (error) => {
      stderr += String(error);
      done(-1);
    });
    child.once('close', (code) => done(code ?? -1));
  });
}

/** The last lines of `text`, for a reason. @param {string} text */
const tail = (text) => text.trim().split('\n').slice(-12).join('\n');

/**
 * `command` as a step: `ok` when it exits 0, else `failed` with its last lines.
 *
 * @param {string} label @param {string} command @param {readonly string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number }} options
 */
function stepOf(label, command, args, options) {
  console.log(`   $ ${label}`);
  const result = attempt(command, args, options);
  return result.status === 0
    ? { status: 'ok', reason: label }
    : {
        status: 'failed',
        reason: `${label} exited ${String(result.status)}:\n${tail(result.output)}`,
      };
}

/** @param {string} file @param {(value: any) => any} change */
function editJson(file, change) {
  writeFileSync(
    file,
    `${JSON.stringify(change(JSON.parse(readFileSync(file, 'utf8'))), null, 2)}\n`,
  );
}

/**
 * `manifest` with every `@indx-workspace/*` dependency at its tarball, added to its own
 * `overrides` (the template's security overrides stay), so a transitive one resolves there too.
 *
 * @param {Record<string, any>} manifest @param {Record<string, string>} tarballs
 */
export function withTarballDependencies(manifest, tarballs) {
  const specs = Object.fromEntries(
    Object.entries(tarballs).map(([name, tarball]) => [name, `file:${tarball}`]),
  );
  /** @param {Record<string, string> | undefined} section */
  const pinned = (section) =>
    section === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(section).map(([name, spec]) => [name, specs[name] ?? spec]),
        );
  return {
    ...manifest,
    dependencies: pinned(manifest['dependencies']),
    devDependencies: pinned(manifest['devDependencies']),
    overrides: { ...manifest['overrides'], ...specs },
  };
}

/**
 * @param {string} id @param {string} work @param {Record<string, string>} tarballs
 * @param {readonly string[]} takenOver the generated files the app has made its own
 */
function regenerateStep(id, work, tarballs, takenOver) {
  try {
    const differing = differingFromExample(
      id,
      regenerate(id, path.join(work, 'regenerate', id), tarballs),
      takenOver,
    );
    return differing.length === 0
      ? { status: 'ok', reason: 'commands.sh writes the app again' }
      : { status: 'failed', reason: `differs from commands.sh: ${differing.join(', ')}` };
  } catch (error) {
    return { status: 'failed', reason: `regenerate failed: ${tail(String(error))}` };
  }
}

/** @param {string} id @param {string} copy @param {Record<string, string>} tarballs @param {NodeJS.ProcessEnv} env */
function installStep(id, copy, tarballs, env) {
  rmSync(copy, { recursive: true, force: true });
  cpSync(path.join(EXAMPLES, id), copy, {
    recursive: true,
    filter: (source) => !/(?:^|[\\/])(?:node_modules|\.next)(?:[\\/]|$)/u.test(source),
  });
  editJson(path.join(copy, 'package.json'), (value) => withTarballDependencies(value, tarballs));
  const installed = stepOf('npm install', 'npm', ['install', '--no-audit', '--no-fund'], {
    cwd: copy,
    env,
  });
  if (installed.status !== 'ok') return installed;
  return stepOf(
    'npm install --save-dev <the repository TypeScript>',
    'npm',
    ['install', '--no-audit', '--no-fund', '--save-dev', ...TYPE_CHECK_PACKAGES],
    { cwd: copy, env },
  );
}

const APP_TESTS = 'node --test tests/**/*.test.ts';

/**
 * The app's own `node:test` files under `tests/`, each test's result written by
 * {@link TEST_RESULTS_REPORTER}: the command's status and output, and the results it wrote
 * (`undefined` when it wrote none).
 *
 * @param {string} copy @param {string} work @param {NodeJS.ProcessEnv} env
 */
function appTests(copy, work, env) {
  const resultsFile = path.join(work, `test-results-${path.basename(copy)}.jsonl`);
  rmSync(resultsFile, { force: true });
  console.log(`   $ ${APP_TESTS}`);
  const result = attempt(
    process.execPath,
    [
      '--test',
      `--test-reporter=${TEST_RESULTS_REPORTER}`,
      `--test-reporter-destination=${resultsFile}`,
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      'tests/**/*.test.ts',
    ],
    { cwd: copy, env },
  );
  const results = existsSync(resultsFile)
    ? testResults(readFileSync(resultsFile, 'utf8'))
    : undefined;
  return { status: result.status, output: result.output, results };
}

/**
 * @param {{ cells: { agentOnData: { ref: string } } }} benchmark @param {string} copy
 * @param {string} work @param {NodeJS.ProcessEnv} env
 */
function testStep(benchmark, copy, work, env) {
  if (!existsSync(path.join(copy, 'tests')))
    return { status: 'gap', reason: 'the app has no tests/' };
  const result = appTests(copy, work, env);
  const command = {
    status: result.status,
    reason: `${APP_TESTS} exited ${String(result.status)}:\n${tail(result.output)}`,
  };
  if (result.status === 0 && result.results === undefined) {
    return { status: 'gap', reason: `${APP_TESTS} wrote no per-test results` };
  }
  return agentOnDataOutcome(benchmark, command, result.results ?? []);
}

/** @param {string} copy @param {NodeJS.ProcessEnv} env */
function depcruiseStep(copy, env) {
  const result = attempt(
    'npx',
    [
      '--no-install',
      'depcruise',
      '--config',
      'dependency-cruiser.config.mjs',
      '--output-type',
      'json',
      '.',
    ],
    { cwd: copy, env },
  );
  let summary;
  try {
    summary = JSON.parse(result.stdout).summary;
  } catch {
    return { status: 'failed', reason: `depcruise printed no report:\n${tail(result.output)}` };
  }
  if (summary.totalCruised <= 1) {
    return {
      status: 'gap',
      reason: `depcruise cruised ${String(summary.totalCruised)} module(s): it proves nothing`,
    };
  }
  return result.status === 0 && summary.error === 0
    ? { status: 'ok', reason: `${String(summary.totalCruised)} modules, no violation` }
    : { status: 'failed', reason: `depcruise found ${String(summary.error)} violation(s)` };
}

/** The languages every app's journeys run in: `app/theme.ts` is set to each in turn. */
export const JOURNEY_LOCALES = ['en', 'ja'];

/**
 * `app/theme.ts` with its `locale` set to `locale`, or `undefined` when it names none. The lane
 * sets it in its own copy of the app, and puts the app's own back after the journeys.
 *
 * @param {string} source @param {string} locale
 */
export function withThemeLocale(source, locale) {
  const named = /^(\s*locale: )'[a-z]{2}'(,?)$/mu;
  return named.test(source) ? source.replace(named, `$1'${locale}'$2`) : undefined;
}

/**
 * The environment of one Playwright run of the app's journeys: the app and the platform, the
 * person token for the app's own API, the running copy, the locale and the report, and the
 * bootstrap Owner's email and local console password, with which each journey signs its browser in
 * through the app's own `/sign-in` and `aw dev`'s development issuer (issue #2075). The lane prints
 * none of them but the app's URL.
 *
 * @param {NodeJS.ProcessEnv} base
 * @param {{ appUrl: string, origin: string, token: string, copy: string, locale: string, report: string, owner: { email: string, password: string } }} run
 */
export function journeyEnv(base, { appUrl, origin, token, copy, locale, report, owner }) {
  return {
    ...base,
    APPS_E2E_APP_URL: appUrl,
    APPS_E2E_PLATFORM_URL: origin,
    APPS_E2E_PERSON_TOKEN: token,
    APPS_E2E_OWNER_EMAIL: owner.email,
    APPS_E2E_OWNER_PASSWORD: owner.password,
    APPS_E2E_APP_DIR: copy,
    APPS_E2E_LOCALE: locale,
    APPS_E2E_REPORT: report,
  };
}

/**
 * One Playwright run of the app's `e2e/` in `locale` (`APPS_E2E_LOCALE`, which each journey
 * checks against `<html lang>`): every journey's result, or the reason there are none.
 *
 * @param {{ id: string, locale: string, appUrl: string, origin: string, token: string, copy: string, work: string, owner: { email: string, password: string } }} options
 */
async function playwrightRun({ id, locale, appUrl, origin, token, copy, work, owner }) {
  const report = path.join(work, 'reports', `${id}-${locale}.json`);
  mkdirSync(path.dirname(report), { recursive: true });
  console.log(`   $ playwright test examples/${id}/e2e (${locale}, the app on ${appUrl})`);
  const ran = await attemptAsync(
    'npx',
    ['--no-install', 'playwright', 'test', '--config', 'playwright.apps.config.mjs', `${id}/e2e/`],
    {
      cwd: ROOT,
      env: journeyEnv(process.env, { appUrl, origin, token, copy, locale, report, owner }),
      timeoutMs: 20 * 60_000,
    },
  );
  console.log(tail(ran.output));
  if (!existsSync(report)) {
    return { problem: `Playwright wrote no report in ${locale}:\n${tail(ran.output)}` };
  }
  return { results: journeyResults(JSON.parse(readFileSync(report, 'utf8'))) };
}

/**
 * The journeys step: `aw dev`, the Owner's sign-in, the app's identity secret and a person token,
 * then Playwright over the app's `e2e/`.
 *
 * @param {{ id: string, benchmark: any, copy: string, env: NodeJS.ProcessEnv, work: string, taken: Set<number> }} options
 */
async function journeysStep({ id, benchmark, copy, env, work, taken }) {
  const fake = await startFakeModel(readModelScript(path.join(copy, 'e2e', 'model-script.json')));
  const ports = {
    web: await freePort(3500, taken),
    gateway: await freePort(14500, taken),
    runner: await freePort(18500, taken),
    database: await freePort(26500, taken),
  };
  const devEnv = {
    ...env,
    ANTHROPIC_API_KEY: fake.key,
    ANTHROPIC_BASE_URL: fake.baseUrl,
    GATEWAY_PORT: String(ports.gateway),
    RUNNER_PORT: String(ports.runner),
    AW_DATABASE_PORT: String(ports.database),
  };
  const origin = `http://127.0.0.1:${String(ports.web)}`;
  const aw = path.join(copy, 'node_modules/@indx-workspace/aw/dist/index.js');
  const dev = startDev(aw, copy, devEnv, ['--port', String(ports.web)]);
  /** @type {import('@playwright/test').Browser | undefined} */
  let browser;
  try {
    await dev.waitFor(({ stdout }) => READY_APP.test(stdout) && /^synced: /mu.test(stdout));
    const appUrl = READY_APP.exec(dev.output.stdout)?.[1] ?? '';
    const secrets = JSON.parse(
      readFileSync(path.join(copy, '.agent-workspace/secrets/local-secrets.json'), 'utf8'),
    );
    const email = /bootstrapAdmin: (\S+)/u.exec(
      readFileSync(path.join(copy, 'agent-workspace.yaml'), 'utf8'),
    )?.[1];
    if (email === undefined) throw new Error('agent-workspace.yaml names no bootstrapAdmin');
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch();
    const owner = { email, password: String(secrets.BOOTSTRAP_ADMIN_PASSWORD) };
    const { page, token } = await signIn(browser, origin, owner);
    await storeAppIdentity(page, copy, id, dev.output.stderr);
    await browser.close();
    browser = undefined;
    // The journeys sign in through the app: wait for `aw dev` to restart it with its sign-in.
    await signInConfigured(appUrl);
    const themeFile = path.join(copy, 'app', 'theme.ts');
    const theme = existsSync(themeFile) ? readFileSync(themeFile, 'utf8') : undefined;
    /** @type {{ title: string, ok: boolean }[]} */
    const results = [];
    try {
      for (const locale of JOURNEY_LOCALES) {
        const themed = theme === undefined ? undefined : withThemeLocale(theme, locale);
        if (themed === undefined) {
          const reason = `app/theme.ts names no locale, so the journeys cannot run in ${locale}`;
          return { status: 'failed', reason, unexcused: [reason] };
        }
        writeFileSync(themeFile, themed);
        const ran = await playwrightRun({ id, locale, appUrl, origin, token, copy, work, owner });
        if ('problem' in ran)
          return { status: 'failed', reason: ran.problem, unexcused: [ran.problem] };
        results.push(...ran.results);
      }
    } finally {
      if (theme !== undefined) writeFileSync(themeFile, theme);
    }
    return journeysOutcome(benchmark, results);
  } catch (error) {
    writeFileSync(
      path.join(work, `${id}-aw-dev.log`),
      `${dev.output.stdout}\n${dev.output.stderr}`,
    );
    const reason = `the journeys could not run: ${tail(String(error))}`;
    return { status: 'failed', reason, unexcused: [reason] };
  } finally {
    await browser?.close().catch(() => undefined);
    await dev.stop();
    await fake.close();
  }
}

/** Whether a Docker daemon answers. */
const dockerAnswers = () => attempt('docker', ['info'], { timeoutMs: 60_000 }).status === 0;

/**
 * `aw deploy production`'s plan of the app copy at `target`, in a home of its own: the parsed
 * file `aw deploy` rendered (`compose.apps.yaml`, or the Helm values), or the reason it has none.
 * The Kubernetes plan runs with a `helm` that answers every call and does nothing (shortcut: the
 * lane checks the values `aw deploy` writes and installs no chart; upgrade when it has a cluster).
 *
 * @param {{ id: string, copy: string, image: string, env: NodeJS.ProcessEnv, work: string, target: 'single-vm' | 'kubernetes' }} options
 */
export function renderedPlan({ id, copy, image, env, work, target }) {
  const home = path.join(work, 'deploy', `${id}-${target}`);
  const project = path.join(home, 'project');
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  cpSync(copy, project, {
    recursive: true,
    filter: (source) =>
      !/(?:^|[\\/])(?:node_modules|\.next|\.agent-workspace|\.aw)(?:[\\/]|$)/u.test(source),
  });
  const projectFile = path.join(project, 'agent-workspace.yaml');
  writeFileSync(
    projectFile,
    withProductionApps(readFileSync(projectFile, 'utf8'), { [id]: image }, target),
  );
  const bin = path.join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  if (target === 'kubernetes') {
    writeFileSync(
      path.join(bin, 'helm'),
      '#!/bin/sh\n[ "$1" = version ] && echo v3.16.0-apps-lane\nexit 0\n',
    );
    chmodSync(path.join(bin, 'helm'), 0o755);
  }
  const aw = path.join(copy, 'node_modules/@indx-workspace/aw/dist/index.js');
  const planned = attempt(process.execPath, [aw, 'deploy', 'production'], {
    cwd: project,
    env: { ...env, HOME: home, PATH: `${bin}${path.delimiter}${env['PATH'] ?? ''}` },
    timeoutMs: 300_000,
  });
  // A plan with changes exits 3 (ADR-0094); 0 is a plan without.
  if (planned.status !== 0 && planned.status !== 3) {
    return {
      problem: `aw deploy production (${target}) exited ${String(planned.status)}:\n${tail(planned.output)}`,
    };
  }
  const state = path.join(
    home,
    '.config/agent-workspace/deployments',
    projectName(projectFile),
    'production',
  );
  const file =
    target === 'single-vm'
      ? path.join(state, 'compose.apps.yaml')
      : path.join(state, 'deploy/helm/values.yaml');
  if (!existsSync(file))
    return { problem: `aw deploy production (${target}) wrote no ${path.basename(file)}` };
  return { parsed: parsedYaml(copy, file), state };
}

/**
 * The YAML file `file`, parsed by the `yaml` package the app's own install holds (the repository
 * root declares none), in a child process run in the app copy.
 *
 * @param {string} copy @param {string} file
 */
function parsedYaml(copy, file) {
  const read = attempt(
    process.execPath,
    [
      '-e',
      "process.stdout.write(JSON.stringify(require('yaml').parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))))",
      file,
    ],
    { cwd: copy, timeoutMs: 60_000 },
  );
  if (read.status !== 0) throw new Error(`could not parse ${file}:\n${tail(read.output)}`);
  return JSON.parse(read.stdout);
}

/** The `name:` of a project file. @param {string} file */
function projectName(file) {
  const name = /^name: (\S+)$/mu.exec(readFileSync(file, 'utf8'))?.[1];
  if (name === undefined) throw new Error(`${file} has no name`);
  return name;
}

/**
 * The throwaway registry the lane pushes app images to, started on first use: its loopback
 * `host:port` and its container, which `stop()` removes.
 */
function laneRegistry() {
  /** @type {{ host: string, container: string } | undefined} */
  let started;
  return {
    /** @returns {string} */
    host() {
      if (started !== undefined) return started.host;
      const container = attempt('docker', [
        'run',
        '--detach',
        '--rm',
        '-p',
        '127.0.0.1::5000',
        REGISTRY_IMAGE,
      ]);
      if (container.status !== 0)
        throw new Error(`the registry did not start:\n${tail(container.output)}`);
      const id = container.stdout.trim();
      const port =
        attempt('docker', ['port', id, '5000/tcp']).stdout.trim().split(':').at(-1) ?? '';
      started = { host: `127.0.0.1:${port}`, container: id };
      return started.host;
    },
    stop() {
      if (started !== undefined) attempt('docker', ['rm', '--force', started.container]);
    },
  };
}

/**
 * The app's image built with its own `npm run image`, pushed, and its digest reference; or the
 * reason it has none. The build context is a fresh copy of `examples/<id>`, locked against the
 * lane's loopback registry (`package-server.mjs`), so the `Dockerfile`'s `npm ci` installs this
 * checkout's packages at the versions the app pins; `--network host` lets the build reach it.
 *
 * @param {{ id: string, env: NodeJS.ProcessEnv, work: string, registry: ReturnType<typeof laneRegistry>, packages: { url: string } }} options
 */
function appImage({ id, env, work, registry, packages }) {
  const context = path.join(work, 'images', id);
  rmSync(context, { recursive: true, force: true });
  cpSync(path.join(EXAMPLES, id), context, {
    recursive: true,
    filter: (source) => !/(?:^|[\\/])(?:node_modules|\.next)(?:[\\/]|$)/u.test(source),
  });
  const locked = stepOf(
    'npm install --package-lock-only (the lane registry)',
    'npm',
    ['install', '--package-lock-only', '--no-audit', '--no-fund', '--registry', packages.url],
    { cwd: context, env },
  );
  if (locked.status !== 'ok') return { problem: locked.reason };
  const tag = `${registry.host()}/apps-lane-${id}:${randomBytes(3).toString('hex')}`;
  const built = attempt('npm', ['run', 'image', '--', '--network', 'host', '--tag', tag], {
    cwd: context,
    env,
    timeoutMs: 1_200_000,
  });
  if (built.status !== 0)
    return { problem: `npm run image exited ${String(built.status)}:\n${tail(built.output)}` };
  const pushed = attempt('docker', ['push', tag]);
  if (pushed.status !== 0) return { problem: `docker push failed:\n${tail(pushed.output)}` };
  const digest = attempt('docker', [
    'inspect',
    '--format',
    '{{index .RepoDigests 0}}',
    tag,
  ]).stdout.trim();
  return digest.includes('@sha256:') ? { image: digest } : { problem: `${tag} has no digest` };
}

/**
 * The self-host step's per-app half: the image, then both plans with it (or, when it did not
 * build, with {@link standInImage}, so the rendering is still measured). `image` is set only when
 * the app's own image was built and both renderings name it.
 *
 * @param {{ id: string, copy: string, env: NodeJS.ProcessEnv, work: string, registry: ReturnType<typeof laneRegistry>, packages: { url: string } }} options
 */
function selfHostRender({ id, copy, env, work, registry, packages }) {
  const built = appImage({ id, env, work, registry, packages });
  const image = 'image' in built ? built.image : standInImage(id);
  const problems = 'problem' in built ? [built.problem] : [];
  const compose = renderedPlan({ id, copy, image, env, work, target: 'single-vm' });
  problems.push(
    ...('problem' in compose ? [compose.problem] : [composeAppsProblem(compose.parsed, id, image)]),
  );
  const helm = renderedPlan({ id, copy, image, env, work, target: 'kubernetes' });
  problems.push(
    ...('problem' in helm ? [helm.problem] : [helmAppsProblem(helm.parsed, id, image)]),
  );
  const found = problems.filter((problem) => problem !== undefined);
  return found.length === 0 ? { image } : { problem: found.join('\n') };
}

/**
 * Poll `url` until it answers 200 or `deadline` passes; the last status (0: never answered).
 *
 * @param {string} url @param {number} deadline
 */
async function healthOf(url, deadline) {
  let last = 0;
  while (Date.now() < deadline) {
    try {
      last = (await fetch(url, { signal: AbortSignal.timeout(5_000) })).status;
      if (last === 200) return last;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return last;
}

/**
 * The self-host step's shared half: the platform's own images built into the lane's registry, one
 * `single-vm` plan with every app whose image built, `docker compose up` over its state, and each
 * app's `/api/health` and `DATABASE_URL`. A problem per app, empty when every one passed.
 *
 * @param {{ apps: { id: string, image: string }[], copy: string, env: NodeJS.ProcessEnv, work: string, registry: ReturnType<typeof laneRegistry> }} options
 * @returns {Promise<Map<string, string>>}
 */
async function bootPlatform({ apps, copy, env, work, registry }) {
  const problems = new Map();
  const everyApp = (/** @type {string} */ problem) => {
    for (const { id } of apps) problems.set(id, problem);
    return problems;
  };
  const overrides = buildPinnedImages({
    registry: registry.host(),
    revision: checkoutRevision(),
    deadline: Date.now() + 30 * 60_000,
  });
  const home = path.join(work, 'deploy', 'boot');
  const project = path.join(home, 'project');
  rmSync(home, { recursive: true, force: true });
  mkdirSync(project, { recursive: true });
  const base = readFileSync(path.join(copy, 'agent-workspace.yaml'), 'utf8').replace(
    /^name: \S+$/mu,
    'name: apps-lane',
  );
  writeFileSync(
    path.join(project, 'agent-workspace.yaml'),
    withProductionApps(
      base,
      Object.fromEntries(apps.map(({ id, image }) => [id, image])),
      'single-vm',
    ),
  );
  const aw = path.join(copy, 'node_modules/@indx-workspace/aw/dist/index.js');
  const bootEnv = { ...env, ...overrides, HOME: home };
  const planned = attempt(process.execPath, [aw, 'deploy', 'production'], {
    cwd: project,
    env: bootEnv,
  });
  if (planned.status !== 0 && planned.status !== 3) {
    return everyApp(`the boot plan exited ${String(planned.status)}:\n${tail(planned.output)}`);
  }
  const state = path.join(home, '.config/agent-workspace/deployments/apps-lane/production');
  const composeEnv = {
    ...bootEnv,
    COMPOSE_PROJECT_NAME: `apps-lane-${randomBytes(3).toString('hex')}`,
  };
  try {
    const up = attempt('docker', ['compose', 'up', '--detach'], {
      cwd: state,
      env: composeEnv,
      timeoutMs: 900_000,
    });
    if (up.status !== 0) return everyApp(`docker compose up failed:\n${tail(up.output)}`);
    const platformUrl = attempt(
      'docker',
      ['compose', 'exec', '-T', 'web', 'printenv', 'DATABASE_URL'],
      {
        cwd: state,
        env: composeEnv,
      },
    ).stdout.trim();
    const sorted = [...apps].sort((left, right) => (left.id < right.id ? -1 : 1));
    for (const [index, { id }] of sorted.entries()) {
      const status = await healthOf(
        `http://127.0.0.1:${String(3100 + index)}/api/health`,
        Date.now() + 300_000,
      );
      const url = attempt(
        'docker',
        ['compose', 'exec', '-T', `app-${id}`, 'printenv', 'DATABASE_URL'],
        {
          cwd: state,
          env: composeEnv,
        },
      ).stdout.trim();
      if (status !== 200) problems.set(id, `GET /api/health answered ${String(status)}`);
      else if (
        url === '' ||
        url === platformUrl ||
        !url.startsWith(`postgres://${appSchema(id)}:`)
      ) {
        problems.set(id, `app-${id} did not get a DATABASE_URL of its own role ${appSchema(id)}`);
      }
    }
    return problems;
  } finally {
    attempt('docker', ['compose', 'down', '--volumes', '--remove-orphans'], {
      cwd: state,
      env: composeEnv,
    });
  }
}

/** The registered apps' benchmarks, read from each `examples/<id>/benchmark.ts`. */
async function registeredApps() {
  const { loadExampleApps } = await import('./registry.ts');
  return loadExampleApps().map((/** @type {any} */ app) => app.benchmark);
}

/** @param {string} id @param {Map<string, any>} outcomes @param {string} step @param {any} outcome */
function record(id, outcomes, step, outcome) {
  outcomes.set(step, outcome);
  console.log(
    `== ${id} ${step}: ${outcome.status}${outcome.status === 'ok' ? '' : ` (${outcome.reason.split('\n')[0]})`}`,
  );
}

/** Every step of one app but the platform boot. */
async function runApp({ benchmark, skip, work, tarballs, env, taken, registry, packages }) {
  const { id } = benchmark;
  const copy = path.join(work, 'apps', id);
  const outcomes = new Map();
  /** @type {string[]} */
  let unexcused = [];
  /** @type {(step: string, run: () => any) => Promise<void>} */
  const step = async (name, run) => {
    const blocked = blockedReason(name, outcomes, skip);
    if (blocked !== undefined) {
      record(id, outcomes, name, { status: 'gap', reason: blocked });
      return;
    }
    try {
      record(id, outcomes, name, await run());
    } catch (error) {
      record(id, outcomes, name, { status: 'failed', reason: `threw: ${tail(String(error))}` });
    }
  };
  await step('regenerate', () => regenerateStep(id, work, tarballs, benchmark.takenOver ?? []));
  await step('install', () => installStep(id, copy, tarballs, env));
  await step('build', () =>
    stepOf('next build', 'npx', ['--no-install', 'next', 'build'], { cwd: copy, env }),
  );
  await step('test', () => testStep(benchmark, copy, work, env));
  await step('depcruise', () => depcruiseStep(copy, env));
  await step('journeys', async () => {
    const outcome = await journeysStep({ id, benchmark, copy, env, work, taken });
    unexcused = outcome.unexcused;
    return outcome;
  });
  /** @type {string | undefined} */
  let image;
  await step('self-host', () => {
    if (packages === undefined) return { status: 'gap', reason: 'Docker is not available' };
    const rendered = selfHostRender({ id, copy, env, work, registry, packages });
    if ('problem' in rendered) return { status: 'failed', reason: rendered.problem };
    image = rendered.image;
    return { status: 'ok', reason: 'rendered; the boot follows' };
  });
  return { benchmark, outcomes, unexcused, image, copy };
}

/** The job summary: one row per app, one column per lane cell, and every reason. */
export function renderLaneSummary(results) {
  const header = ['App', ...LANE_CELLS];
  const rows = results.map(({ benchmark, verdicts }) => [
    benchmark.id,
    ...LANE_CELLS.map((cell) => (verdicts[cell].verdict === 'ok' ? '✅' : '❌')),
  ]);
  const reasons = results.flatMap(({ benchmark, verdicts }) =>
    LANE_CELLS.flatMap((cell) =>
      verdicts[cell].reasons.map((reason) => `- ${benchmark.id}.${cell}: ${reason.split('\n')[0]}`),
    ),
  );
  return [
    '## apps-e2e',
    '',
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
    '',
    ...reasons,
    '',
  ].join('\n');
}

/**
 * A scenario's line of the job summary.
 *
 * @param {string} id @param {{ status: 'ok' | 'failed' | 'gap', reason: string }} outcome
 */
export function renderScenarioSummary(id, outcome) {
  const mark = { ok: '✅', failed: '❌', gap: '⏭️' }[outcome.status];
  return `${mark} scenario ${id}: ${outcome.reason.split('\n')[0]}\n`;
}

/**
 * The `blueprint` scenario (`blueprint.mjs`): a `gap` when `--skip` names it or `minimal` is not
 * among the apps, else its outcome.
 *
 * @param {{ apps: readonly string[], skip: ReadonlySet<string>, work: string,
 *   tarballs: Record<string, string>, env: NodeJS.ProcessEnv }} options
 * @returns {Promise<{ status: 'ok' | 'failed' | 'gap', reason: string }>}
 */
async function blueprintScenario({ apps, skip, work, tarballs, env }) {
  if (skip.has('blueprint')) return { status: 'gap', reason: 'skipped by --skip' };
  if (!apps.includes('minimal')) return { status: 'gap', reason: 'minimal is not among the apps' };
  console.log('== the blueprint scenario: a fixture app blueprint installed into minimal');
  const outcome = await runBlueprintScenario({
    work,
    env,
    install: (copy) => installStep('minimal', copy, tarballs, env),
    nodeTests: (copy) => appTests(copy, work, env),
  });
  console.log(`== blueprint: ${outcome.status} (${outcome.reason.split('\n')[0]})`);
  return outcome;
}

async function main() {
  const benchmarks = await registeredApps();
  const { apps, skip } = parseLaneArgs(
    process.argv.slice(2),
    benchmarks.map((benchmark) => benchmark.id),
  );
  const budget = positiveIntegerVariable('APPS_LANE_TIMEOUT_MS', 80 * 60_000);
  const guard = setTimeout(() => {
    console.error(`apps lane: the run did not finish within ${String(budget)} ms`);
    process.exit(1);
  }, budget);
  guard.unref();
  const keep = process.env['APPS_WORK_DIR'] !== undefined;
  const work = path.resolve(
    process.env['APPS_WORK_DIR'] ?? mkdtempSync(path.join(tmpdir(), 'apps-lane-')),
  );
  mkdirSync(work, { recursive: true });
  const home = path.join(work, 'home');
  mkdirSync(home, { recursive: true });
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    PATH: process.env['PATH'],
    HOME: home,
    LANG: process.env['LANG'] ?? 'C.UTF-8',
    TMPDIR: process.env['TMPDIR'],
    NO_COLOR: '1',
    // Next.js reports nothing home from a lane run.
    NEXT_TELEMETRY_DISABLED: '1',
    npm_config_cache:
      process.env['npm_config_cache'] ?? path.join(process.env['HOME'] ?? home, '.npm'),
  };
  console.log(`== packing the @indx-workspace packages into ${work}/packs`);
  const tarballs = packPackages(path.join(work, 'packs'));
  const docker = !skip.has('self-host') && dockerAnswers();
  const registry = laneRegistry();
  // The registry the image builds install from runs only when there is an image to build.
  const packages = docker ? await spawnPackageServer(tarballs, work) : undefined;
  const taken = new Set();
  const results = [];
  try {
    for (const id of apps) {
      const benchmark = benchmarks.find((candidate) => candidate.id === id);
      results.push(
        await runApp({ benchmark, skip, work, tarballs, env, taken, registry, packages }),
      );
    }
    const booted = results.filter((result) => result.image !== undefined);
    if (booted.length > 0) {
      console.log(
        `== booting the platform with ${booted.map((result) => result.benchmark.id).join(', ')}`,
      );
      /** @type {Map<string, string> | string} */
      let problems;
      try {
        problems = await bootPlatform({
          apps: booted.map((result) => ({ id: result.benchmark.id, image: result.image })),
          copy: booted[0].copy,
          env,
          work,
          registry,
        });
      } catch (error) {
        problems = `the boot threw: ${tail(String(error))}`;
      }
      for (const result of booted) {
        const problem = typeof problems === 'string' ? problems : problems.get(result.benchmark.id);
        record(
          result.benchmark.id,
          result.outcomes,
          'self-host',
          problem === undefined
            ? { status: 'ok', reason: 'rendered, booted and healthy on its own role' }
            : { status: 'failed', reason: problem },
        );
      }
    }
  } finally {
    registry.stop();
    packages?.close();
  }
  const blueprint = await blueprintScenario({ apps, skip, work, tarballs, env });
  const scored = results.map((result) => ({ ...result, verdicts: cellVerdicts(result.outcomes) }));
  const findings = scored.map((result) =>
    laneFindings(result.benchmark, result.verdicts, result.unexcused),
  );
  const failures = findings.flatMap((finding) => finding.failures);
  if (blueprint.status === 'failed') failures.push(`blueprint scenario: ${blueprint.reason}`);
  for (const notice of findings.flatMap((finding) => finding.notices))
    console.log(`notice: ${notice}`);
  const summary = `${renderLaneSummary(scored)}${renderScenarioSummary('blueprint', blueprint)}`;
  console.log(summary);
  if (process.env['GITHUB_STEP_SUMMARY'] !== undefined)
    appendFileSync(process.env['GITHUB_STEP_SUMMARY'], summary);
  writeFileSync(
    path.join(work, 'lane-report.json'),
    `${JSON.stringify(
      scored.map(({ benchmark, outcomes, verdicts }) => ({
        id: benchmark.id,
        steps: Object.fromEntries(outcomes),
        verdicts,
      })),
      null,
      2,
    )}\n`,
  );
  if (failures.length > 0) {
    console.error(
      `apps lane failed; the work directory is kept at ${work}\n${failures.map((failure) => `  ${failure}`).join('\n')}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log('== apps lane passed');
  if (!keep) rmSync(work, { recursive: true, force: true });
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
