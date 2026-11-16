// The Agent on data cell of examples/wiki: the writer agent works on pages through the app's MCP
// endpoint as the person who asked, and is refused what that person may not do. Spaces carry no
// access of their own, so the refused write is a delete, which pages give `role:admin` only and
// agents never: the person is a builder.
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

import writer from '../agents/writer.ts';
import app from '../app.config.ts';
import page from '../resources/page.ts';
import space from '../resources/space.ts';

const CONNECTOR_ID = 'conn_wiki';
const SIGNING_SECRET = 'wiki-test-signing-secret';
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
    appName: 'wiki',
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
    new Request('https://wiki.test/api/mcp', {
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

test('the writer reads pages as the person, creates one in its run, and is refused a delete (role:admin)', async () => {
  const admin = fakePerson({ role: 'admin' });
  const engineering = await runtime.storeOf(space).create(admin, { name: 'Engineering' });
  const pages = runtime.pageStoreOf(page);
  const handbook = await pages.create(admin, {
    space: engineering.id,
    title: 'Engineering handbook',
    blocks: [],
  });
  const runId = crypto.randomUUID();

  const read = await callTool(runId, 'page_get', { id: handbook.id });
  const created = await callTool(runId, 'page_create', {
    parent: handbook.id,
    space: engineering.id,
    title: 'Summary',
    markdown: 'The handbook, in short.',
  });
  const deleted = await callTool(runId, 'page_delete', { id: handbook.id });

  // The writer's one tool is this app's connector, so these calls are the calls it makes.
  assert.deepEqual(writer.tools, [{ connector: 'wiki' }]);
  assert.equal(read.isError, undefined);
  assert.equal((read.structuredContent as { title: string }).title, 'Engineering handbook');
  assert.equal(created.isError, undefined);
  const summary = created.structuredContent as { id: string; parent: string };
  assert.equal(summary.parent, handbook.id);
  const [revision] = pages.storedRevisions(summary.id);
  assert.equal(revision?.run_id, runId);
  assert.equal(revision?.author_principal_id, PERSON);
  // A builder may not delete a page, and agents have no delete tool: the page stays.
  assert.equal(deleted.isError, true);
  assert.match(deleted.content[0]?.text ?? '', /^unknown_tool: /u);
  assert.equal(pages.calls.delete, 0);
  await assert.rejects(pages.delete(fakePerson({ role: 'builder' }), handbook.id));
});
