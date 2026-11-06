import { ApiProblemSchema } from '@indx-workspace/contracts';
import type { MembershipRoleName } from '@indx-workspace/contracts/team';
import { readSseFrames, type SseFrame } from '@indx-workspace/sdk/events';
import { fetchDouble, jsonResponse } from '@indx-workspace/sdk/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { text } from '../fields/index.js';
import type { Person } from '../person.js';
import { defineResource } from '../resource.js';
import { describeChannelConformance } from '../testing/channel-conformance.js';
import { FAKE_WORKSPACE_ID } from '../testing/fake-person.js';
import {
  resetAppRuntimeForTests,
  setAppRuntimeForTests,
  type TestAppRuntime,
} from '../testing/runtime.js';
import { channel } from './channel.js';
import { SSE_HEADERS } from './sse.js';

const rooms = defineResource({
  name: 'room',
  fields: { title: text() },
  access: { read: 'role:admin', create: 'member', update: 'member', delete: 'member' },
});

const people = new Map<string, Person>();

function signIn(role: MembershipRoleName): string {
  const token = `awo_live_${crypto.randomUUID().replaceAll('-', '')}`;
  people.set(token, {
    principalId: crypto.randomUUID(),
    workspaceId: FAKE_WORKSPACE_ID,
    role,
    via: 'person',
  });
  return token;
}

const platform = fetchDouble((request) => {
  const token = request.headers.get('authorization')?.replace(/^Bearer /u, '') ?? '';
  const found = people.get(token);
  if (found === undefined) {
    return jsonResponse(401, { error: { code: 'unauthenticated', message: 'Sign in.' } });
  }
  return jsonResponse(200, {
    principalId: found.principalId,
    kind: 'membership',
    role: found.role,
    workspaceId: found.workspaceId,
    userId: crypto.randomUUID(),
    label: 'Someone',
    features: [],
  });
});

let runtime: TestAppRuntime;

beforeEach(() => {
  people.clear();
  runtime = setAppRuntimeForTests({ fetch: platform.fetch });
});

afterEach(() => {
  resetAppRuntimeForTests();
});

const tx = { execute: () => Promise.reject(new Error('the memory hub runs no SQL')) };

describeChannelConformance('memoryChannelHub', () => ({ tx: () => tx }), { describe, it });

const BASE = 'https://app.test/api/channels/chat/events';
const chat = channel('chat', { resource: rooms });

/** Whether a frame's payload is a stream's own presence heartbeat, `{ principalId }`. */
function isOwnPresence(payload: unknown): boolean {
  const event = payload as { type?: unknown; data?: { principalId?: unknown } } | null;
  return event?.type === 'presence' && typeof event.data?.principalId === 'string';
}

function get(
  url: string,
  token?: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
) {
  return chat.routes().GET(
    new Request(url, {
      headers: { ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...headers },
      ...(signal === undefined ? {} : { signal }),
    }),
  );
}

async function problemOf(response: Response): Promise<{ status: number; code: string }> {
  const parsed = ApiProblemSchema.parse(await response.json());
  return { status: response.status, code: parsed.error.code };
}

async function room(token: string): Promise<string> {
  const person = people.get(token);
  if (person === undefined) throw new Error('unknown token');
  return (await runtime.storeOf(rooms).create(person, { title: 'General' })).id;
}

/** The first `count` named frames of `response`, then the stream is cancelled. */
async function framesOf(response: Response, count: number): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  if (response.body === null) throw new Error('no body');
  const abort = new AbortController();
  for await (const frame of readSseFrames(response.body, abort.signal)) {
    frames.push(frame);
    if (frames.length >= count) break;
  }
  abort.abort();
  return frames;
}

describe('channel(…).routes().GET', () => {
  it('answers 401 without a person', async () => {
    expect(await problemOf(await get(`${BASE}?key=${crypto.randomUUID()}`))).toEqual({
      status: 401,
      code: 'unauthenticated',
    });
  });

  it('answers 404 before the stream when the person may not read the record, or it is missing', async () => {
    const admin = signIn('admin');
    const member = signIn('viewer');
    const id = await room(admin);
    expect(await problemOf(await get(`${BASE}?key=${id}`, member))).toEqual({
      status: 404,
      code: 'resource_not_found',
    });
    expect(await problemOf(await get(`${BASE}?key=${crypto.randomUUID()}`, admin))).toEqual({
      status: 404,
      code: 'resource_not_found',
    });
    expect(await problemOf(await get(`${BASE}?key=not-a-uuid`, admin))).toEqual({
      status: 404,
      code: 'resource_not_found',
    });
  });

  it('answers 400 invalid_query without exactly one key', async () => {
    const admin = signIn('admin');
    expect(await problemOf(await get(BASE, admin))).toEqual({ status: 400, code: 'invalid_query' });
    expect(await problemOf(await get(`${BASE}?key=a&key=b`, admin))).toEqual({
      status: 400,
      code: 'invalid_query',
    });
  });

  it('answers 400 invalid_cursor for a malformed cursor, never the whole log', async () => {
    const admin = signIn('admin');
    const id = await room(admin);
    await chat.publish(tx, { key: id, type: 'created', data: {} });
    for (const response of [
      await get(`${BASE}?key=${id}`, admin, { 'last-event-id': 'abc' }),
      await get(`${BASE}?key=${id}&after=-1`, admin),
      await get(`${BASE}?key=${id}&after=1`, admin, { 'last-event-id': '1'.repeat(20) }),
    ]) {
      expect(await problemOf(response)).toEqual({ status: 400, code: 'invalid_cursor' });
    }
  });

  it('streams with the three SSE headers, resumes from Last-Event-ID, and names no frame error', async () => {
    const admin = signIn('admin');
    const id = await room(admin);
    const first = await chat.publish(tx, { key: id, type: 'created', data: { n: 1 } });
    await chat.publish(tx, { key: id, type: 'updated', data: { n: 2 } });

    const response = await get(`${BASE}?key=${id}`, admin, { 'last-event-id': first.id });
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toEqual(
      Object.fromEntries(
        Object.entries(SSE_HEADERS).map(([name, value]) => [name.toLowerCase(), value]),
      ),
    );
    // Four frames: the three below and the stream's own presence heartbeat, as it opens.
    const live = framesOf(response, 4);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await chat.publishEphemeral({ key: id, type: 'presence', data: { online: true } });
    await chat.publish(tx, { key: id, type: 'deleted', data: { n: 3 } });
    const all = await live;
    const own = all.filter((frame) => isOwnPresence(frame.data));
    expect(own).toHaveLength(1);
    const frames = all.filter((frame) => !own.includes(frame));
    expect(frames.map((frame) => frame.event)).toEqual([
      'channel-event',
      'channel-ephemeral',
      'channel-event',
    ]);
    expect(frames[0]).toMatchObject({ data: { key: id, type: 'updated', data: { n: 2 } } });
    expect(frames[1]).toMatchObject({ id: null, data: { key: id, type: 'presence' } });
    expect(frames.every((frame) => frame.event !== 'error')).toBe(true);
    expect(Number(frames[2]?.id)).toBeGreaterThan(Number(frames[0]?.id));
  });

  it('answers a stale ?after= with stream-reset', async () => {
    const admin = signIn('admin');
    const id = await room(admin);
    const small = channel('chat', { resource: rooms, retain: 1 });
    const first = await small.publish(tx, { key: id, type: 'a', data: null });
    await small.publish(tx, { key: id, type: 'b', data: null });
    await small.publish(tx, { key: id, type: 'c', data: null });
    const response = await small.routes().GET(
      new Request(`${BASE}?key=${id}&after=${first.id}`, {
        headers: { authorization: `Bearer ${admin}` },
      }),
    );
    const frames = await framesOf(response, 2);
    expect(frames.map((frame) => frame.event)).toEqual(['stream-reset', 'channel-event']);
    expect(frames[1]).toMatchObject({ data: { type: 'c' } });
  });

  it('stops following and unsubscribes when the request is aborted', async () => {
    const admin = signIn('admin');
    const id = await room(admin);
    const abort = new AbortController();
    const response = await get(`${BASE}?key=${id}`, admin, {}, abort.signal);
    const reader = response.body?.getReader();
    expect((await reader?.read())?.done).toBe(false);
    abort.abort();
    await reader?.cancel();
    expect(
      runtime.channelLog.stored({ workspaceId: FAKE_WORKSPACE_ID, channel: 'chat', key: id }),
    ).toEqual([]);
  });
});

describe('channel()', () => {
  it('refuses a malformed name or retain', () => {
    expect(() => channel('Chat', { resource: rooms })).toThrow(TypeError);
    expect(() => channel('chat:x', { resource: rooms })).toThrow(TypeError);
    expect(() => channel('chat', { resource: rooms, retain: 0 })).toThrow(TypeError);
    expect(() => channel('chat', { resource: rooms, retain: 1.5 })).toThrow(TypeError);
    expect(channel('chat', { resource: rooms }).retain).toBe(1_000);
    expect(channel('chat', { resource: rooms, key: 'room' }).keyField).toBe('room');
  });

  it('refuses an ephemeral event of 8000 bytes or more', async () => {
    const big = 'x'.repeat(8_000);
    await expect(chat.publishEphemeral({ key: 'k', type: 'typing', data: big })).rejects.toThrow(
      RangeError,
    );
    await expect(
      chat.publishEphemeral({ key: 'k', type: 'typing', data: 'x'.repeat(7_000) }),
    ).resolves.toBeUndefined();
  });
});
