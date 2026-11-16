/**
 * A resource bound to a channel (issue #1519): every write publishes in its transaction, through
 * the generated routes and through the agent tools alike, and a subscriber merges what it
 * receives with `ChannelView`'s model. On the in-memory store and channel twin.
 */
import {
  IDENTITY_ASSERTION_HEADER,
  signIdentity,
} from '@indx-workspace/contracts/identity-assertion';
import { fetchDouble, jsonResponse } from '@indx-workspace/sdk/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defineApp } from '../app.js';
import { ref, text } from '../fields/index.js';
import { definePages } from '../pages/define-pages.js';
import { mergeChannelEvents } from '../react/channel-view-model.js';
import { defineResource } from '../resource.js';
import { FAKE_WORKSPACE_ID, fakePerson } from '../testing/fake-person.js';
import {
  resetAppRuntimeForTests,
  setAppRuntimeForTests,
  type TestAppRuntime,
} from '../testing/runtime.js';
import { bindChannel, boundChannels, clearChannelBindings } from './channel-bindings.js';
import { channel, type ChannelDelivery } from './channel.js';
import { mcpEndpoint } from './mcp.js';
import { resourceItemRoutes, resourceRoutes } from './routes.js';

const rooms = defineResource({
  name: 'room',
  fields: { title: text() },
  access: { read: 'member', create: 'member', update: 'member', delete: 'member' },
});
const messages = defineResource({
  name: 'message',
  fields: { room: ref('room'), body: text() },
  access: { read: 'member', create: 'member', update: 'member', delete: 'member' },
  agents: { read: true, write: ['body'] },
});
const app = defineApp({ name: 'chat', resources: [rooms, messages] });
const messageChannel = channel('message', { resource: rooms, key: 'room' });

const CONNECTOR_ID = 'conn_chat';
const SECRET = 'chat-signing-secret';
const PERSON_ID = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'awu_live_chat_person';

const platform = fetchDouble((request) => {
  if (request.url.pathname === '/api/me') {
    if (request.headers.get('authorization') !== `Bearer ${TOKEN}`) {
      return jsonResponse(401, { error: { code: 'unauthenticated', message: 'Sign in.' } });
    }
    return jsonResponse(200, {
      principalId: PERSON_ID,
      kind: 'membership',
      role: 'builder',
      workspaceId: FAKE_WORKSPACE_ID,
      userId: crypto.randomUUID(),
      label: 'Someone',
      features: [],
    });
  }
  return jsonResponse(200, {
    memberships: [
      {
        id: crypto.randomUUID(),
        principalId: PERSON_ID,
        userId: crypto.randomUUID(),
        email: 'someone@example.test',
        name: 'Someone',
        role: 'builder',
        createdAt: '2026-10-01T00:00:00.000Z',
      },
    ],
  });
});

let runtime: TestAppRuntime;

beforeEach(() => {
  clearChannelBindings();
  runtime = setAppRuntimeForTests({
    appName: 'chat',
    fetch: platform.fetch,
    agentTools: {
      connectorId: CONNECTOR_ID,
      workspaceId: FAKE_WORKSPACE_ID,
      identitySecrets: [SECRET],
      apiKey: 'ak_live_chat_machine_key',
    },
  });
});

afterEach(() => {
  resetAppRuntimeForTests();
  clearChannelBindings();
});

const person = fakePerson({ principalId: PERSON_ID, role: 'builder' });

async function room(): Promise<string> {
  return (await runtime.storeOf(rooms).create(person, { title: 'general' })).id;
}

function stored(key: string) {
  return runtime.channelLog.stored({ workspaceId: FAKE_WORKSPACE_ID, channel: 'message', key });
}

/** The durable events a subscriber of `key` receives, until it has `count`. */
async function receive(key: string, count: number, during: () => Promise<void>) {
  const abort = new AbortController();
  const events: Extract<ChannelDelivery, { kind: 'event' }>[] = [];
  const reading = (async () => {
    for await (const delivery of messageChannel.subscribe({
      workspaceId: FAKE_WORKSPACE_ID,
      key,
      signal: abort.signal,
    })) {
      if (delivery.kind !== 'event') continue;
      events.push(delivery);
      if (events.length === count) abort.abort();
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await during();
  const timeout = setTimeout(() => abort.abort(), 2_000);
  await reading;
  clearTimeout(timeout);
  return events;
}

describe('a resource bound to a channel', () => {
  it('publishes nothing until a route binds it, then each write of the generated routes', async () => {
    const key = await room();
    await runtime.storeOf(messages).create(person, { room: key, body: 'unbound' });
    expect(stored(key)).toEqual([]);

    const routes = resourceRoutes(messages, { publish: messageChannel });
    const item = resourceItemRoutes(messages, { publish: messageChannel });
    expect(boundChannels('message')).toEqual([messageChannel]);
    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    const created = await routes.POST(
      new Request('https://app.test/api/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify({ room: key, body: 'hello' }),
      }),
    );
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const context = { params: Promise.resolve({ id }) };
    const patched = await item.PATCH(
      new Request(`https://app.test/api/messages/${id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ body: 'hello, edited' }),
      }),
      context,
    );
    expect(patched.status).toBe(200);
    const deleted = await item.DELETE(
      new Request(`https://app.test/api/messages/${id}`, { method: 'DELETE', headers }),
      context,
    );
    expect(deleted.status).toBe(204);
    expect(stored(key).map((event) => [event.type, (event.data as { body: string }).body])).toEqual(
      [
        ['created', 'hello'],
        ['updated', 'hello, edited'],
        ['deleted', 'hello, edited'],
      ],
    );
  });

  it('delivers an agent write through the message_update tool to a subscriber, merged once', async () => {
    resourceRoutes(messages, { publish: messageChannel });
    const key = await room();
    const first = await runtime.storeOf(messages).create(person, { room: key, body: 'draft' });
    const assertion = await signIdentity(
      {
        sub: PERSON_ID,
        principalKind: 'membership',
        workspace: FAKE_WORKSPACE_ID,
        runId: 'run_chat_reply',
        aud: CONNECTOR_ID,
        exp: Math.floor(Date.now() / 1000) + 300,
      },
      SECRET,
    );
    const received = await receive(key, 2, async () => {
      const response = await mcpEndpoint(app).POST(
        new Request('https://app.test/api/mcp', {
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
            params: { name: 'message_update', arguments: { id: first.id, body: 'from the agent' } },
          }),
        }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { result?: { isError?: boolean } };
      expect(body.result?.isError).not.toBe(true);
    });
    expect(received.map((event) => event.type)).toEqual(['created', 'updated']);
    // The subscriber sees the stored event again on a reconnect: it is applied once.
    const merged = mergeChannelEvents([...received, ...received]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: first.id, body: 'from the agent', room: key });
    // The agent's write is audited in its run, as every agent write is.
    const audit = runtime.storeOf(messages).auditEvents();
    expect(audit.at(-1)).toMatchObject({ via: 'agent', run_id: 'run_chat_reply' });
  });

  it('rolls the write back when publishing fails', async () => {
    const tooBig = channel('message', { resource: rooms, key: 'body' });
    bindChannel(messages, tooBig);
    const key = await room();
    // A key of over 200 characters is refused by publish, inside the write.
    await expect(
      runtime.storeOf(messages).create(person, { room: key, body: 'x'.repeat(201) }),
    ).rejects.toThrow();
    expect((await runtime.storeOf(messages).list(person)).items).toEqual([]);
  });

  it('refuses to bind a pages resource, whose store does not publish', () => {
    const wiki = definePages({
      name: 'wiki_page',
      access: { read: 'member', create: 'member', update: 'member', delete: 'member' },
    });
    expect(() => bindChannel(wiki, messageChannel)).toThrow(/cannot publish/u);
  });
});
