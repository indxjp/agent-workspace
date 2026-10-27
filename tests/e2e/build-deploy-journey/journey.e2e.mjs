#!/usr/bin/env node
/* global console, fetch */
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
 * It needs Docker with Compose and Buildx, `openssl`, `npm` and the eight packages built. It starts
 * and removes containers, networks and volumes, and every runtime or tool-host container on the
 * daemon: run it against a disposable daemon. Environment: `BD_WORK_DIR` (default: a new temporary
 * directory), `BD_NPM_PORT` (4873), `BD_REGISTRY_PORT` (5000), `BD_CONTROL_PORT` (18083), and
 * `BD_PREPARE_TIMEOUT_MS` (45 minutes: the cap on packing and building).
 */
import { spawn, spawnSync } from 'node:child_process';
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
import { setTimeout as delay } from 'node:timers/promises';

import { remainingBefore } from '../../generated-project/images.mjs';
import {
  FAKE_PROVIDER_HOST,
  parseDotEnv,
  run,
  writeFakeProviderFixture,
} from '../../generated-project/project.mjs';
import { nodeImageOf, positiveIntegerVariable } from '../../generated-project/run.mjs';
import { StackClient, assistantText, terminalStatus } from '../../generated-project/stack-api.mjs';
import {
  JourneyFailure,
  agentNameOfSource,
  devOrigin,
  parseDevLine,
} from '../../journey/harness.mjs';
import { VERDACCIO_IMAGE, publishPackages, waitForRegistry } from '../../journey/run.mjs';
import {
  ALLOWED_HOST,
  DECLARATION,
  DECLARED_SECRET,
  PROVIDER_SCRIPT,
  RUN_FILE,
  TOOL_NAME,
} from '../tool-sandbox.e2e.mjs';
import { buildJourneyImages, startRegistry, stopRegistry } from './registry.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');
// Named per runner: the self-hosted CI host runs several jobs on one Docker daemon at once.
const VERDACCIO_CONTAINER = `build-deploy-journey-verdaccio-${(process.env.RUNNER_NAME ?? 'local').replace(/[^\w.-]/gu, '-')}`;
const SCRIPTS_DIR = path.join(import.meta.dirname, 'scripts');
const SCRIPTED_MODEL = 'scripted:support-journey';
const PREPARE_BUDGET_MS = 45 * 60_000;
const WEB_URL = 'http://127.0.0.1:3000';
/** `environments.production`: the url only needs a host that resolves. */
const PRODUCTION = '  production:\n    target: single-vm\n    url: https://localhost\n';
/** The promotion bar `aw deploy` carries to the deployment (#836) and `aw dev` enforces. */
const PROMOTION_BAR = 'policy:\n  promotion:\n    minEvalScore: 1\n';

/** @param {boolean} ok @param {string} message */
export function check(ok, message) {
  if (!ok) throw new JourneyFailure(`journey assertion failed: ${message}`);
  console.log(`ok: ${message}`);
}

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

/** @param {readonly string[]} args @param {import('node:child_process').SpawnSyncOptions} options */
export function spawnChecked(command, args, options, expected = 0) {
  const result = spawnSync(command, [...args], { encoding: 'utf8', shell: false, ...options });
  const output = `${String(result.stdout)}${String(result.stderr)}`;
  if (result.status !== expected) {
    throw new JourneyFailure(
      `${command} ${args.join(' ')} exited ${String(result.status ?? result.signal)}, not ${String(expected)}\n${output}`,
    );
  }
  return output;
}

/** Local `aw dev`: lines parsed as the other journeys do; stopped through its process group. */
export function startDev(project, env) {
  const child = spawn(path.join(project, 'node_modules/.bin/aw'), ['dev'], {
    cwd: project,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { log: '', ready: null, synced: 0, exited: false };
  let pending = '';
  const read = (/** @type {Buffer} */ chunk) => {
    pending += chunk.toString('utf8');
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const parsed = parseDevLine(line);
      // The launcher's one-time admin password is neither echoed nor kept for failure messages.
      if (parsed?.kind !== 'adminSignIn') {
        console.log(line);
        state.log += `${line}\n`;
      }
      state.ready ??= devOrigin(parsed);
      if (parsed?.kind === 'synced') state.synced += 1;
    }
  };
  child.stdout.on('data', read);
  child.stderr.on('data', read);
  const closed = new Promise((resolve) =>
    child.once('close', () => {
      state.exited = true;
      resolve(undefined);
    }),
  );
  return {
    state,
    async untilSynced(timeoutMs) {
      const until = Date.now() + timeoutMs;
      while (state.ready === null || state.synced === 0) {
        if (state.exited) throw new JourneyFailure(`aw dev exited early\n${state.log}`);
        if (Date.now() > until)
          throw new JourneyFailure(`aw dev was not synced in time\n${state.log}`);
        await delay(500);
      }
    },
    async stop() {
      if (child.pid !== undefined && !state.exited) process.kill(-child.pid, 'SIGTERM');
      await Promise.race([closed, delay(30_000)]);
      if (child.pid !== undefined && !state.exited) process.kill(-child.pid, 'SIGKILL');
    },
  };
}

/** A chat-turn nonce the fake provider recognises (`tests/journey/fake-anthropic-tools.mjs`). */
export function chatNonce() {
  return `e2e-nonce-journey${randomBytes(4).toString('hex')}`;
}

/** The Compose override for the single-vm state directory; not part of what `aw deploy` writes. */
export function composeOverride({
  project,
  nodeImage,
  controlPort,
  fixture,
  toolHost,
  egressProxy,
}) {
  const sandbox = `      AGENT_WORKSPACE_TOOL_HOST_IMAGE: ${toolHost}
      AGENT_WORKSPACE_EGRESS_PROXY_IMAGE: ${egressProxy}`;
  // The extra environment goes before `volumes:`, inside the `environment:` mapping.
  const trust = (extraEnvironment = '') => `      EGRESS_ALLOW_HOSTS: ${FAKE_PROVIDER_HOST}
      NODE_EXTRA_CA_CERTS: /e2e/ca.pem${extraEnvironment}
    volumes:
      - ${fixture}/ca.pem:/e2e/ca.pem:ro
    depends_on:
      fake-anthropic: { condition: service_healthy }`;
  return `# Written by tests/e2e/build-deploy-journey/journey.e2e.mjs; not part of the deployment.
# The tool sandbox and the fake provider are not in the single-vm template yet.
services:
  fake-anthropic:
    image: ${nodeImage}
    command: [node, /repo/tests/e2e/tool-sandbox-provider.mjs]
    environment:
      FAKE_ANTHROPIC_TLS_CERT: /e2e/${FAKE_PROVIDER_HOST}.pem
      FAKE_ANTHROPIC_TLS_KEY: /e2e/${FAKE_PROVIDER_HOST}.key
    volumes:
      - ${fixture}:/e2e:ro
      - ${path.join(ROOT, 'tests')}:/repo/tests:ro
    ports: ['127.0.0.1:${String(controlPort)}:8081']
    healthcheck:
      test: [CMD, node, -e, "fetch('http://127.0.0.1:8081/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 2s
      timeout: 3s
      retries: 30
    networks:
      provider-egress: { aliases: [${FAKE_PROVIDER_HOST}] }
      web-ingress: { aliases: [${FAKE_PROVIDER_HOST}] }
  gateway:
    environment:
${trust()}
    networks: [tool-sandbox]
  web:
    environment:
${trust(`\n${sandbox}`)}
  runner:
    environment:
${sandbox}
      AGENT_WORKSPACE_TOOL_NETWORK: ${project}-tool-sandbox
      RUNTIME_PROXY_BYPASS: gateway
    networks: [tool-sandbox]
networks:
  tool-sandbox:
    name: ${project}-tool-sandbox
    internal: true
    attachable: true
    labels:
      agent-workspace.runtime: docker-network
`;
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

async function main() {
  const work = path.resolve(
    process.env['BD_WORK_DIR'] ?? mkdtempSync(path.join(tmpdir(), 'build-deploy-journey-')),
  );
  const npmPort = positiveIntegerVariable('BD_NPM_PORT', 4873, { max: 65_535 });
  const registryPort = positiveIntegerVariable('BD_REGISTRY_PORT', 5000, { max: 65_535 });
  const controlPort = positiveIntegerVariable('BD_CONTROL_PORT', 18083, { max: 65_535 });
  const deadline = Date.now() + positiveIntegerVariable('BD_PREPARE_TIMEOUT_MS', PREPARE_BUDGET_MS);
  const { npmUrl, home, evidence, userEnv } = journeyShell({ work, npmPort });
  const gitRevision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  const revision = gitRevision.status === 0 ? gitRevision.stdout.trim() : 'unknown';

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
    const { aw, agentPath, rendered, agentName } = created;
    await evaluateScripted({ created, userEnv, evidence, production: PRODUCTION });

    console.log('== chapter 3: aw deploy production');
    writeFileSync(agentPath, agentWithTool(rendered, "'anthropic default'"));
    const deployEnv = {
      ...userEnv,
      ...images.overrides,
    };
    aw(['deploy', 'production', '--plan'], deployEnv, 3);
    const deployments = path.join(home, '.config/agent-workspace/deployments/demo/production');
    stateDirectory = deployments;
    const stateEnv = parseDotEnv(readFileSync(path.join(deployments, '.env'), 'utf8'));
    const composeProject = stateEnv['COMPOSE_PROJECT_NAME'] ?? '';
    check(composeProject !== '', 'the deployment state names its Compose project');
    writeFakeProviderFixture(work, PROVIDER_SCRIPT);
    writeFileSync(
      path.join(deployments, 'compose.override.yaml'),
      composeOverride({
        project: composeProject,
        nodeImage: nodeImageOf(readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')),
        controlPort,
        fixture: path.join(work, '.e2e'),
        toolHost: images.toolHost,
        egressProxy: images.egressProxy,
      }),
    );
    aw(['deploy', 'production', '--yes'], deployEnv);

    const client = new StackClient(WEB_URL);
    for (let attempt = 0; ; attempt += 1) {
      const ready = await fetch(`${WEB_URL}/setup`, { redirect: 'manual' }).then(
        (response) => response.ok,
        () => false,
      );
      if (ready) break;
      if (attempt > 180)
        throw new JourneyFailure('the web service did not answer /setup in 6 minutes');
      await delay(2_000);
    }
    const adminEmail = stateEnv['BOOTSTRAP_ADMIN'] ?? '';
    const setup = await client.setup({
      provider: 'anthropic',
      providerApiKey: `sk-ant-journey-fake-${randomBytes(6).toString('hex')}`,
      runtime: 'docker',
      adminEmail,
      adminPassword: stateEnv['BOOTSTRAP_ADMIN_PASSWORD'] ?? '',
      agentName: 'journey setup agent',
      agentInstructions: 'Answer briefly.',
    });
    check(
      setup.status === 201,
      `setup answered ${String(setup.status)} ${setup.text.slice(0, 200)}`,
    );
    const minted = await client.request('/api/api-keys', {
      method: 'POST',
      body: { name: 'build-deploy-journey', role: 'admin', expiresAt: null },
    });
    const apiKey = /** @type {{ key: string }} */ (minted.json).key;
    check(apiKey.startsWith('ak_live_'), 'an API key was minted for aw');
    const remote = { ...userEnv, AGENT_WORKSPACE_URL: WEB_URL, AGENT_WORKSPACE_API_KEY: apiKey };

    const declaredValue = `journey-declared-${randomBytes(6).toString('hex')}`;
    const secret = await client.request('/api/secrets', {
      method: 'POST',
      body: { name: DECLARED_SECRET, value: declaredValue },
    });
    check(secret.status === 201, `the declared secret was set (${String(secret.status)})`);

    aw(['push', '--yes'], remote);
    const agents =
      /** @type {{ agents: { id: string, name: string, runtimeProfileId?: string | null }[] }} */ (
        (await client.request('/api/agents')).json
      ).agents;
    const agent = agents.find((candidate) => candidate.name === agentName);
    check(agent !== undefined, 'aw push created the agent on the deployment');
    // A pushed definition names no runtime profile: it runs on the one setup seeded.
    const profileId = agents.find((a) => a.name === 'journey setup agent')?.runtimeProfileId;
    check(typeof profileId === 'string', 'setup seeded a runtime profile');
    const attached = await client.request(`/api/agents/${agent?.id ?? ''}`, {
      method: 'PATCH',
      body: { runtimeProfileId: profileId },
    });
    check(attached.status === 200, `the runtime profile was attached (${String(attached.status)})`);

    // The chat turn: the model asks for the tool, the tool sandbox runs it behind the proxy.
    const nonce = chatNonce();
    const started = await client.request(`/api/agents/${agent?.id ?? ''}/runs`, {
      method: 'POST',
      body: { prompt: `Please look up order ${nonce}.` },
    });
    check(started.status === 202, `the run was accepted (${String(started.status)})`);
    const runId = /** @type {{ run: { id: string } }} */ (started.json).run.id;
    const frames = await client.runFrames(runId);
    check(
      terminalStatus(frames) === 'completed',
      `the run completed (${JSON.stringify(frames.slice(-3))})`,
    );
    const reply = assistantText(frames);
    check(reply.includes(`order-data-${nonce}`), "the reply carries the code tool's data");
    check(reply.includes(`declared=${declaredValue}`), 'the tool read the secret it declared');
    check(reply.includes('database_url=absent'), 'the tool does not see DATABASE_URL');
    check(/allowed=reached:\d+/u.test(reply), `the proxy let ${ALLOWED_HOST} through (${reply})`);
    check(
      reply.includes('refused=denied:host_not_allowed'),
      `the proxy refused example.com, which the tool never declared (${reply})`,
    );
    const seen = /** @type {{ toolRequests: { toolNames: string[] }[] }} */ (
      await (await fetch(`http://127.0.0.1:${String(controlPort)}/requests`)).json()
    );
    check(
      seen.toolRequests.some((request) =>
        request.toolNames.some((name) => name.endsWith(`__${TOOL_NAME}`)),
      ),
      'the model was offered the code tool through the tool sandbox connector',
    );

    // #848: the web service migrated once, with no migrate service in the template.
    const webLog = spawnChecked('docker', ['compose', 'logs', '--no-color', 'web'], {
      cwd: deployments,
      env: userEnv,
    });
    check(
      (webLog.match(/db:migrate — applied \d+ migration/gu) ?? []).length === 1,
      'migrations ran once',
    );

    promotePastGate({ created, remote, evidence, refusal: true });
    failed = false;
  } finally {
    if (stateDirectory !== '' && existsSync(stateDirectory)) {
      if (failed) {
        spawnSync('docker', ['compose', 'logs', '--no-color', '--tail', '200'], {
          cwd: stateDirectory,
          env: userEnv,
          stdio: 'inherit',
        });
      }
      spawnSync('docker', ['compose', 'down', '--volumes', '--remove-orphans', '--timeout', '5'], {
        cwd: stateDirectory,
        env: userEnv,
        stdio: 'inherit',
      });
    }
    // ponytail: removes every runtime, tool-host and proxy container on the daemon, not only this
    // deployment's; the journey needs a disposable daemon, as the tool-sandbox E2E does.
    const leftovers = spawnSync(
      'docker',
      ['ps', '--all', '--quiet', '--filter', 'label=agent-workspace.runtime'],
      { encoding: 'utf8' },
    )
      .stdout.split('\n')
      .filter(Boolean);
    if (leftovers.length > 0) {
      spawnSync('docker', ['rm', '--force', '--volumes', ...leftovers], { stdio: 'inherit' });
    }
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
