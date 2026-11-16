// The Agent on data cell of examples/team-chat: the helper agent reads channels through the app's
// MCP endpoint as the member who asked (a builder, named by an ADR-0142 identity assertion), and
// has no way to delete one: agents get no delete tool, and a channel delete is an admin's anyway.
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

import helper from '../agents/helper.ts';
import app from '../app.config.ts';
import channel from '../resources/channel.ts';

const CONNECTOR_ID = 'conn_team_chat';
const SIGNING_SECRET = 'team-chat-test-signing-secret';
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
    appName: 'team-chat',
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
      sub: PERSON,
      principalKind: 'membership',
      workspace: FAKE_WORKSPACE_ID,
      runId: `run_${crypto.randomUUID()}`,
      aud: CONNECTOR_ID,
      exp: Math.floor(Date.now() / 1000) + 300,
    },
    SIGNING_SECRET,
  );
  const response = await mcpEndpoint(app).POST(
    new Request('https://team-chat.test/api/mcp', {
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

test('the helper reads a channel as the person and is refused deleting it', async () => {
  const created = await runtime
    .storeOf(channel)
    .create(fakePerson({ role: 'admin' }), { name: 'general', kind: 'public' });

  const list = await callTool('channel_list', {});
  const removal = await callTool('channel_delete', { id: created.id });

  // The helper's one tool is this app's connector, so these calls are the calls it makes.
  assert.deepEqual(helper.tools, [{ connector: 'team-chat' }]);
  assert.equal(list.isError, undefined);
  const { items } = list.structuredContent as { items: { id: string; name: string }[] };
  assert.deepEqual(
    items.map((item) => item.name),
    ['general'],
  );
  assert.equal(removal.isError, true);
  assert.match(removal.content[0]?.text ?? '', /^unknown_tool: /u);
  assert.equal(runtime.storeOf(channel).calls.delete, 0);
});
