/* global process, URL */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { assistantText, parseSseFrames, terminalStatus } from '../generated-project/stack-api.mjs';
import {
  RUN_TIMEOUT,
  TOOL_NAME,
  createJourneyAgent,
  createOwnedAgent,
  endpointCaller,
  mintAdminApiKey,
  mintEndpointKey,
  missingEnvironment,
  ownerApi,
  ownerRequests,
  pushAndPromote,
  requireVertexConnection,
  requiredEnvironment,
  scaffoldToolProject,
  signInAsOwner,
  verifiedRuntimeProfile,
  watchPageProblems,
} from './gcp-cloudrun-live-support.mjs';

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
    const apiKey = await mintAdminApiKey(page, baseUrl);

    const project = mkdtempSync(path.join(tmpdir(), 'gcp-live-tool-'));
    try {
      // The endpoint key acts for the Owner with the builder role, which runs only the agents the
      // Owner owns or was granted. An agent `aw push` creates with the admin key is the key's own,
      // so the endpoint would drop it and list no tool: the Owner creates the agent, and the push
      // writes its version. A fresh name per attempt, so a retry never finds the key's agent.
      const agentName = `live-tools-${Date.now().toString(36)}`;
      const asOwner = ownerRequests(page, baseUrl);
      const ownedId = await createOwnedAgent(asOwner, agentName);
      scaffoldToolProject(project, agentName);
      pushAndPromote({ project, baseUrl, apiKey, agentName });
      // An endpoint client acts for the member who creates it, so an API key may not create one
      // (api_key_not_permitted): the Owner's session creates it and mints its key, as in the UI.
      const endpointKey = await mintEndpointKey(asOwner, agentName, ownedId);

      const call = endpointCaller(baseUrl, endpointKey);
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

    const { pageProblems, serverErrors } = watchPageProblems(page, baseUrl);
    await signInAsOwner(page, baseUrl);
    await expect(
      page.getByRole('heading', { level: 1, name: 'What can I help with?' }),
    ).toBeVisible();

    const { send, sendJson } = ownerApi(page, baseUrl, serverErrors);
    // The deploy seeded a keyless Vertex AI connection through `POST /api/setup`. No model key is
    // created or stored anywhere in this journey.
    const connection = await requireVertexConnection(sendJson);
    const profile = await verifiedRuntimeProfile(sendJson);
    const agent = await createJourneyAgent(sendJson, connection, profile);

    const started = await sendJson('POST', `/api/agents/${agent.id}/runs`, {
      prompt: 'Reply with the single word: ready.',
    });
    const frames = parseSseFrames(await send('GET', `/api/runs/${started.run.id}/events`));
    expect(terminalStatus(frames), JSON.stringify(frames.slice(-3))).toBe('completed');
    expect(assistantText(frames).trim()).not.toBe('');

    expect(serverErrors).toEqual([]);
    expect(pageProblems).toEqual([]);
  });
});
