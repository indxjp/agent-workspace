#!/usr/bin/env node
/** Code-tool sandbox acceptance on a disposable Docker daemon, using the fake provider.
 * Usage: pnpm build && node tests/e2e/tool-sandbox.e2e.mjs. Cleanup removes runtime containers.
 */
/* global fetch, console */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { nodeImageOf } from '../generated-project/run.mjs';
import { run, writeFakeProviderFixture } from '../generated-project/project.mjs';
import { StackClient, assistantText, terminalStatus } from '../generated-project/stack-api.mjs';
import { IMAGES, composeBuildServices, docker } from './tool-sandbox-images.mjs';
import {
  ROOT,
  PROJECT,
  AW_BIN,
  PROVIDER_SCRIPT,
  TOOL_HOST_URL,
  TOOL_NAME,
  DECLARED_SECRET,
  bundledStorageUrl,
  stackEnv,
  composeOverride,
  writeToolProject,
} from './tool-sandbox-project.mjs';
import {
  check,
  assertSandboxIsolation,
  assertPromotion,
  cleanSandboxStack,
} from './tool-sandbox-assertions.mjs';
export {
  PROVIDER_SCRIPT,
  TOOL_HOST_URL,
  TOOL_NAME,
  DECLARED_SECRET,
  ALLOWED_HOST,
  DECLARATION,
  OFFLINE_DECLARATION,
  OFFLINE_RUN_FILE,
  RUN_FILE,
  bundledStorageUrl,
  stackEnv,
} from './tool-sandbox-project.mjs';

/** @param {string} name */
function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

async function verifySandboxToolRun({ client, agent, declaredValue, gatewaySecret, controlPort }) {
  // The run: the model asks for the tool, the tool sandbox answers, the run completes.
  const nonce = `e2e-nonce-ts${randomBytes(4).toString('hex')}`;
  const started = await client.request(`/api/agents/${agent?.id ?? ''}/runs`, {
    method: 'POST',
    body: { prompt: `Please look up order ${nonce}.` },
  });
  check(
    started.status === 202,
    `the run was accepted (${String(started.status)} ${started.text.slice(0, 200)})`,
  );
  const runId = /** @type {{ run: { id: string } }} */ (started.json).run.id;
  const frames = await client.runFrames(runId);
  check(
    terminalStatus(frames) === 'completed',
    `the run completed (${JSON.stringify(frames.slice(-3))})`,
  );
  const reply = assistantText(frames);
  check(reply.includes(`order-data-${nonce}`), "the reply carries the code tool's data");
  await assertSandboxIsolation(reply, declaredValue, gatewaySecret, runId);
  const seen = /** @type {{ toolRequests: { toolNames: string[] }[] }} */ (
    await (await fetch(`http://127.0.0.1:${String(controlPort)}/requests`)).json()
  );
  // An MCP connector whose name is a usable slug is keyed by it (connectorServerKey, #1109).
  check(
    seen.toolRequests.some((request) =>
      request.toolNames.includes(`mcp__aw-dev-tools__${TOOL_NAME}`),
    ),
    `the model was offered the code tool through the aw-dev-tools server (${JSON.stringify(seen.toolRequests.map((request) => request.toolNames))})`,
  );
}

async function publishToolProject({ client, aw, declaredValue }) {
  // The secret the tool declares, set through the API before the run resolves it.
  const created = await client.request('/api/secrets', {
    method: 'POST',
    body: { name: DECLARED_SECRET, value: declaredValue },
  });
  check(
    created.status === 201,
    `the declared secret was set (${String(created.status)} ${created.text.slice(0, 200)})`,
  );

  // Acceptance 1: push makes the tool-host connector and the version with the bundle digest.
  aw(['push', '--yes']);
  const connectors = /** @type {{ connectors: { id: string, name: string, url?: string }[] }} */ (
    (await client.request('/api/connectors')).json
  ).connectors;
  const devTools = connectors.find((c) => c.name === 'aw-dev-tools' && c.url === TOOL_HOST_URL);
  check(devTools !== undefined, 'aw push created the aw-dev-tools connector at the reserved URL');
  const agents =
    /** @type {{ agents: { id: string, name: string, runtimeProfileId?: string | null }[] }} */ (
      (await client.request('/api/agents')).json
    ).agents;
  const agent = agents.find((candidate) => candidate.name === 'assistant');
  check(agent !== undefined, 'aw push created the agent');
  // A pushed definition names no runtime profile and a runtime has no inheritance layer, so the
  // pushed agent runs on the profile setup seeded for its own agent.
  const profileId = agents.find((a) => a.name === 'E2E setup agent')?.runtimeProfileId;
  check(typeof profileId === 'string', 'setup seeded a runtime profile');
  const attached = await client.request(`/api/agents/${agent?.id ?? ''}`, {
    method: 'PATCH',
    body: { runtimeProfileId: profileId },
  });
  check(
    attached.status === 200,
    `the runtime profile was attached (${String(attached.status)} ${attached.text.slice(0, 200)})`,
  );
  const versions = JSON.parse(aw(['versions', '--json']));
  check(
    versions.pointers.some((/** @type {{ environment: string }} */ p) => p.environment === 'local'),
    'aw push moved local to the new version',
  );

  return agent;
}

async function provisionSandboxStack({ client, providerKey, adminEmail, adminPassword }) {
  const setup = await client.setup({
    provider: 'anthropic',
    providerApiKey: providerKey,
    runtime: 'docker',
    adminEmail,
    adminPassword,
    agentName: 'E2E setup agent',
    agentInstructions: 'Answer briefly.',
  });
  check(setup.status === 201, `setup answered ${String(setup.status)} ${setup.text.slice(0, 200)}`);
  const minted = await client.request('/api/api-keys', {
    method: 'POST',
    body: { name: 'tool-sandbox-e2e', role: 'admin', expiresAt: null },
  });
  const apiKey = /** @type {{ key: string }} */ (minted.json).key;
  check(apiKey.startsWith('ak_live_'), 'an API key was minted for aw');

  return apiKey;
}

async function startSandboxStack({ compose, baseUrl }) {
  if (process.env['TS_SKIP_IMAGE_BUILD'] === undefined) {
    for (const [dockerfile, target, tag, args] of IMAGES) {
      docker(['build', '--file', dockerfile, '--target', target, ...args, '--tag', tag, '.']);
    }
  }
  compose(['build', ...composeBuildServices()]);
  compose(['up', '--detach']);

  const client = new StackClient(baseUrl);
  for (let attempt = 0; ; attempt += 1) {
    const ready = await fetch(`${baseUrl}/setup`, { redirect: 'manual' }).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) break;
    if (attempt > 180) throw new Error('the web service did not answer /setup within 6 minutes');
    await delay(2_000);
  }

  return client;
}

function composeFor(work) {
  return (/** @type {readonly string[]} */ args) =>
    docker([
      'compose',
      '--project-name',
      PROJECT,
      '--project-directory',
      ROOT,
      '--env-file',
      path.join(work, 'stack.env'),
      '-f',
      path.join(ROOT, 'compose.yaml'),
      '-f',
      path.join(work, 'compose.override.yaml'),
      ...args,
    ]);
}

async function prepareSandboxStack() {
  const work = path.resolve(
    process.env['TS_WORK_DIR'] ?? mkdtempSync(path.join(tmpdir(), 'tool-sandbox-e2e-')),
  );
  const webPort = Number(required('TS_WEB_PORT', '3000'));
  const controlPort = Number(required('TS_CONTROL_PORT', '18082'));
  const baseUrl = `http://127.0.0.1:${String(webPort)}`;
  const adminEmail = 'admin@example.com';
  const adminPassword = randomBytes(12).toString('hex');
  const providerKey = `sk-ant-e2e-fake-${randomBytes(6).toString('hex')}`;
  const gatewaySecret = randomBytes(32).toString('hex');
  const declaredValue = `e2e-declared-${randomBytes(6).toString('hex')}`;

  mkdirSync(work, { recursive: true });
  writeFakeProviderFixture(work, PROVIDER_SCRIPT);
  const fixture = path.join(work, '.e2e');
  writeFileSync(
    path.join(work, 'compose.override.yaml'),
    composeOverride({
      nodeImage: nodeImageOf(readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')),
      controlPort,
      fixture,
      gatewaySecret,
    }),
  );
  writeFileSync(
    path.join(work, 'stack.env'),
    stackEnv({
      adminEmail,
      adminPassword,
      webPort,
      dockerGid: statSync('/var/run/docker.sock').gid,
      storageUrl: bundledStorageUrl(),
    }),
  );
  const compose = composeFor(work);

  const project = await writeToolProject(work);
  return {
    project,
    compose,
    baseUrl,
    controlPort,
    adminEmail,
    adminPassword,
    providerKey,
    gatewaySecret,
    declaredValue,
  };
}

async function main() {
  const {
    project,
    compose,
    baseUrl,
    controlPort,
    adminEmail,
    adminPassword,
    providerKey,
    gatewaySecret,
    declaredValue,
  } = await prepareSandboxStack();
  let failed = true;
  try {
    const client = await startSandboxStack({ compose, baseUrl });
    const apiKey = await provisionSandboxStack({ client, providerKey, adminEmail, adminPassword });
    const aw = (/** @type {readonly string[]} */ args) =>
      run(process.execPath, [AW_BIN, ...args], {
        cwd: project,
        env: { ...process.env, AGENT_WORKSPACE_URL: baseUrl, AGENT_WORKSPACE_API_KEY: apiKey },
        timeoutMs: 180_000,
      });

    const agent = await publishToolProject({ client, aw, declaredValue });
    await verifySandboxToolRun({ client, agent, declaredValue, gatewaySecret, controlPort });
    await assertPromotion(aw);
    failed = false;
  } finally {
    cleanSandboxStack(failed);
  }
}

// Imported by tests/e2e/build-deploy-journey for the tool, its probe and the fake provider.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
