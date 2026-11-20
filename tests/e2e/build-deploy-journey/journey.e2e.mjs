#!/usr/bin/env node
/* global console */
/**
 * The build-to-deploy journey (issue #801): a fresh developer goes from `npm create` to a chat turn
 * on a deployment, with the tool run in the tool sandbox behind the egress proxy.
 *
 *   pnpm build && node tests/e2e/build-deploy-journey/journey.e2e.mjs
 *
 * 1. Publish the packed `@indx-workspace` packages to a throwaway Verdaccio and build the platform
 *    images into a throwaway registry (`registry.mjs`).
 * 2. Chapter 1: `npm create @indx-workspace@latest demo -- --yes --theme support`.
 * 3. Chapter 2: add a code tool that declares a secret and one allowed host (the tool, its probe
 *    and its fake provider are `../tool-sandbox.e2e.mjs`'s), a promotion bar, and run `aw dev`
 *    against a `scripted:` model with no provider key: `aw eval run --min-score 1`.
 * 4. Chapter 3: `aw deploy production` to this host (single-vm: Docker driver, egress proxy), with
 *    a marked Compose override for what the template does not wire yet (tool sandbox, fake
 *    provider; see README.md), then `aw push`, one chat turn that calls the tool, `aw promote`
 *    refused below the bar, then `aw eval run` and `aw promote` past it.
 *
 * The deployment answers through a fake Anthropic API, not the scripted model: a deployment is not
 * in the `local` posture, which is the only one that accepts a scripted model.
 *
 * It needs Docker with Compose and Buildx, `openssl`, `npm` and the nine packages built. It starts
 * and removes containers, networks and volumes, and every runtime or tool-host container on the
 * daemon: run it against a disposable daemon. Environment: `BD_WORK_DIR` (default: a new temporary
 * directory), `BD_NPM_PORT` (4873), `BD_REGISTRY_PORT` (5000), `BD_CONTROL_PORT` (18083), and
 * `BD_PREPARE_TIMEOUT_MS` (45 minutes: the cap on packing and building).
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { remainingBefore } from '../../generated-project/images.mjs';
import { run } from '../../generated-project/project.mjs';
import { positiveIntegerVariable } from '../../generated-project/run.mjs';
import { StackClient } from '../../generated-project/stack-api.mjs';
import { JourneyFailure, agentNameOfSource } from '../../journey/harness.mjs';
import { VERDACCIO_IMAGE, publishPackages, waitForRegistry } from '../../journey/run.mjs';
import { DECLARATION, DECLARED_SECRET, RUN_FILE } from '../tool-sandbox.e2e.mjs';
import { composeOverride } from './compose-override.mjs';
import { startDev } from './dev-process.mjs';
import {
  WEB_URL,
  chatThroughTool,
  checkMigrationsRanOnce,
  deployProduction,
  pushAgent,
  removeRuntimeContainers,
  setUpDeployment,
  tearDownDeployment,
} from './deployment.mjs';
import { ROOT, check, spawnChecked } from './journey-support.mjs';
import { buildJourneyImages, startRegistry, stopRegistry } from './registry.mjs';

export { check, composeOverride, spawnChecked, startDev };

// Named per runner: the self-hosted CI host runs several jobs on one Docker daemon at once.
const VERDACCIO_CONTAINER = `build-deploy-journey-verdaccio-${(process.env.RUNNER_NAME ?? 'local').replace(/[^\w.-]/gu, '-')}`;
const SCRIPTS_DIR = path.join(import.meta.dirname, 'scripts');
const SCRIPTED_MODEL = 'scripted:support-journey';
const PREPARE_BUDGET_MS = 45 * 60_000;
/** `environments.production`: the url only needs a host that resolves. */
const PRODUCTION = '  production:\n    target: single-vm\n    url: https://localhost\n';
/** The promotion bar `aw deploy` carries to the deployment (#836) and `aw dev` enforces. */
const PROMOTION_BAR = 'policy:\n  promotion:\n    minEvalScore: 1\n';

/**
 * `source` with exactly one match of `pattern` replaced; the journey stops when a renderer change
 * moved the anchor.
 *
 * @param {string} source @param {RegExp} pattern @param {string} replacement
 */
function replaceOnce(source, pattern, replacement) {
  if (!pattern.test(source)) throw new JourneyFailure(`the agent file has no ${String(pattern)}`);
  return source.replace(pattern, replacement);
}

/**
 * The rendered `agents/<name>.ts` with the code tool listed and the model set.
 *
 * @param {string} source @param {string} model a TypeScript expression
 */
export function agentWithTool(source, model) {
  const imported = replaceOnce(
    source,
    /^(import \{ defineAgent[^}]*\} from '@indx-workspace\/sdk\/define';)$/mu,
    "$1\nimport getOrder from '../tools/get-order';",
  );
  const withModel = replaceOnce(imported, /^ {2}model: 'default',$/mu, `  model: ${model},`);
  return replaceOnce(withModel, /^( {2}engine: '[^'\\]+',)$/mu, '$1\n  tools: [getOrder],');
}
/**
 * A user's shell: no provider key (the scripted model needs none), a registry that serves the
 * packages of this checkout, and a home of its own so the runner's is never touched.
 *
 * @param {{ work: string, npmPort: number }} options
 */
export function journeyShell({ work, npmPort }) {
  const npmUrl = `http://127.0.0.1:${String(npmPort)}/`;
  const home = path.join(work, 'home');
  const evidence = path.join(work, 'evidence');
  for (const directory of [home, evidence, path.join(work, 'secrets')]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  /** @type {NodeJS.ProcessEnv} */
  const userEnv = { ...process.env };
  for (const name of Object.keys(userEnv)) {
    if (/^(ANTHROPIC|OPENAI|AZURE_OPENAI|GEMINI|GOOGLE)_/u.test(name)) delete userEnv[name];
  }
  Object.assign(userEnv, {
    HOME: home,
    DOCKER_CONFIG: process.env['DOCKER_CONFIG'] ?? path.join(homedir(), '.docker'),
    npm_config_registry: npmUrl,
    npm_config_cache: path.join(work, 'npm-cache'),
    npm_config_update_notifier: 'false',
  });
  return { npmUrl, home, evidence, userEnv };
}

/** Verdaccio on `npmPort` with the packed packages of this checkout published to it. */
export async function preparePackages({ work, npmPort, npmUrl, deadline }) {
  console.log(`== Verdaccio on ${npmUrl}, then the packed packages`);
  spawnSync('docker', ['rm', '--force', VERDACCIO_CONTAINER], { stdio: 'ignore' });
  run('docker', [
    'run',
    '--detach',
    '--name',
    VERDACCIO_CONTAINER,
    '--publish',
    `127.0.0.1:${String(npmPort)}:4873`,
    '--volume',
    `${path.join(ROOT, 'tests/journey/verdaccio.yaml')}:/verdaccio/conf/config.yaml:ro`,
    VERDACCIO_IMAGE,
  ]);
  await waitForRegistry(npmUrl, deadline);
  await publishPackages(work, path.join(work, 'secrets'), npmUrl, deadline);
}

export function stopPackages() {
  spawnSync('docker', ['rm', '--force', '--volumes', VERDACCIO_CONTAINER], { stdio: 'ignore' });
}

/**
 * Chapter 1: `npm create @indx-workspace@latest <name> -- --yes --theme support`, and the `aw` of
 * the created project.
 *
 * `extraArgs` follow `--theme support` (the platforms journey passes `--platform <id>`).
 *
 * @param {{ work: string, name: string, userEnv: NodeJS.ProcessEnv, extraArgs?: readonly string[] }} options
 */
export function createSupportProject({ work, name, userEnv, extraArgs = [] }) {
  console.log('== chapter 1: npm create, support theme');
  spawnChecked(
    'npm',
    ['create', '@indx-workspace@latest', name, '--', '--yes', '--theme', 'support', ...extraArgs],
    { cwd: work, env: userEnv, timeout: 900_000 },
  );
  const project = path.join(work, name);
  // `aw deploy` imports the CLI's deploy steps, so the created project carries it: no extra install.
  check(
    existsSync(path.join(project, 'node_modules/@indx-workspace/cli/package.json')),
    'npm create installed @indx-workspace/cli for aw deploy',
  );
  const aw = (/** @type {readonly string[]} */ args, env = userEnv, expected = 0) =>
    spawnChecked(
      path.join(project, 'node_modules/.bin/aw'),
      args,
      { cwd: project, env, timeout: 600_000 },
      expected,
    );
  const agentFile = readdirSync(path.join(project, 'agents')).find((f) => f.endsWith('.ts'));
  check(agentFile !== undefined, 'npm create wrote an agent');
  const agentPath = path.join(project, 'agents', agentFile ?? '');
  const rendered = readFileSync(agentPath, 'utf8');
  return { project, aw, agentPath, rendered, agentName: agentNameOfSource(rendered) };
}

/**
 * Chapter 2: the code tool, `production` (an `environments:` block) and the promotion bar written
 * to the project, then `aw eval run --min-score 1` under `aw dev` against a scripted model. `tool`
 * is the code tool's declaration and run file; by default the one that probes the egress proxy.
 *
 * @param {{ created: ReturnType<typeof createSupportProject>, userEnv: NodeJS.ProcessEnv, evidence: string, production: string, tool?: { declaration: string, runFile: string } }} options
 */
export async function evaluateScripted({
  created,
  userEnv,
  evidence,
  production,
  tool = { declaration: DECLARATION, runFile: RUN_FILE },
}) {
  const { project, aw, agentPath, rendered } = created;
  console.log('== chapter 2: a code tool, a promotion bar, aw eval against a scripted model');
  mkdirSync(path.join(project, 'tools'), { recursive: true });
  writeFileSync(path.join(project, 'tools/get-order.ts'), tool.declaration);
  writeFileSync(path.join(project, 'tools/get-order.run.ts'), tool.runFile);
  const scriptedModel = `{ connection: 'default', id: '${SCRIPTED_MODEL}' }`;
  writeFileSync(agentPath, agentWithTool(rendered, scriptedModel));
  appendFileSync(path.join(project, 'agent-workspace.yaml'), production + PROMOTION_BAR);
  // No provider key at all: a project whose agents are all scripted needs none (#798).
  const dev = startDev(project, {
    ...userEnv,
    AW_SCRIPTED_MODELS_DIR: SCRIPTS_DIR,
    [DECLARED_SECRET]: 'local-placeholder',
  });
  try {
    await dev.untilSynced(600_000);
    const junit = path.join(evidence, 'eval-scripted.xml');
    aw(['eval', 'run', '--min-score', '1', '--junit', junit]);
    check(existsSync(junit), 'aw eval run --min-score 1 passed against the scripted model, no key');
  } finally {
    await dev.stop();
  }
}

/**
 * The gate chapter, after `aw push`: a failing case refuses `aw promote` below the bar, then the
 * newest evaluation passes and promotion moves production. `refusal: false` skips the below-bar half
 * for a deployment whose policy ceiling the deploy path does not carry.
 *
 * @param {{ created: ReturnType<typeof createSupportProject>, remote: NodeJS.ProcessEnv, evidence: string, refusal: boolean }} options
 */
export function promotePastGate({ created, remote, evidence, refusal }) {
  const { project, aw, agentName } = created;
  const versions = JSON.parse(aw(['versions', '--json'], remote));
  const local = versions.pointers.find(
    (/** @type {{ environment: string }} */ p) => p.environment === 'local',
  );
  check(local !== undefined, 'aw push moved local to the new version');
  const promote = ['promote', agentName, String(local?.number), '--yes'];

  if (refusal) {
    // Below the bar: one failing case scores under minEvalScore 1, and the deployment's gate
    // refuses the move (#797, #836); a deployment that dropped its policy would move here.
    const evalsFile = path.join(project, 'evals', `${agentName}.yaml`);
    const cases = readFileSync(evalsFile, 'utf8');
    const absent = `journey-never-said-${randomBytes(4).toString('hex')}`;
    aw(['eval', 'add', 'Say hello.', '--agent', agentName, '--expect-contains', absent], remote);
    const below = aw(['eval', 'run', '--min-score', '1'], remote, 1);
    check(below.includes('is below --min-score 1'), 'a failing case scored below the bar');
    const refused = aw(promote, remote, 1);
    check(
      refused.includes(`production refused: v${String(local?.number)} scored`),
      `aw promote was refused below the bar (v${String(local?.number)})`,
    );
    writeFileSync(evalsFile, cases);
  }

  // Past the bar: the newest evaluation passes, so promotion moves.
  aw(
    ['eval', 'run', '--min-score', '1', '--junit', path.join(evidence, 'eval-deployment.xml')],
    remote,
  );
  aw(promote, remote);
  const promoted = JSON.parse(aw(['versions', '--json'], remote));
  check(
    promoted.pointers.some(
      (/** @type {{ environment: string, number: number }} */ p) =>
        p.environment === 'production' && p.number === local?.number,
    ),
    'aw promote moved production past the bar',
  );
}

/** A chat-turn nonce the fake provider recognises (`tests/journey/fake-anthropic-tools.mjs`). */
export function chatNonce() {
  return `e2e-nonce-journey${randomBytes(4).toString('hex')}`;
}

/** @returns the revision the platform images are labelled with */
function currentRevision() {
  const gitRevision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return gitRevision.status === 0 ? gitRevision.stdout.trim() : 'unknown';
}

/** The journey's work directory, ports and preparation deadline, from `BD_*` variables. */
function journeySettings() {
  const work = path.resolve(
    process.env['BD_WORK_DIR'] ?? mkdtempSync(path.join(tmpdir(), 'build-deploy-journey-')),
  );
  const port = (/** @type {string} */ name, /** @type {number} */ fallback) =>
    positiveIntegerVariable(name, fallback, { max: 65_535 });
  return {
    work,
    npmPort: port('BD_NPM_PORT', 4873),
    registryPort: port('BD_REGISTRY_PORT', 5000),
    controlPort: port('BD_CONTROL_PORT', 18083),
    deadline: Date.now() + positiveIntegerVariable('BD_PREPARE_TIMEOUT_MS', PREPARE_BUDGET_MS),
  };
}

/**
 * Chapter 3 end to end: deploy, set up, push, chat through the tool, then the promotion gate.
 *
 * @param {{ created: ReturnType<typeof createSupportProject>, settings: ReturnType<typeof journeySettings>, shell: ReturnType<typeof journeyShell>, images: ReturnType<typeof buildJourneyImages>, onStateDirectory: (directory: string) => void }} options
 */
async function deployAndPromote({ created, settings, shell, images, onStateDirectory }) {
  const { userEnv, home, evidence } = shell;
  console.log('== chapter 3: aw deploy production');
  writeFileSync(created.agentPath, agentWithTool(created.rendered, "'anthropic default'"));
  const { deployments, stateEnv } = deployProduction({
    aw: created.aw,
    work: settings.work,
    home,
    deployEnv: { ...userEnv, ...images.overrides },
    images,
    controlPort: settings.controlPort,
    onStateDirectory,
  });

  const client = new StackClient(WEB_URL);
  const remote = await setUpDeployment(client, stateEnv, userEnv);
  const declaredValue = `journey-declared-${randomBytes(6).toString('hex')}`;
  const agentId = await pushAgent(client, { created, remote, declaredValue });
  await chatThroughTool(client, {
    agentId,
    nonce: chatNonce(),
    declaredValue,
    controlPort: settings.controlPort,
  });
  checkMigrationsRanOnce(deployments, userEnv);
  promotePastGate({ created, remote, evidence, refusal: true });
}

async function main() {
  const settings = journeySettings();
  const { work, npmPort, registryPort, deadline } = settings;
  const shell = journeyShell({ work, npmPort });
  const { npmUrl, evidence, userEnv } = shell;
  const revision = currentRevision();

  let stateDirectory = '';
  let failed = true;
  try {
    await preparePackages({ work, npmPort, npmUrl, deadline });

    console.log('== the platform images');
    startRegistry(registryPort);
    const images = buildJourneyImages({
      registry: `localhost:${String(registryPort)}`,
      revision,
      deadline,
    });
    remainingBefore(deadline);

    const created = createSupportProject({ work, name: 'demo', userEnv });
    await evaluateScripted({ created, userEnv, evidence, production: PRODUCTION });
    await deployAndPromote({
      created,
      settings,
      shell,
      images,
      onStateDirectory: (directory) => {
        stateDirectory = directory;
      },
    });
    failed = false;
  } finally {
    tearDownDeployment({ stateDirectory, failed, userEnv });
    removeRuntimeContainers();
    stopRegistry();
    stopPackages();
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
