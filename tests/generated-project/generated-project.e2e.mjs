/* global console, fetch, process */
/**
 * The generated project, end to end, as a new user meets it (issue #398): `npm create` with the
 * packed generator, `pnpm install` and `pnpm start`, setup through the API, a chat through the API,
 * through `aw` and through the browser, and teardown. Everything runs against the packages and
 * images built from this checkout; `run.mjs` prepares them and starts this file. The only model is
 * the fake Anthropic API (`fake-anthropic.mjs`); no real key exists anywhere in the run.
 *
 * The tests share one project and run in order: each step needs the state the previous one made.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import {
  composeOverride,
  parseCreateOutput,
  projectLeftovers,
  readEnvironmentFile,
  removeProject,
  run,
  runStreaming,
  withTarballOverrides,
  writeFakeProviderFixture,
} from './project.mjs';
import { REJECTED_KEY_PREFIX } from './fake-anthropic.mjs';
import { StackClient, assistantText, terminalStatus } from './stack-api.mjs';

/** @param {string} name */
function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set: start this suite with node tests/generated-project/run.mjs`,
    );
  }
  return value;
}

const WORK = required('GP_WORK_DIR');
const CONSUMER = required('GP_CONSUMER_DIR');
/** @type {Record<string, string>} */
const TARBALLS = JSON.parse(required('GP_TARBALLS'));
/** @type {Record<string, string>} */
const IMAGE_OVERRIDES = JSON.parse(required('GP_IMAGE_OVERRIDES'));
const NODE_IMAGE = required('GP_NODE_IMAGE');
const CONTROL_PORT = Number(required('GP_FAKE_CONTROL_PORT'));
const REGISTRY = required('GP_REGISTRY');
const FAKE_SCRIPT = path.join(import.meta.dirname, 'fake-anthropic.mjs');

/** A name no other project on the host uses, so the leftover accounting is this project's alone. */
const PROJECT_DIRECTORY_NAME = `gp-e2e-${randomBytes(3).toString('hex')}`;
const PROJECT = path.join(WORK, PROJECT_DIRECTORY_NAME);
/** A test value: the fake provider accepts it, and the test checks this one reaches it. */
const PROVIDER_KEY = `sk-ant-e2e-fake-${randomBytes(6).toString('hex')}`;
/** A key the fake provider refuses with `401`, as Anthropic refuses a wrong one (issue #415). */
const REJECTED_KEY = `${REJECTED_KEY_PREFIX}${randomBytes(6).toString('hex')}`;
const AGENT_NAME = 'E2E Wizard Agent';
/** An agent created through the API with no runtime profile, whose runs #403 refuses. */
const REFUSED_AGENT_NAME = 'E2E Agent Without Runtime';

/** @param {string} label */
function nonce(label) {
  return `e2e-nonce-${label}${randomBytes(4).toString('hex')}`;
}

/** @param {string} value */
function expectedReply(value) {
  return `Fake Anthropic reply to ${value}: the generated project answered.`;
}

const state = {
  projectName: '',
  adminEmail: '',
  adminPassword: '',
  baseUrl: '',
  agentId: '',
  apiKey: '',
  /** @type {StackClient | null} */
  client: null,
};

function client() {
  if (state.client === null) throw new Error('the project has not been started');
  return state.client;
}

async function fakeRequests() {
  const response = await fetch(`http://127.0.0.1:${String(CONTROL_PORT)}/requests`);
  const body =
    /** @type {{ requests: { path: string, method: string, apiKey: string | null, stream: boolean, reply: string | null }[] }} */ (
      await response.json()
    );
  return body.requests;
}

/** @param {readonly string[]} args */
function aw(args) {
  return run('npx', ['--no-install', 'aw', ...args], {
    cwd: CONSUMER,
    env: {
      ...process.env,
      AGENT_WORKSPACE_URL: state.baseUrl,
      AGENT_WORKSPACE_API_KEY: state.apiKey,
    },
    timeoutMs: 90_000,
  });
}

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  if (state.projectName === '' || !existsSync(PROJECT)) return;
  // The logs are the evidence of a failed step; they are attached before anything is removed.
  try {
    const logs = run('docker', ['compose', 'logs', '--no-color', '--timestamps'], {
      cwd: PROJECT,
    });
    await test.info().attach('compose-logs.txt', { body: logs, contentType: 'text/plain' });
  } finally {
    // Even when the logs cannot be read, the project is removed.
    removeProject(PROJECT, state.projectName);
  }
});

test('create writes a project from the packed generator that pins this change’s images', () => {
  // The E2E runs the v1 Compose flow: `create` writes a v2 project by default (S1-16), so the
  // flag that selects Compose follows npm's `--` to reach the bin.
  const output = run(
    'npm',
    ['create', '@indx-workspace', PROJECT, '--offline', '--', '--cloud', 'local'],
    {
      cwd: CONSUMER,
      env: { ...process.env, ...IMAGE_OVERRIDES, npm_config_update_notifier: 'false' },
    },
  );
  const created = parseCreateOutput(output);
  state.adminEmail = created.adminEmail;
  state.adminPassword = created.adminPassword;
  expect(created.nextStep).toContain('pnpm install --frozen-lockfile=false && pnpm start');

  const environment = readEnvironmentFile(path.join(PROJECT, '.env'));
  state.projectName = environment['COMPOSE_PROJECT_NAME'] ?? '';
  expect(state.projectName).toBe(PROJECT_DIRECTORY_NAME);
  for (const key of ['WEB_IMAGE', 'GATEWAY_IMAGE', 'RUNNER_IMAGE']) {
    expect(environment[key]).toMatch(
      new RegExp(`^${REGISTRY}/agent-workspace/[a-z-]+@sha256:[0-9a-f]{64}$`, 'u'),
    );
  }
  expect(environment['AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK']).toMatch(
    new RegExp(`^${REGISTRY}/agent-workspace/runtime-claude-agent-sdk@sha256:[0-9a-f]{64}$`, 'u'),
  );
  const manifest = JSON.parse(readFileSync(path.join(PROJECT, 'package.json'), 'utf8'));
  expect(Object.keys(manifest.dependencies)).toEqual(['@indx-workspace/cli']);
});

test('pnpm install and pnpm start bring every service up healthy', async () => {
  // Install and start are the one step past the 5-minute default (a cold start pulls PostgreSQL
  // and SeaweedFS); it took about a minute locally.
  test.setTimeout(12 * 60_000);
  const workspaceFile = path.join(PROJECT, 'pnpm-workspace.yaml');
  writeFileSync(workspaceFile, withTarballOverrides(readFileSync(workspaceFile, 'utf8'), TARBALLS));
  writeFakeProviderFixture(PROJECT, FAKE_SCRIPT);
  // CI runs several jobs on one Docker host, so it may name free host ports. These are the `.env`
  // settings a user changes to run beside another project (`agent-workspace start` names PORT
  // when 3000 is taken; the SEAWEEDFS_PORT comment names the endpoint that moves with it).
  const envFile = path.join(PROJECT, '.env');
  let contents = readFileSync(envFile, 'utf8');
  const webPort = process.env['GP_WEB_PORT'];
  if (webPort !== undefined && webPort !== '') {
    expect(contents).toMatch(/^PORT=127\.0\.0\.1:3000$/mu);
    contents = contents.replace(/^PORT=.*$/mu, `PORT=127.0.0.1:${webPort}`);
  }
  const objectStorePort = process.env['GP_OBJECT_STORE_PORT'];
  if (objectStorePort !== undefined && objectStorePort !== '') {
    expect(contents).toMatch(/^SEAWEEDFS_PORT=8333$/mu);
    contents = contents
      .replace(/^SEAWEEDFS_PORT=.*$/mu, `SEAWEEDFS_PORT=${objectStorePort}`)
      .replaceAll('localhost:8333', `localhost:${objectStorePort}`);
  }
  writeFileSync(envFile, contents);
  writeFileSync(
    path.join(PROJECT, 'compose.override.yaml'),
    composeOverride({ nodeImage: NODE_IMAGE, controlPort: CONTROL_PORT }),
  );

  run('pnpm', ['install', '--frozen-lockfile=false'], { cwd: PROJECT, timeoutMs: 240_000 });
  const installed = JSON.parse(
    readFileSync(path.join(PROJECT, 'node_modules/@indx-workspace/cli/package.json'), 'utf8'),
  );
  const packed = JSON.parse(
    run('tar', ['-xzOf', TARBALLS['@indx-workspace/cli'] ?? '', 'package/package.json']),
  );
  expect(installed.version).toBe(packed.version);

  const started = await runStreaming('pnpm', ['start'], { cwd: PROJECT, timeoutMs: 7 * 60_000 });
  expect(started.status, started.output).toBe(0);
  const url = /Agent Workspace is up: (\S+)/u.exec(started.output)?.[1];
  expect(url, started.output).toBeDefined();
  state.baseUrl = url ?? '';
  state.client = new StackClient(state.baseUrl);

  const services = run(
    'docker',
    ['compose', 'ps', '--all', '--format', '{{.Service}} {{.State}} {{.Health}}'],
    {
      cwd: PROJECT,
    },
  )
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/u));
  const byService = Object.fromEntries(
    services.map(([name = '', ...rest]) => [name, rest.join(' ')]),
  );
  for (const service of ['postgres', 'runner', 'gateway', 'web', 'fake-anthropic']) {
    expect(byService[service], JSON.stringify(byService)).toBe('running healthy');
  }
});

test('setup with a key the provider refuses is refused and leaves nothing behind', async () => {
  const response = await client().setup({
    provider: 'anthropic',
    providerApiKey: REJECTED_KEY,
    runtime: 'docker',
    adminEmail: state.adminEmail,
    adminPassword: state.adminPassword,
    agentName: AGENT_NAME,
    agentInstructions: 'Answer briefly.',
  });
  expect(response.status, response.text).toBe(422);
  expect(/** @type {{ error: { code: string } }} */ (response.json).error.code).toBe(
    'provider_test_failed',
  );
  // A refusal signs no one in; the setup that follows is the first to.
  expect(client().cookie).toBeNull();
  const probes = (await fakeRequests()).filter((request) => request.path === '/v1/models');
  expect(probes.map((request) => request.apiKey)).toContain(REJECTED_KEY);
});

test('setup through the API with provider anthropic reaches the fake provider', async () => {
  const response = await client().setup({
    provider: 'anthropic',
    providerApiKey: PROVIDER_KEY,
    runtime: 'docker',
    adminEmail: state.adminEmail,
    adminPassword: state.adminPassword,
    agentName: AGENT_NAME,
    agentInstructions: 'Answer briefly.',
  });
  expect(response.status, response.text).toBe(201);
  const body = /** @type {{ agentId: string }} */ (response.json);
  expect(body.agentId).toMatch(/^[0-9a-f-]{36}$/u);
  state.agentId = body.agentId;
  expect(client().cookie).not.toBeNull();

  const probes = (await fakeRequests()).filter(
    (request) => request.path === '/v1/models' && request.apiKey !== REJECTED_KEY,
  );
  expect(probes.length).toBeGreaterThan(0);
  // The key typed into setup is the one the provider receives: stored, decrypted and sent upstream.
  expect(probes.every((request) => request.apiKey === PROVIDER_KEY)).toBe(true);

  // Issue #415: the refused attempt before this one left nothing, so there is exactly one
  // connection, it is ready, and the wizard's agent runs on it.
  const listed = await client().request('/api/model-connections');
  expect(listed.status, listed.text).toBe(200);
  const connections = /** @type {{ models: { id: string, name: string, ready: boolean }[] }} */ (
    listed.json
  ).models;
  expect(connections.map(({ name, ready }) => ({ name, ready }))).toEqual([
    { name: 'anthropic default', ready: true },
  ]);
  const agent = await client().request(`/api/agents/${state.agentId}`);
  expect(agent.status, agent.text).toBe(200);
  expect(/** @type {{ modelConnectionId: string }} */ (agent.json).modelConnectionId).toBe(
    connections[0]?.id,
  );
});

test('a run started through the API streams the fake provider’s reply to completed', async () => {
  const marker = nonce('api');
  const started = await client().request(`/api/agents/${state.agentId}/runs`, {
    method: 'POST',
    body: { prompt: `Reply with the marker ${marker}.` },
  });
  expect(started.status, started.text).toBe(202);
  const runId = /** @type {{ run: { id: string } }} */ (started.json).run.id;

  const frames = await client().runFrames(runId);
  expect(terminalStatus(frames), JSON.stringify(frames.slice(-5))).toBe('completed');
  expect(assistantText(frames)).toContain(expectedReply(marker));

  const stored = await client().request(`/api/runs/${runId}`);
  expect(stored.status).toBe(200);
  const run =
    /** @type {{ run: { status: string, error: unknown, usage: { outputTokens: number } } }} */ (
      stored.json
    ).run;
  expect(run.status).toBe('completed');
  expect(run.error).toBeNull();
  // The stored log replays the same reply once the run is over.
  expect(assistantText(await client().runFrames(runId))).toContain(expectedReply(marker));
  // The reply came through the gateway from the fake, streamed, carrying the setup key.
  const answered = (await fakeRequests()).filter(
    (request) => request.reply === expectedReply(marker),
  );
  expect(answered.length).toBeGreaterThan(0);
  expect(answered.every((request) => request.apiKey === PROVIDER_KEY)).toBe(true);
});

test('aw works with an ak_live_ API key: me, agents list and runs start --follow', async () => {
  const minted = await client().request('/api/api-keys', {
    method: 'POST',
    body: { name: 'generated-project-e2e', role: 'admin', expiresAt: null },
  });
  expect(minted.status, minted.text).toBe(201);
  state.apiKey = /** @type {{ key: string }} */ (minted.json).key;
  expect(state.apiKey).toMatch(/^ak_live_/u);

  const me = aw(['me']);
  expect(me).toMatch(/kind\s+api-key/u);
  expect(me).toMatch(/role\s+admin/u);

  const agents = aw(['agents', 'list']);
  expect(agents).toContain(state.agentId);
  expect(agents).toContain(AGENT_NAME);

  const marker = nonce('cli');
  // `--follow` exits 0 even when the run fails (packages/aw), so the transcript is what is checked.
  const followed = aw([
    'runs',
    'start',
    state.agentId,
    '--prompt',
    `Reply with the marker ${marker}.`,
    '--follow',
  ]);
  expect(followed).toContain(expectedReply(marker));
  expect(followed).toContain('run: completed');
  expect(followed).not.toContain('run failed');
});

/** Sign in through the real form with the password `create` printed. */
async function signIn(page) {
  await page.goto(`${state.baseUrl}/signin`);
  await page.getByLabel('Email').fill(state.adminEmail);
  await page.getByLabel('Password').fill(state.adminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/signin/u);
  await expect(
    page.getByRole('heading', { level: 1, name: 'What can I help with?' }),
  ).toBeVisible();
}

/**
 * The composer (apps/web/components/composer/home-chat.tsx) by the test ids #403 gave it, and the
 * run view's failure notice (apps/web/components/run/run-view.tsx).
 *
 * @param {import('@playwright/test').Page} page
 */
function composer(page) {
  return {
    input: page.getByTestId('composer-input'),
    send: page.getByTestId('composer-send'),
    picker: page.getByTestId('composer-agent-picker'),
    /** "Runs as <agent> on <model> (<connection>, <source>)." or "<agent> cannot run yet — …". */
    runTarget: page.getByTestId('composer-run-target'),
    failure: page.getByTestId('run-failure'),
  };
}

/**
 * Make `agentId` the composer's agent, through the picker when it is not already.
 *
 * @param {import('@playwright/test').Page} page @param {string} agentId
 */
async function chooseAgent(page, agentId) {
  const { picker, runTarget } = composer(page);
  await expect(runTarget).toBeVisible();
  if ((await runTarget.getAttribute('data-agent-id')) !== agentId) {
    await picker.locator('summary').click();
    await page.locator(`[data-testid="composer-agent-option"][data-agent-id="${agentId}"]`).click();
  }
  await expect(runTarget).toHaveAttribute('data-agent-id', agentId);
}

/**
 * Send one message and wait for the fake provider's reply to render. Before sending, the line under
 * the composer must say the message runs on a model (`expectedTarget`); after it, a failure notice
 * fails the step at once instead of waiting out the reply.
 *
 * @param {import('@playwright/test').Page} page @param {string} label
 * @param {RegExp} expectedTarget
 */
async function chat(page, label, expectedTarget) {
  const { input, send, runTarget, failure } = composer(page);
  await expect(runTarget).toHaveAttribute('data-run-target', 'runnable');
  await expect(runTarget).toHaveText(expectedTarget);
  console.log(`run target: ${(await runTarget.innerText()).trim()}`);

  const marker = nonce(label);
  await input.fill(`Reply with the marker ${marker}.`);
  await send.click();
  // The run view: one <main> whose transcript is the `aria-live` column and whose header carries
  // the run's status badge.
  const transcript = page.locator('[aria-live="polite"]');
  const runView = page.locator('main', { has: transcript });
  const reply = transcript.getByText(expectedReply(marker));
  await expect(reply.or(failure)).toBeVisible({ timeout: 180_000 });
  if (await failure.isVisible()) {
    throw new Error(
      `the run failed in the browser: ${String(await failure.getAttribute('data-failure-code'))}: ` +
        (await failure.innerText()),
    );
  }
  await expect(runView.getByText('Completed', { exact: true })).toBeVisible();
}

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

test('the browser chat with the agent the composer preselects answers', async ({ page }) => {
  await signIn(page);
  // What a new user does first: type into the composer as it opens and press Send. #403 makes the
  // composer preselect an agent that can run, and say on which model before anything is sent.
  const { picker } = composer(page);
  await expect(picker).toBeVisible();
  const preselected = /^Agent: (.+?)\s*▾?$/u.exec(
    (await picker.locator('summary').innerText()).trim(),
  )?.[1];
  expect(preselected).toBeDefined();
  console.log(`preselected: ${String(preselected)}`);
  await chat(
    page,
    'preselected',
    new RegExp(`^Runs as ${escapeRegExp(preselected ?? '')} on \\S.* \\(.+\\)\\.$`, 'u'),
  );
});

test('the browser chat with the wizard’s agent answers', async ({ page }) => {
  await signIn(page);
  await chooseAgent(page, state.agentId);
  // Setup seeds the wizard's agent with this exact model (apps/web/server/composition/setup.ts).
  await chat(
    page,
    'browser',
    new RegExp(`^Runs as ${escapeRegExp(AGENT_NAME)} on claude-sonnet-4-5 \\(.+\\)\\.$`, 'u'),
  );
});

test('the browser shows a refused start for an agent with no runtime profile, and keeps no session', async ({
  page,
}) => {
  // An agent created through the API with no runtime profile: #403's preflight refuses its runs
  // with 422 `agent_runtime_profile_missing` before anything is stored.
  const created = await client().request('/api/agents', {
    method: 'POST',
    body: {
      name: REFUSED_AGENT_NAME,
      instructions: 'Answer briefly.',
      modelConnectionId: null,
      model: null,
      runtimeProfileId: null,
      permissions: {
        readFiles: false,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    },
  });
  expect(created.status, created.text).toBe(201);
  const agentId = /** @type {{ id: string }} */ (created.json).id;

  await signIn(page);
  await chooseAgent(page, agentId);
  const { input, send, runTarget, failure } = composer(page);
  // The composer says so before anything is sent...
  await expect(runTarget).toHaveAttribute('data-run-target', 'unrunnable');
  await expect(runTarget).toContainText(`${REFUSED_AGENT_NAME} cannot run yet`);
  // ...and when it is sent anyway, the conversation names the refusal.
  await input.fill('Reply with anything.');
  await send.click();
  await expect(failure).toBeVisible();
  await expect(failure).toHaveAttribute('data-failure-code', 'agent_runtime_profile_missing');

  // A refused start stores nothing: no session and no run of that agent.
  const sessions = await client().request('/api/sessions');
  expect(sessions.status, sessions.text).toBe(200);
  const listed = /** @type {{ sessions: { agentId: string }[] }} */ (sessions.json).sessions;
  expect(listed.filter((session) => session.agentId === agentId)).toEqual([]);
  const runs = await client().request(`/api/runs?agent=${agentId}`);
  expect(runs.status, runs.text).toBe(200);
  expect(/** @type {{ runs: unknown[] }} */ (runs.json).runs).toEqual([]);
});

test('a deployment installing chat, files and runs answers 404 feature_disabled on /api/skills', async () => {
  // ADR-0160 D5 (#1495): `aw deploy` writes the project file's `features:` into `.env` as this
  // line, and the Compose template forwards it to web. `create --cloud local` (the Compose flow
  // this file runs) refuses `--features`, which belongs to the v2 project, so the line is written
  // here as `aw deploy` writes it. Web is recreated with it; nothing else is.
  // shortcut: this test plants the `.env` line, so neither `npm create … --features` nor `aw
  // deploy`'s rendering of it (unit-tested in packages/cli/src/deploy/project.test.ts) is on this
  // path; upgrade when the Compose create flow accepts `--features`.
  test.setTimeout(5 * 60_000);
  const envFile = path.join(PROJECT, '.env');
  const contents = readFileSync(envFile, 'utf8');
  expect(contents).not.toMatch(/^AW_DEPLOYMENT_FEATURES=/mu);
  writeFileSync(envFile, `${contents.trimEnd()}\nAW_DEPLOYMENT_FEATURES=chat,files,runs\n`);
  run('docker', ['compose', 'up', '--detach', '--wait', '--no-deps', 'web'], {
    cwd: PROJECT,
    timeoutMs: 240_000,
  });

  const skills = await client().request('/api/skills');
  expect(skills.status, skills.text).toBe(404);
  expect(/** @type {{ error: { code: string } }} */ (skills.json).error.code).toBe(
    'feature_disabled',
  );
  // A feature the line lists still answers: the gate refuses only what is not installed.
  const runs = await client().request(`/api/runs?agent=${state.agentId}`);
  expect(runs.status, runs.text).toBe(200);
});

test('the console of a deployment installing chat, files and runs shows only their entries', async ({
  page,
}) => {
  // ADR-0160 D8 (#1497): the sidebar hides what the deployment does not install, as the previous
  // test's `AW_DEPLOYMENT_FEATURES=chat,files,runs` leaves web running.
  await signIn(page);
  const sidebar = page.locator('aside');
  for (const label of ['New chat', 'Agents', 'Files', 'Runs', 'Models', 'Users', 'Settings']) {
    await expect(sidebar.getByRole('link', { name: label, exact: true })).toBeVisible();
  }
  for (const label of ['Projects', 'Skills', 'Connectors', 'Shared links']) {
    await expect(sidebar.getByRole('link', { name: label, exact: true })).toHaveCount(0);
  }
  // A deep link to a feature the deployment does not install explains instead of a bare 404, and
  // names the operator: no Owner can switch on what the deployment does not install.
  await page.goto(`${state.baseUrl}/skills`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Skills is not installed in this deployment.',
  );
  await expect(page.getByRole('link', { name: 'Settings → Features' })).toHaveCount(0);
});

test('pnpm stop leaves no container, sandbox or network of the project behind', () => {
  // The runs above started runtime sandboxes, which carry no Compose label: `agent-workspace stop`
  // (#394, #406) reaps them with the services, which `docker compose down` alone did not.
  const before = projectLeftovers(state.projectName);
  const sandboxes = before.containers.filter(
    (container) => container.labels['agent-workspace.runtime'] === 'docker',
  );
  console.log(`before stop: ${String(sandboxes.length)} runtime sandbox(es)`);

  // `run` throws on a non-zero exit, and `stop` exits non-zero naming whatever it left.
  const stopped = run('pnpm', ['stop'], { cwd: PROJECT, timeoutMs: 180_000 });
  console.log(stopped.trim());
  expect(stopped).toContain(`${state.projectName} is stopped.`);
  // Unreachable while `stop` exits non-zero on leftovers (`run` would have thrown); it guards
  // against a future `stop` that reports leftovers and still exits 0.
  expect(stopped).not.toContain('is not fully stopped');

  // And the host agrees: nothing of the project is left, whatever `stop` reported.
  const after = projectLeftovers(state.projectName);
  expect(
    { containers: after.containers.map((container) => container.name), networks: after.networks },
    'teardown leftovers',
  ).toEqual({ containers: [], networks: [] });
});
