/* global fetch */
/**
 * Chapter 3 of the build-to-deploy journey: `aw deploy production` on this host, the setup wizard,
 * an API key, `aw push`, one chat turn that calls the code tool, and the deployment's cleanup.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { parseDotEnv, writeFakeProviderFixture } from '../../generated-project/project.mjs';
import { nodeImageOf } from '../../generated-project/run.mjs';
import { assistantText, terminalStatus } from '../../generated-project/stack-api.mjs';
import { JourneyFailure } from '../../journey/harness.mjs';
import { ALLOWED_HOST, DECLARED_SECRET, PROVIDER_SCRIPT, TOOL_NAME } from '../tool-sandbox.e2e.mjs';
import { composeOverride } from './compose-override.mjs';
import { ROOT, check, spawnChecked } from './journey-support.mjs';

export const WEB_URL = 'http://127.0.0.1:3000';
const WEB_POLL_ATTEMPTS = 180;
const WEB_POLL_INTERVAL_MS = 2_000;
const SETUP_AGENT_NAME = 'journey setup agent';

/**
 * `aw deploy production --plan`, the Compose override for what the template does not wire yet, then
 * `aw deploy production --yes`.
 *
 * @param {{ aw: (args: readonly string[], env?: NodeJS.ProcessEnv, expected?: number) => string, work: string, home: string, deployEnv: NodeJS.ProcessEnv, images: { toolHost: string, egressProxy: string }, controlPort: number, onStateDirectory: (directory: string) => void }} options
 * @returns the deployment's state directory and its parsed `.env`
 */
export function deployProduction({
  aw,
  work,
  home,
  deployEnv,
  images,
  controlPort,
  onStateDirectory,
}) {
  aw(['deploy', 'production', '--plan'], deployEnv, 3);
  const deployments = path.join(home, '.config/agent-workspace/deployments/demo/production');
  onStateDirectory(deployments);
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
  return { deployments, stateEnv };
}

/** Waits for the web service to answer `/setup`. */
async function waitForWeb() {
  for (let attempt = 0; ; attempt += 1) {
    const ready = await fetch(`${WEB_URL}/setup`, { redirect: 'manual' }).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) return;
    if (attempt > WEB_POLL_ATTEMPTS)
      throw new JourneyFailure('the web service did not answer /setup in 6 minutes');
    await delay(WEB_POLL_INTERVAL_MS);
  }
}

/**
 * Runs the setup wizard and mints an admin API key.
 *
 * @param {import('../../generated-project/stack-api.mjs').StackClient} client
 * @param {Record<string, string>} stateEnv @param {NodeJS.ProcessEnv} userEnv
 * @returns the environment of a user pointed at the deployment
 */
export async function setUpDeployment(client, stateEnv, userEnv) {
  await waitForWeb();
  const setup = await client.setup({
    provider: 'anthropic',
    providerApiKey: `sk-ant-journey-fake-${randomBytes(6).toString('hex')}`,
    runtime: 'docker',
    adminEmail: stateEnv['BOOTSTRAP_ADMIN'] ?? '',
    adminPassword: stateEnv['BOOTSTRAP_ADMIN_PASSWORD'] ?? '',
    agentName: SETUP_AGENT_NAME,
    agentInstructions: 'Answer briefly.',
  });
  check(setup.status === 201, `setup answered ${String(setup.status)} ${setup.text.slice(0, 200)}`);
  const minted = await client.request('/api/api-keys', {
    method: 'POST',
    body: { name: 'build-deploy-journey', role: 'admin', expiresAt: null },
  });
  const apiKey = /** @type {{ key: string }} */ (minted.json).key;
  check(apiKey.startsWith('ak_live_'), 'an API key was minted for aw');
  return { ...userEnv, AGENT_WORKSPACE_URL: WEB_URL, AGENT_WORKSPACE_API_KEY: apiKey };
}

/**
 * Sets the declared secret, runs `aw push` and attaches the runtime profile setup seeded.
 *
 * @param {import('../../generated-project/stack-api.mjs').StackClient} client
 * @param {{ created: { aw: (args: readonly string[], env?: NodeJS.ProcessEnv) => string, agentName: string }, remote: NodeJS.ProcessEnv, declaredValue: string }} options
 * @returns the pushed agent's id
 */
export async function pushAgent(client, { created, remote, declaredValue }) {
  const secret = await client.request('/api/secrets', {
    method: 'POST',
    body: { name: DECLARED_SECRET, value: declaredValue },
  });
  check(secret.status === 201, `the declared secret was set (${String(secret.status)})`);

  created.aw(['push', '--yes'], remote);
  const agents =
    /** @type {{ agents: { id: string, name: string, runtimeProfileId?: string | null }[] }} */ (
      (await client.request('/api/agents')).json
    ).agents;
  const agent = agents.find((candidate) => candidate.name === created.agentName);
  check(agent !== undefined, 'aw push created the agent on the deployment');
  // A pushed definition names no runtime profile: it runs on the one setup seeded.
  const profileId = agents.find((a) => a.name === SETUP_AGENT_NAME)?.runtimeProfileId;
  check(typeof profileId === 'string', 'setup seeded a runtime profile');
  const agentId = agent?.id ?? '';
  const attached = await client.request(`/api/agents/${agentId}`, {
    method: 'PATCH',
    body: { runtimeProfileId: profileId },
  });
  check(attached.status === 200, `the runtime profile was attached (${String(attached.status)})`);
  return agentId;
}

/**
 * The chat turn: the model asks for the tool, the tool sandbox runs it behind the proxy.
 *
 * @param {import('../../generated-project/stack-api.mjs').StackClient} client
 * @param {{ agentId: string, nonce: string, declaredValue: string, controlPort: number }} options
 */
export async function chatThroughTool(client, { agentId, nonce, declaredValue, controlPort }) {
  const started = await client.request(`/api/agents/${agentId}/runs`, {
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
}

/** #848: the web service migrated once, with no migrate service in the template. */
export function checkMigrationsRanOnce(deployments, userEnv) {
  const webLog = spawnChecked('docker', ['compose', 'logs', '--no-color', 'web'], {
    cwd: deployments,
    env: userEnv,
  });
  check(
    (webLog.match(/db:migrate — applied \d+ migration/gu) ?? []).length === 1,
    'migrations ran once',
  );
}

/** Takes the deployment down (logging it first when the journey failed). */
export function tearDownDeployment({ stateDirectory, failed, userEnv }) {
  if (stateDirectory === '' || !existsSync(stateDirectory)) return;
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

/**
 * ponytail: removes every runtime, tool-host and proxy container on the daemon, not only this
 * deployment's; the journey needs a disposable daemon, as the tool-sandbox E2E does.
 */
export function removeRuntimeContainers() {
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
}
