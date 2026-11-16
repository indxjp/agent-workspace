/**
 * `PUT /api/demo/verification/{workspaceId}` through the application context a deployment installs:
 * nothing without the operator token, `401` for a wrong one, typed problems for an id that is not
 * one, a workspace that does not exist or may not be filled, and the entries copied otherwise.
 */
import crypto from 'node:crypto';

import { DemoVerificationFillSchema } from '@indx-workspace/contracts/demo-operator';
import { afterEach, describe, expect, it } from 'vitest';

import { clearApplicationContext } from '../../../../server/application-context';
import { installTestDomains } from '../../../../server/application-context-fixtures';
import { NO_DEMO_OPERATOR } from '../../../../server/demo/operator';
import { createMemoryTemplatesWorld } from '../../../../server/demo/provision/templates.world.test-support';
import { createDemoVerification } from '../../../../server/demo/provision/verification';
import { PUT } from './[workspaceId]/route';

const TOKEN = 'operator-token-'.padEnd(40, 'x');
const URL_BASE = 'https://platform.example.test/api/demo/verification';
const authorised = { authorization: `Bearer ${TOKEN}` };

afterEach(() => {
  clearApplicationContext();
});

async function install(token: string | null) {
  const world = createMemoryTemplatesWorld();
  const entry = world.entry('wiki');
  await world.seedTemplate(entry, {
    agent: { name: 'writer', instructions: 'Use the pages.', maxTurns: 8, maxBudgetUsd: 0.3 },
    files: [{ path: 'pages/home.md', text: '# Home' }],
    assign: [{ path: 'pages', access: 'read' }],
  });
  const verification = createDemoVerification({
    templates: world.templates,
    templateEntries: () => Promise.resolve([entry]),
    directory: world.directory,
    limits: { maxTurns: 5, maxBudgetUsd: 0.2 },
  });
  installTestDomains({ demoOperator: { ...NO_DEMO_OPERATOR, token, verification } });
  return { world, entry };
}

const put = (workspaceId: string, headers: Record<string, string> = authorised) =>
  PUT(new Request(`${URL_BASE}/${workspaceId}`, { method: 'PUT', headers }), {
    params: Promise.resolve({ workspaceId }),
  });

describe('PUT /api/demo/verification/{workspaceId}', () => {
  it('does not exist while the operator token is unset, and refuses a wrong token', async () => {
    const { world } = await install(null);
    const owner = await world.newWorkspace();
    expect((await put(owner.workspaceId)).status).toBe(404);
    await install(TOKEN);
    const wrong = await put(owner.workspaceId, { authorization: 'Bearer nope' });
    expect(wrong.status).toBe(401);
  });

  it("fills an ordinary workspace and names the entries copied, with the visitor's caps", async () => {
    const { world, entry } = await install(TOKEN);
    const owner = await world.newWorkspace();
    const response = await put(owner.workspaceId);
    expect(response.status).toBe(200);
    expect(DemoVerificationFillSchema.parse(await response.json())).toEqual({
      workspaceId: owner.workspaceId,
      entries: [entry],
    });
    const [agent] = await world.agents(owner.workspaceId);
    expect(agent?.name).toBe('writer');
    expect(agent?.policy?.limits).toEqual({ maxTurns: 5, maxBudgetUsd: 0.2 });
  });

  it('answers 400 for an id that is not one, 404 for no such workspace, 409 for a demo', async () => {
    const { world } = await install(TOKEN);
    const invalid = await put('store-verification');
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: 'invalid_workspace_id' } });
    const missing = await put(crypto.randomUUID());
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: { code: 'verification_workspace_not_found' },
    });
    const guest = await world.newGuest();
    const refused = await put(guest.workspaceId);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: { code: 'verification_workspace_refused' },
    });
    expect(await world.agents(guest.workspaceId)).toEqual([]);
  });

  it('answers 503 where the deployment cannot hold a template', async () => {
    installTestDomains({ demoOperator: { ...NO_DEMO_OPERATOR, token: TOKEN } });
    expect((await put(crypto.randomUUID())).status).toBe(503);
  });
});
