/* global process, URL, fetch, AbortSignal */

import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect } from '@playwright/test';

import { run } from '../generated-project/project.mjs';

export const requiredEnvironment = [
  'GCP_LIVE_BASE_URL',
  'GCP_LIVE_BOOTSTRAP_EMAIL',
  'GCP_LIVE_BOOTSTRAP_PASSWORD',
  'GCP_LIVE_PROJECT',
];
export const missingEnvironment = requiredEnvironment.filter((name) => !process.env[name]?.trim());
// Claude on Vertex AI; `AW_LIVE_MODEL` overrides the cheapest current model.
const MODEL = process.env['AW_LIVE_MODEL']?.trim() || 'claude-haiku-5-5';
// A turn starts a Cloud Run sandbox (a cold microVM) and calls the real model.
export const RUN_TIMEOUT = 240_000;
export const TOOL_NAME = 'echoLiveNote';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../..');
const ENDPOINT_CLIENT = 'gcp-live-tools';
const AW_TIMEOUT = 180_000;
const NO_PERMISSIONS = {
  readFiles: false,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};
const TOOL_INSTRUCTIONS = 'Echo the note the person names with the tool.';

const agentSource = (name) => `import { defineAgent } from '@indx-workspace/sdk/define';
import echoLiveNote from '../tools/echo-live-note.ts';

export default defineAgent({
  name: '${name}',
  instructions: '${TOOL_INSTRUCTIONS}',
  model: 'default',
  tools: [echoLiveNote],
});
`;
const TOOL_DECLARATION = `import { defineTool, z } from '@indx-workspace/sdk/define';

export default defineTool({
  name: '${TOOL_NAME}',
  description: 'Echo a note',
  input: z.object({ note: z.string() }),
  run: './tools/echo-live-note.run.ts',
});
`;
const TOOL_RUN_FILE = `import type { ToolRun } from '@indx-workspace/sdk/define';
import type echoLiveNote from './echo-live-note.ts';

const run: ToolRun<typeof echoLiveNote> = async ({ note }) => ({ echoed: \`live-tool-\${note}\` });
export default run;
`;

/** Sign in as the bootstrap Owner through the form and wait for the home page. */
export async function signInAsOwner(page, baseUrl) {
  await page.goto('/signin', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { level: 1, name: 'Agent Workspace' })).toBeVisible();
  await page.getByLabel('Email').fill(process.env['GCP_LIVE_BOOTSTRAP_EMAIL']);
  await page.getByLabel('Password').fill(process.env['GCP_LIVE_BOOTSTRAP_PASSWORD']);
  await Promise.all([
    page.waitForURL((url) => url.origin === baseUrl.origin && url.pathname === '/'),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
}

/** Mint an admin API key through the signed-in Owner session. */
export async function mintAdminApiKey(page, baseUrl) {
  const minted = await page.request.fetch(`${baseUrl.origin}/api/api-keys`, {
    method: 'POST',
    data: { name: 'gcp-live-tool-test', role: 'admin', expiresAt: null },
    headers: { origin: baseUrl.origin },
  });
  expect(minted.status(), 'an API key was minted').toBe(201);
  const apiKey = (await minted.json()).key;
  expect(apiKey.startsWith('ak_live_')).toBe(true);
  return apiKey;
}

/** A request helper acting as the signed-in Owner; it returns the status and body text. */
export function ownerRequests(page, baseUrl) {
  return async (method, route, data) => {
    const response = await page.request.fetch(`${baseUrl.origin}${route}`, {
      method,
      ...(data === undefined ? {} : { data }),
      headers: { origin: baseUrl.origin },
    });
    const text = await response.text();
    return { status: response.status(), text };
  };
}

/** Write a project that declares the agent and its code tool, linking the repository SDK. */
export function scaffoldToolProject(project, agentName) {
  mkdirSync(path.join(project, 'agents'));
  mkdirSync(path.join(project, 'tools'));
  mkdirSync(path.join(project, 'node_modules/@indx-workspace'), { recursive: true });
  for (const name of ['sdk', 'contracts']) {
    symlinkSync(
      path.join(REPOSITORY_ROOT, 'packages', name),
      path.join(project, 'node_modules/@indx-workspace', name),
    );
  }
  writeFileSync(
    path.join(project, 'package.json'),
    '{ "name": "gcp-live-tool", "type": "module" }\n',
  );
  writeFileSync(path.join(project, 'agents/assistant.ts'), agentSource(agentName));
  writeFileSync(path.join(project, 'tools/echo-live-note.ts'), TOOL_DECLARATION);
  writeFileSync(path.join(project, 'tools/echo-live-note.run.ts'), TOOL_RUN_FILE);
}

/** The Owner creates the agent (an admin key's own agent would be dropped by the endpoint). */
export async function createOwnedAgent(asOwner, agentName) {
  const owned = await asOwner('POST', '/api/agents', {
    name: agentName,
    instructions: TOOL_INSTRUCTIONS,
    modelConnectionId: null,
    model: null,
    permissions: NO_PERMISSIONS,
  });
  expect(owned.status, `the Owner created the agent: ${owned.text}`).toBe(201);
  return JSON.parse(owned.text).id;
}

/** Push the project with the admin key and promote the new local version. */
export function pushAndPromote({ project, baseUrl, apiKey, agentName }) {
  const aw = (...args) =>
    run('aw', args, {
      cwd: project,
      env: {
        ...process.env,
        AGENT_WORKSPACE_URL: baseUrl.origin,
        AGENT_WORKSPACE_API_KEY: apiKey,
      },
      timeoutMs: AW_TIMEOUT,
    });
  aw('push', '--yes');
  const local = JSON.parse(aw('versions', '--json')).pointers.find(
    (pointer) => pointer.environment === 'local',
  );
  expect(local, 'aw push moved local to the new version').toBeDefined();
  aw('promote', agentName, String(local.number), '--yes');
}

/** Create the endpoint client for the agent and mint its key as the Owner, as in the UI. */
export async function mintEndpointKey(asOwner, agentName, ownedId) {
  const agents = await asOwner('GET', '/api/agents');
  expect(agents.status, `GET /api/agents answered ${agents.status}: ${agents.text}`).toBe(200);
  const agent = JSON.parse(agents.text).agents.find((entry) => entry.name === agentName);
  expect(agent?.id, 'aw push wrote a version of the agent the Owner created').toBe(ownedId);
  const created = await asOwner('POST', '/api/endpoint-clients', {
    name: ENDPOINT_CLIENT,
    kind: 'mcp-project',
    agentIds: [agent.id],
  });
  expect(created.status, `the endpoint client was created: ${created.text}`).toBe(201);
  const client = JSON.parse(created.text).endpointClient;
  const endpointMint = await asOwner(
    'POST',
    `/api/endpoint-clients/${encodeURIComponent(client.id)}/keys`,
    { name: 'gcp-live-tool-key' },
  );
  // The answer carries the key: only its status goes into a message.
  expect(endpointMint.status, 'an endpoint key was minted').toBe(201);
  return JSON.parse(endpointMint.text).key;
}

/** A JSON-RPC caller for the project tool endpoint; a 503 fails the test. */
export function endpointCaller(baseUrl, endpointKey) {
  return async (id, method, params) => {
    const response = await fetch(`${baseUrl.origin}/mcp/projects/${ENDPOINT_CLIENT}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${endpointKey}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(RUN_TIMEOUT),
    });
    const text = await response.text();
    expect(response.status, `${method} answered ${response.status}: ${text}`).not.toBe(503);
    expect(response.status, `${method} answered ${response.status}: ${text}`).toBe(200);
    return JSON.parse(text);
  };
}

/** Collect page errors, failed same-origin requests and same-origin 5xx responses. */
export function watchPageProblems(page, baseUrl) {
  const pageProblems = [];
  const serverErrors = [];
  page.on('pageerror', (error) => pageProblems.push(`page error: ${error.message}`));
  page.on('requestfailed', (request) => {
    // Navigation and Next.js prefetch cancellation are normal browser control flow.
    if (request.failure()?.errorText.includes('ERR_ABORTED')) return;
    if (new URL(request.url()).origin === baseUrl.origin) {
      pageProblems.push(
        `same-origin request failed: ${request.method()} ${new URL(request.url()).pathname}`,
      );
    }
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin === baseUrl.origin && response.status() >= 500) {
      serverErrors.push(`same-origin HTTP ${response.status()}: ${url.pathname}`);
    }
  });
  return { pageProblems, serverErrors };
}

/** Same-origin API calls carrying the session cookie; a write also needs the Origin header. */
export function ownerApi(page, baseUrl, serverErrors) {
  const send = async (method, route, data) => {
    const response = await page.request.fetch(`${baseUrl.origin}${route}`, {
      method,
      data,
      headers: { origin: baseUrl.origin },
      timeout: RUN_TIMEOUT,
    });
    const text = await response.text();
    if (response.status() >= 500) serverErrors.push(`HTTP ${response.status()}: ${route}`);
    expect(response.ok(), `${method} ${route} answered ${response.status()}: ${text}`).toBe(true);
    return text;
  };
  const sendJson = async (method, route, data) => JSON.parse(await send(method, route, data));
  return { send, sendJson };
}

/** The seeded keyless Vertex AI connection, checked and confirmed to offer the model. */
export async function requireVertexConnection(sendJson) {
  const { models: connections } = await sendJson('GET', '/api/model-connections');
  const vertex = connections.filter((entry) => entry.provider === 'vertex');
  expect(vertex.length, 'the deploy seeded one vertex connection').toBe(1);
  const connection = vertex[0];
  expect(connection.hasCredential, 'the connection stores no credential').toBe(false);
  expect(connection.ready, 'the keyless connection is ready').toBe(true);
  expect(connection.config.location).toBe('global');
  expect(connection.config.projectId).toBe(process.env['GCP_LIVE_PROJECT']);
  // A run is refused with `model_unavailable` unless its model is in the connection's discovered
  // list (apps/web/server/compose/run-request-model-resolution.ts).
  const discovered = await sendJson('GET', '/api/models');
  const unavailable = (discovered.unavailable ?? []).filter(
    (entry) => entry.connectionId === connection.id,
  );
  expect(unavailable, 'the Vertex connection lists its models').toEqual([]);
  const offered = discovered.models
    .filter((entry) => entry.connectionId === connection.id)
    .map((entry) => entry.providerModelId);
  expect(offered, `model "${MODEL}" is offered by the connection`).toContain(MODEL);
  return connection;
}

/** The first runtime profile (or a new one), with a current Test Runtime pass for its driver. */
export async function verifiedRuntimeProfile(sendJson) {
  const { runtimeProfiles } = await sendJson('GET', '/api/runtime-profiles');
  const profile =
    runtimeProfiles[0] ??
    (await sendJson('POST', '/api/runtime-profiles', {
      name: 'cloud-run live',
      driver: 'cloud-run-service',
      networkPolicy: 'none',
      filesystem: 'read-write',
    }));
  // A run needs a current Test Runtime pass for the profile's driver (it lasts 24 hours); a fresh
  // install has none, so the first run would be refused with runtime_not_verified.
  const echo = 'agent-workspace runtime test';
  const tested = await sendJson('POST', '/api/runtimes/test', { driver: profile.driver, echo });
  expect(tested.driverId).toBe(profile.driver);
  expect(tested.transcript.join('\n')).toContain(echo);
  expect(tested.destroyed, 'Test Runtime removes its sandbox').toBe(true);
  return profile;
}

/** Create the journey's agent on the Vertex connection and runtime profile. */
export function createJourneyAgent(sendJson, connection, profile) {
  return sendJson('POST', '/api/agents', {
    name: `gcp live ${Date.now()}`,
    instructions: 'Answer in one short sentence.',
    modelConnectionId: connection.id,
    model: MODEL,
    runtimeProfileId: profile.id,
    permissions: NO_PERMISSIONS,
  });
}
