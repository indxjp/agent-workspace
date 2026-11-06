// The Agent on data cell of examples/service-desk: triage works on a ticket through the app's MCP
// endpoint as the requester who asked, within agents.write, and is refused a delete, which the
// resource gives no agent (and the requester, a builder, could not make either).
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

import triage from '../agents/triage.ts';
import app from '../app.config.ts';
import ticket from '../resources/ticket.ts';

const CONNECTOR_ID = 'conn_service_desk';
const SIGNING_SECRET = 'service-desk-test-signing-secret';
const REQUESTER = crypto.randomUUID();
const RUN_ID = `run_${crypto.randomUUID()}`;

const platform = fetchDouble(() =>
  jsonResponse(200, {
    memberships: [
      {
        id: crypto.randomUUID(),
        principalId: REQUESTER,
        userId: crypto.randomUUID(),
        email: 'requester@example.test',
        name: 'A requester',
        role: 'builder',
        createdAt: '2026-10-01T00:00:00.000Z',
      },
    ],
  }),
);

let runtime: TestAppRuntime;

beforeEach(() => {
  runtime = setAppRuntimeForTests({
    appName: 'service-desk',
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

async function callTool(name: string, args: Record<string, unknown>) {
  const assertion = await signIdentity(
    {
      sub: REQUESTER,
      principalKind: 'membership',
      workspace: FAKE_WORKSPACE_ID,
      runId: RUN_ID,
      aud: CONNECTOR_ID,
      exp: Math.floor(Date.now() / 1000) + 300,
    },
    SIGNING_SECRET,
  );
  const response = await mcpEndpoint(app).POST(
    new Request('https://service-desk.test/api/mcp', {
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

test('triage updates a ticket as the requester and is refused deleting it', async () => {
  const created = await runtime.storeOf(ticket).create(fakePerson({ principalId: REQUESTER }), {
    title: 'VPN down',
    description: [{ type: 'paragraph', text: 'Nobody can connect.' }],
    status: 'new',
    priority: 'p1',
    requester: REQUESTER,
    assignee: REQUESTER,
  });

  const update = await callTool('ticket_update', { id: created.id, status: 'in_progress' });
  const retitle = await callTool('ticket_update', { id: created.id, title: 'Renamed' });
  const remove = await callTool('ticket_delete', { id: created.id });

  // Triage's one tool is this app's connector, so these calls are the calls it makes.
  assert.deepEqual(triage.tools, [{ connector: 'service-desk' }]);
  assert.equal(update.isError, undefined);
  assert.equal((update.structuredContent as { status: string }).status, 'in_progress');
  const [, written] = runtime.storeOf(ticket).auditEvents();
  assert.deepEqual(
    [written?.actor, written?.via, written?.run_id, written?.fields],
    [REQUESTER, 'agent', RUN_ID, ['status']],
  );
  assert.equal(retitle.isError, true);
  assert.equal(remove.isError, true);
  assert.match(remove.content[0]?.text ?? '', /^unknown_tool: /u);
  assert.equal(runtime.storeOf(ticket).calls.delete, 0);
  const kept = await runtime.storeOf(ticket).get(fakePerson(), created.id);
  assert.deepEqual([kept.title, kept.status], ['VPN down', 'in_progress']);
});
