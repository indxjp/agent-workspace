/* global process, URL */

import { expect, test } from '@playwright/test';

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

test.describe('Google Cloud Run live deployment', () => {
  test.skip(
    missingEnvironment.length > 0,
    `requires explicit live environment configuration (${requiredEnvironment.join(', ')})`,
  );

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

    await page.goto('/signin', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { level: 1, name: 'Agent Workspace' })).toBeVisible();
    await page.getByLabel('Email').fill(process.env['GCP_LIVE_BOOTSTRAP_EMAIL']);
    await page.getByLabel('Password').fill(process.env['GCP_LIVE_BOOTSTRAP_PASSWORD']);
    await Promise.all([
      page.waitForURL((url) => url.origin === baseUrl.origin && url.pathname === '/'),
      page.getByRole('button', { name: 'Sign in' }).click(),
    ]);
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
