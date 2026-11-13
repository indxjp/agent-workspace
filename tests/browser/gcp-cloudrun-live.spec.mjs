/* global process, URL, fetch, AbortSignal */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { run } from '../generated-project/project.mjs';
import { assistantText, parseSseFrames, terminalStatus } from '../generated-project/stack-api.mjs';

const requiredEnvironment = [
  'GCP_LIVE_BASE_URL',
  'GCP_LIVE_BOOTSTRAP_EMAIL',
  'GCP_LIVE_BOOTSTRAP_PASSWORD',
  'GCP_LIVE_PROJECT',
];
const missingEnvironment = requiredEnvironment.filter((name) => !process.env[name]?.trim());
// Claude on Vertex AI; `AW_LIVE_MODEL` overrides the cheapest current model.
const MODEL = process.env['AW_LIVE_MODEL']?.trim() || 'claude-haiku-5-5';
// A turn starts a Cloud Run sandbox (a cold microVM) and calls the real model.
const RUN_TIMEOUT = 240_000;
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../..');

// The code tool of the product-path test: no secret, no network, a deterministic answer.
const TOOL_NAME = 'echoLiveNote';
const ENDPOINT_CLIENT = 'gcp-live-tools';
const agentSource = (name) => `import { defineAgent } from '@indx-workspace/sdk/define';
import echoLiveNote from '../tools/echo-live-note.ts';

export default defineAgent({
  name: '${name}',
  instructions: 'Echo the note the person names with the tool.',
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
async function signInAsOwner(page, baseUrl) {
  await page.goto('/signin', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { level: 1, name: 'Agent Workspace' })).toBeVisible();
  await page.getByLabel('Email').fill(process.env['GCP_LIVE_BOOTSTRAP_EMAIL']);
  await page.getByLabel('Password').fill(process.env['GCP_LIVE_BOOTSTRAP_PASSWORD']);
  await Promise.all([
    page.waitForURL((url) => url.origin === baseUrl.origin && url.pathname === '/'),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ]);
}

test.describe('Google Cloud Run live deployment', () => {
  test.skip(
    missingEnvironment.length > 0,
    `requires explicit live environment configuration (${requiredEnvironment.join(', ')})`,
  );

  test('calls a code tool through the project tool endpoint', async ({ page }) => {
    // Model-free: web -> runner manager -> rt-tool- sandbox, and the gateway's endpoint route -> the
    // tool sandbox with the gateway's ID token. A 503 here is tool_sandbox_unavailable or
    // tool_endpoint_unavailable and fails the test.
    test.setTimeout(2 * RUN_TIMEOUT);
    const baseUrl = new URL(process.env['GCP_LIVE_BASE_URL']);
    await signInAsOwner(page, baseUrl);

    const minted = await page.request.fetch(`${baseUrl.origin}/api/api-keys`, {
      method: 'POST',
      data: { name: 'gcp-live-tool-test', role: 'admin', expiresAt: null },
      headers: { origin: baseUrl.origin },
    });
    expect(minted.status(), 'an API key was minted').toBe(201);
    const apiKey = (await minted.json()).key;
    expect(apiKey.startsWith('ak_live_')).toBe(true);

    const project = mkdtempSync(path.join(tmpdir(), 'gcp-live-tool-'));
    try {
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
      // The endpoint key acts for the Owner with the builder role, which runs only the agents the
      // Owner owns or was granted. An agent `aw push` creates with the admin key is the key's own,
      // so the endpoint would drop it and list no tool: the Owner creates the agent, and the push
      // writes its version. A fresh name per attempt, so a retry never finds the key's agent.
      const agentName = `live-tools-${Date.now().toString(36)}`;
      const asOwner = async (method, route, data) => {
        const response = await page.request.fetch(`${baseUrl.origin}${route}`, {
          method,
          ...(data === undefined ? {} : { data }),
          headers: { origin: baseUrl.origin },
        });
        const text = await response.text();
        return { status: response.status(), text };
      };
      const owned = await asOwner('POST', '/api/agents', {
        name: agentName,
        instructions: 'Echo the note the person names with the tool.',
        modelConnectionId: null,
        model: null,
        permissions: {
          readFiles: false,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        },
      });
      expect(owned.status, `the Owner created the agent: ${owned.text}`).toBe(201);
      const ownedId = JSON.parse(owned.text).id;
      writeFileSync(path.join(project, 'agents/assistant.ts'), agentSource(agentName));
      writeFileSync(path.join(project, 'tools/echo-live-note.ts'), TOOL_DECLARATION);
      writeFileSync(path.join(project, 'tools/echo-live-note.run.ts'), TOOL_RUN_FILE);

      const aw = (...args) =>
        run('aw', args, {
          cwd: project,
          env: {
            ...process.env,
            AGENT_WORKSPACE_URL: baseUrl.origin,
            AGENT_WORKSPACE_API_KEY: apiKey,
          },
          timeoutMs: 180_000,
        });
      aw('push', '--yes');
      const local = JSON.parse(aw('versions', '--json')).pointers.find(
        (pointer) => pointer.environment === 'local',
      );
      expect(local, 'aw push moved local to the new version').toBeDefined();
      aw('promote', agentName, String(local.number), '--yes');
      // An endpoint client acts for the member who creates it, so an API key may not create one
      // (api_key_not_permitted): the Owner's session creates it and mints its key, as in the UI.
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
      const endpointKey = JSON.parse(endpointMint.text).key;

      const call = async (id, method, params) => {
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
      const listed = await call(1, 'tools/list');
      expect(listed.result.tools.map((tool) => tool.name)).toContain(TOOL_NAME);
      const note = `gcp-${Date.now()}`;
      const called = await call(2, 'tools/call', { name: TOOL_NAME, arguments: { note } });
      expect(called.result.isError ?? false, JSON.stringify(called)).toBe(false);
      expect(JSON.stringify(called.result.content)).toContain(`live-tool-${note}`);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('signs in as the Owner, uses the seeded Vertex AI model, creates an agent and gets an answer', async ({
    page,
  }) => {
    // Two cold sandboxes: Test Runtime, then the run itself.
    test.setTimeout(2 * RUN_TIMEOUT + 120_000);
    const baseUrl = new URL(process.env['GCP_LIVE_BASE_URL']);
    expect(baseUrl.protocol).toBe('https:');
    expect(baseUrl.username).toBe('');
    expect(baseUrl.password).toBe('');

    const pageProblems = [];
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
    const serverErrors = [];
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.origin === baseUrl.origin && response.status() >= 500) {
        serverErrors.push(`same-origin HTTP ${response.status()}: ${url.pathname}`);
      }
    });

    await signInAsOwner(page, baseUrl);
    await expect(
      page.getByRole('heading', { level: 1, name: 'What can I help with?' }),
    ).toBeVisible();

    // Same-origin API calls carry the session cookie; a write also needs the Origin header.
    const send = async (method, path, data) => {
      const response = await page.request.fetch(`${baseUrl.origin}${path}`, {
        method,
        data,
        headers: { origin: baseUrl.origin },
        timeout: RUN_TIMEOUT,
      });
      const text = await response.text();
      if (response.status() >= 500) serverErrors.push(`HTTP ${response.status()}: ${path}`);
      expect(response.ok(), `${method} ${path} answered ${response.status()}: ${text}`).toBe(true);
      return text;
    };
    const sendJson = async (method, path, data) => JSON.parse(await send(method, path, data));

    // The deploy seeded a keyless Vertex AI connection through `POST /api/setup`. No model key is
    // created or stored anywhere in this journey.
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

    const agent = await sendJson('POST', '/api/agents', {
      name: `gcp live ${Date.now()}`,
      instructions: 'Answer in one short sentence.',
      modelConnectionId: connection.id,
      model: MODEL,
      runtimeProfileId: profile.id,
      permissions: {
        readFiles: false,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    });

    const started = await sendJson('POST', `/api/agents/${agent.id}/runs`, {
      prompt: 'Reply with the single word: ready.',
    });
    const runId = started.run.id;
    const frames = parseSseFrames(await send('GET', `/api/runs/${runId}/events`));
    expect(terminalStatus(frames), JSON.stringify(frames.slice(-3))).toBe('completed');
    expect(assistantText(frames).trim()).not.toBe('');

    expect(serverErrors).toEqual([]);
    expect(pageProblems).toEqual([]);
  });
});
