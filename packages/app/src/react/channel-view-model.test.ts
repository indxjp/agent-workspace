import { describe, expect, it } from 'vitest';

import { files, ref, richText, text } from '../fields/index.js';
import { defineResource } from '../resource.js';
import {
  bodyTextOf,
  channelFieldsOf,
  memberName,
  mentionQuery,
  mentionsOf,
  mentionSuggestions,
  mergeChannelEvents,
  messageInput,
  presentPrincipals,
  recordPresence,
  threadsOf,
  withMention,
  type ChannelMember,
  type ChannelViewEvent,
} from './channel-view-model.js';

const ROOM = '00000000-0000-4000-8000-0000000000aa';

function message(id: string, at: string, extra: Record<string, unknown> = {}) {
  return { id, created_at: at, room: ROOM, body: `message ${id}`, ...extra };
}

function event(id: number, type: string, data: unknown): ChannelViewEvent {
  return { id: String(id), type, data };
}

describe('mergeChannelEvents', () => {
  it('orders records oldest first by created_at, then id, whatever order the events came in', () => {
    const merged = mergeChannelEvents([
      event(1, 'created', message('b', '2026-10-01T00:00:02.000Z')),
      event(2, 'created', message('c', '2026-10-01T00:00:01.000Z')),
      event(3, 'created', message('a', '2026-10-01T00:00:02.000Z')),
    ]);
    expect(merged.map((record) => record.id)).toEqual(['c', 'a', 'b']);
  });

  it('replaces a record on update and removes it on delete', () => {
    const merged = mergeChannelEvents([
      event(1, 'created', message('a', '2026-10-01T00:00:01.000Z')),
      event(2, 'created', message('b', '2026-10-01T00:00:02.000Z')),
      event(3, 'updated', message('a', '2026-10-01T00:00:01.000Z', { body: 'edited' })),
      event(4, 'deleted', message('b', '2026-10-01T00:00:02.000Z')),
    ]);
    expect(merged).toEqual([message('a', '2026-10-01T00:00:01.000Z', { body: 'edited' })]);
  });

  it('applies an event delivered twice once', () => {
    const created = event(1, 'created', message('a', '2026-10-01T00:00:01.000Z'));
    const updated = event(2, 'updated', message('a', '2026-10-01T00:00:01.000Z', { body: 'x' }));
    // The second copy of event 1 comes after the update; applying it again would undo the update.
    const merged = mergeChannelEvents([created, updated, created]);
    expect(merged).toEqual([updated.data]);
  });

  it('ignores an event whose data is not a record, or of another type', () => {
    expect(
      mergeChannelEvents([
        event(1, 'created', 'text'),
        event(2, 'created', { id: 'a' }),
        event(3, 'typing', message('b', '2026-10-01T00:00:01.000Z')),
      ]),
    ).toEqual([]);
  });
});

describe('threadsOf', () => {
  const root = message('r', '2026-10-01T00:00:01.000Z');
  const reply = message('s', '2026-10-01T00:00:02.000Z', { thread_root: 'r' });
  const orphan = message('t', '2026-10-01T00:00:03.000Z', { thread_root: 'gone' });
  const other = message('u', '2026-10-01T00:00:04.000Z', { thread_root: null });

  it('groups replies under the message their thread field names', () => {
    expect(threadsOf([root, reply, orphan, other], 'thread_root')).toEqual([
      { root, replies: [reply] },
      { root: orphan, replies: [] },
      { root: other, replies: [] },
    ]);
  });

  it('makes every message its own thread without a thread field', () => {
    expect(threadsOf([root, reply], undefined)).toEqual([
      { root, replies: [] },
      { root: reply, replies: [] },
    ]);
  });
});

describe('presence', () => {
  it('forgets a person 45 s after their last heartbeat, and a later heartbeat keeps them', () => {
    let clock = 1_000_000;
    let state = recordPresence(new Map(), 'ann', clock);
    state = recordPresence(state, 'bob', clock + 10_000);
    clock += 44_999;
    expect(presentPrincipals(state, clock)).toEqual(['ann', 'bob']);
    clock += 1;
    expect(presentPrincipals(state, clock)).toEqual(['bob']);
    state = recordPresence(state, 'ann', clock);
    clock += 15_000;
    expect(presentPrincipals(state, clock)).toEqual(['ann']);
    clock += 29_999;
    expect(presentPrincipals(state, clock)).toEqual(['ann']);
    clock += 1;
    expect(presentPrincipals(state, clock)).toEqual([]);
  });

  it('keeps the newer of two heartbeats', () => {
    const state = recordPresence(new Map([['ann', 50]]), 'ann', 10);
    expect(state.get('ann')).toBe(50);
  });
});

describe('mentions', () => {
  const members: ChannelMember[] = [
    { principalId: 'p-ann', name: 'Ann' },
    { principalId: 'p-ann-lee', name: 'Ann Lee' },
    { principalId: 'p-triage', name: 'triage' },
  ];

  it('parses @names into principal ids, longest name first, each once', () => {
    expect(mentionsOf('@Ann Lee and @ann, ask @Triage. Again @Ann', members)).toEqual([
      'p-ann-lee',
      'p-ann',
      'p-triage',
    ]);
  });

  it('ignores an @ that names no member, or runs into another word', () => {
    expect(mentionsOf('mail ann@example.test or @Annie', members)).toEqual([]);
  });

  it('suggests members for the @partial being typed, and inserts the chosen name', () => {
    expect(mentionQuery('hello @an')).toBe('an');
    expect(mentionQuery('hello an')).toBeNull();
    expect(mentionSuggestions('hello @an', members).map((member) => member.name)).toEqual([
      'Ann',
      'Ann Lee',
    ]);
    expect(withMention('hello @an', { principalId: 'p-ann-lee', name: 'Ann Lee' })).toBe(
      'hello @Ann Lee ',
    );
  });

  it('names a member, or a short id for someone not in the list', () => {
    expect(memberName(members, 'p-ann')).toBe('Ann');
    expect(memberName(members, '0123456789abcdef')).toBe('01234567');
  });
});

describe('channelFieldsOf and messageInput', () => {
  const messages = defineResource({
    name: 'message',
    fields: {
      thread_root: ref('message', { optional: true }),
      room: ref('room'),
      body: richText(),
      attachments: files({ optional: true }),
    },
    access: { read: 'member', create: 'member', update: 'member', delete: 'member' },
  });

  it('finds the key, body, thread and attachments fields', () => {
    expect(channelFieldsOf(messages)).toEqual({
      keyField: 'room',
      bodyField: 'body',
      bodyIsRichText: true,
      threadField: 'thread_root',
      attachmentsField: 'attachments',
    });
  });

  it('refuses a resource with no key field', () => {
    const notes = defineResource({
      name: 'note',
      fields: { body: text() },
      access: { read: 'member', create: 'member', update: 'member', delete: 'member' },
    });
    expect(() => channelFieldsOf(notes)).toThrow(/no key field/u);
  });

  it('builds the create body of a reply with attachments, and nothing from an empty message', () => {
    const fields = channelFieldsOf(messages);
    expect(
      messageInput(fields, {
        text: ' hello ',
        keyValue: ROOM,
        threadRoot: 'r',
        attachments: ['f1'],
      }),
    ).toEqual({
      room: ROOM,
      body: [{ type: 'paragraph', text: 'hello' }],
      thread_root: 'r',
      attachments: ['f1'],
    });
    expect(messageInput(fields, { text: '  ', keyValue: ROOM })).toBeNull();
    expect(bodyTextOf([{ type: 'paragraph', text: 'hello' }])).toBe('hello');
    expect(bodyTextOf('plain')).toBe('plain');
    expect(bodyTextOf(null)).toBe('');
  });
});
