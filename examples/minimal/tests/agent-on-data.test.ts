// The Agent on data cell of examples/minimal: the helper agent works on notes through the app's
// MCP endpoint as the person who asked, and is refused a write the resource does not give agents.
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
import note from '../resources/note.ts';

const CONNECTOR_ID = 'conn_minimal';
const SIGNING_SECRET = 'minimal-test-signing-secret';
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
    appName: 'minimal',
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
    new Request('https://minimal.test/api/mcp', {
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

test('the helper reads notes as the person and is refused an update outside agents.write', async () => {
  const created = await runtime
    .storeOf(note)
    .create(fakePerson({ role: 'admin' }), { title: 'Standup', body: [] });

  const read = await callTool('note_get', { id: created.id });
  const update = await callTool('note_update', { id: created.id, title: 'Changed' });

  // The helper's one tool is this app's connector, so these calls are the calls it makes.
  assert.deepEqual(helper.tools, [{ connector: 'minimal' }]);
  assert.equal(read.isError, undefined);
  assert.deepEqual((read.structuredContent as { title: string }).title, 'Standup');
  assert.equal(update.isError, true);
  assert.match(update.content[0]?.text ?? '', /^unknown_tool: /u);
  assert.equal(runtime.storeOf(note).calls.update, 0);
});
