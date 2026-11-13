// The Agent on data cell of examples/crm: the sales assistant works on contacts and deals through
// the app's MCP endpoint as the person who asked (ADR-0142), and is refused a field the resource
// does not give agents: deal.amount stays outside agents.write.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { mcpEndpoint } from '@indx-workspace/app/server';
import {
  FAKE_WORKSPACE_ID,
  fakePerson,
  resetAppRuntimeForTests,
  setAppRuntimeForTests,
  type TestAppRuntime,
} from '@indx-workspace/app/testing';
import {
  IDENTITY_ASSERTION_HEADER,
  signIdentity,
} from '@indx-workspace/contracts/identity-assertion';
import { fetchDouble, jsonResponse } from '@indx-workspace/sdk/testing';

import salesAssistant from '../agents/sales-assistant.ts';
import app from '../app.config.ts';
import company from '../resources/company.ts';
import contact from '../resources/contact.ts';
import deal from '../resources/deal.ts';

const CONNECTOR_ID = 'conn_crm';
const SIGNING_SECRET = 'crm-test-signing-secret';
const PERSON = crypto.randomUUID();

const platform = fetchDouble(() =>
  jsonResponse(200, {
    memberships: [
      {
        id: crypto.randomUUID(),
        principalId: PERSON,
        userId: crypto.randomUUID(),
        email: 'member@example.test',
        name: 'A member',
        role: 'builder',
        createdAt: '2026-10-01T00:00:00.000Z',
      },
    ],
  }),
);

let runtime: TestAppRuntime;

beforeEach(() => {
  runtime = setAppRuntimeForTests({
    appName: 'crm',
    fetch: platform.fetch,
    agentTools: {
      connectorId: CONNECTOR_ID,
      workspaceId: FAKE_WORKSPACE_ID,
      identitySecrets: [SIGNING_SECRET],
      apiKey: 'app-machine-key-for-tests',
    },
  });
});

afterEach(() => resetAppRuntimeForTests());

async function callTool(runId: string, name: string, args: Record<string, unknown>) {
  const assertion = await signIdentity(
    {
      sub: PERSON,
      principalKind: 'membership',
      workspace: FAKE_WORKSPACE_ID,
      runId,
      aud: CONNECTOR_ID,
      exp: Math.floor(Date.now() / 1000) + 300,
    },
    SIGNING_SECRET,
  );
  const response = await mcpEndpoint(app).POST(
    new Request('https://crm.test/api/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        [IDENTITY_ASSERTION_HEADER]: assertion,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }),
  );
  const body = (await response.json()) as {
    result: { isError?: boolean; content: { text: string }[]; structuredContent?: unknown };
  };
  return body.result;
}

test('the sales assistant updates a contact as the person and is refused a field outside agents.write', async () => {
  const owner = fakePerson({ role: 'admin' });
  const linked = await runtime
    .storeOf(company)
    .create(owner, { name: 'Example', domain: 'example.co.jp' });
  const created = await runtime
    .storeOf(contact)
    .create(owner, { name: 'Aiko Tanaka', email: 'aiko@example.co.jp', owner: PERSON });
  const renewal = await runtime.storeOf(deal).create(owner, {
    name: 'Example renewal',
    amount: { amount: '1200000', currency: 'JPY' },
    stage: 'qualified',
    owner: PERSON,
  });
  const runId = `run_${crypto.randomUUID()}`;

  const update = await callTool(runId, 'contact_update', { id: created.id, company: linked.id });
  const refused = await callTool(runId, 'deal_update', {
    id: renewal.id,
    amount: { amount: '1', currency: 'JPY' },
  });

  // The app's connector is the sales assistant's first tool, so these are the calls it makes.
  assert.deepEqual(salesAssistant.tools?.[0], { connector: 'crm' });
  assert.equal(update.isError, undefined);
  assert.equal((update.structuredContent as { company: string }).company, linked.id);
  const [audit] = runtime
    .storeOf(contact)
    .auditEvents()
    .filter((event) => event.action === 'update');
  assert.deepEqual(
    { actor: audit?.actor, via: audit?.via, runId: audit?.run_id, fields: audit?.fields },
    { actor: PERSON, via: 'agent', runId, fields: ['company'] },
  );
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]?.text ?? '', /^forbidden: .*fields:amount/u);
  const kept = await runtime.storeOf(deal).get(owner, renewal.id);
  assert.deepEqual(kept.amount, { amount: '1200000', currency: 'JPY' });
});
