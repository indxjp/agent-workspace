/* global process, URL */

import { expect, test } from '@playwright/test';

import { bootstrapAdminCredentials, signInAsBootstrapAdmin } from './harness.mjs';

// The run stack (runner, gateway, scripted upstream, database) is started once by
// `playwright.config.ts`; the script is `tests/builder/scripted/browser/expense-refunds-happy.json`.
// The journey changes that stack's state, so it runs once per stack start.
// Its own web server (`playwright.config.ts`), never port 3000.
const builderPort = process.env['E2E_PORT_BUILDER'] ?? '3212';
if (!/^\d{1,5}$/u.test(builderPort)) {
  throw new Error(`E2E_PORT_BUILDER must be a port number, got ${builderPort}`);
}
test.use({ baseURL: `http://127.0.0.1:${builderPort}` });

const credentials = bootstrapAdminCredentials();
// A turn starts a real runner process and the Claude CLI, so it waits longer than a page does.
const RUN_TIMEOUT = 90_000;

// The web server provisions the Builder at start-up (#2012). The spec adds what a set-up workspace
// has and the seed does not: the `default` model connection (pointed at the scripted upstream), the
// default runtime profile and the `crm` connector the script swaps in for the missing `erp`.
async function prepareWorkspace(page, base) {
  const upstream = `http://127.0.0.1:${process.env['E2E_PORT_UPSTREAM']}`;
  const send = async (method, url, data) => {
    const response = await page.request.fetch(`${base}${url}`, {
      method,
      data,
      headers: { origin: base },
    });
    expect(response.ok(), `${method} ${url}: ${await response.text()}`).toBe(true);
    return response.json();
  };
  const builder = async () => {
    const { agents } = await send('GET', '/api/agents');
    return agents.find((agent) => agent.builtin === 'builder') ?? null;
  };
  // Start-up provisioning may still be running when the first test signs in.
  await expect
    .poll(builder, { message: 'the web server provisioned no Builder', timeout: 30_000 })
    .not.toBeNull();

  // Product path: first-run setup (`POST /api/setup`) and the `default` connection (#2020).
  // Setup takes only an https base URL, so it keeps the endpoint of a connection made first.
  const upstreamConnection = (name) => ({
    name,
    provider: 'anthropic',
    apiKey: 'sk-ant-browser-placeholder',
    config: { baseUrl: upstream },
  });
  await send('POST', '/api/model-connections', upstreamConnection('anthropic default'));
  const setup = await send('POST', '/api/setup', {
    provider: 'anthropic',
    providerApiKey: 'sk-ant-browser-placeholder',
    runtime: 'local',
    adminEmail: credentials.email,
    adminPassword: credentials.password,
    agentName: 'Browser setup',
    agentInstructions: 'Answer briefly.',
  });
  const connection = await send('POST', '/api/model-connections', upstreamConnection('default'));
  expect(await builder()).toMatchObject({
    modelConnectionId: connection.id,
    runtimeProfileId: setup.runtimeProfileId,
  });
  await send('POST', '/api/connectors', {
    name: 'crm',
    transport: 'http',
    url: `${upstream}/mcp`,
  });
}

test.describe('the Builder chat journey', () => {
  // One-shot against its own stack: a retry would fail at provisioning and hide the first error.
  test.describe.configure({ retries: 0 });

  test('[US-BLD-01][browser][web] [US-BLD-03][browser][web] [US-BLD-05][browser][web] a chat creates an agent, version 1, with the Builder as its source', async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(240_000);
    expect(credentials, 'BOOTSTRAP_ADMIN and BOOTSTRAP_ADMIN_PASSWORD are required').not.toBeNull();
    await signInAsBootstrapAdmin(page, credentials);
    await prepareWorkspace(page, baseURL);

    await page.goto('/agents/new?mode=chat');
    await page.getByLabel('Ask anything').fill('I want an agent that helps with expense refunds');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(
      page.getByRole('alert').filter({ hasText: 'agent_definition_references_missing' }),
    ).toContainText('connector:erp', { timeout: RUN_TIMEOUT });

    await page.getByLabel('Ask a follow-up').fill('yes');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.locator('[data-section="resources"][data-changed="true"]')).toContainText(
      'changed',
      { timeout: RUN_TIMEOUT },
    );
    const approval = page.getByRole('region', { name: 'The Builder is waiting for your decision' });
    // The diff names the connector the script swapped in, not just any change.
    await expect(
      approval.getByRole('row').filter({ hasText: 'resources' }).filter({ hasText: 'crm' }),
    ).toBeVisible({ timeout: RUN_TIMEOUT });
    await approval.getByRole('button', { name: 'Approve' }).click();

    const saved = page.getByRole('status').filter({ hasText: 'Saved as version 1 on local' });
    await expect(saved).toBeVisible({ timeout: RUN_TIMEOUT });
    await saved.getByRole('link', { name: 'View history' }).click();

    await expect(page).toHaveURL(/\/agents\/[^/?]+\?tab=versions/u);
    const agentId = decodeURIComponent(new URL(page.url()).pathname.split('/')[2]);
    const row = page.locator('table[aria-label="Versions of this agent"] tr[data-version="1"]');
    await expect(row).toContainText('Builder');

    // The creation of the agent the chat saved, never the Builder's own: the signed-in person is
    // its actor, and the Builder run is named beside them.
    const audit = await page.request.get(`${baseURL}/api/audit-events?action=agent-created`);
    expect(audit.ok()).toBe(true);
    const { events } = await audit.json();
    const created = events.filter((event) => event.subjectId === agentId);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      action: 'agent-created',
      actorLabel: credentials.email,
      subjectLabel: 'Expense refunds',
      builderRunId: expect.any(String),
    });
  });
});
