import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { files, ref, text } from '../fields/index.js';
import { defineResource } from '../resource.js';
import { channelFieldsOf, type ChannelMember } from './channel-view-model.js';
import {
  ChannelMessageList,
  ChannelView,
  MentionSuggestions,
  PresenceRow,
} from './channel-view.js';
import { appStrings } from './locale.js';

const messages = defineResource({
  name: 'message',
  fields: {
    room: ref('room'),
    body: text(),
    thread_root: ref('message', { optional: true }),
    attachments: files({ optional: true }),
  },
  access: { read: 'member', create: 'member', update: 'member', delete: 'member' },
});

const ROOM = '00000000-0000-4000-8000-0000000000aa';
const ANN = '00000000-0000-4000-8000-0000000000a1';
const members: ChannelMember[] = [
  { principalId: ANN, name: 'Ann' },
  { principalId: 'agent-triage', name: 'Triage' },
];

const fields = channelFieldsOf(messages);
const en = appStrings('en').channel;
const ja = appStrings('ja').channel;

describe('ChannelView (#1519)', () => {
  it('labels the view, the list (aria-live polite), the presence row and the composer', () => {
    const html = renderToStaticMarkup(
      <ChannelView channel="message" resource={messages} keyValue={ROOM} members={members} />,
    );
    expect(html).toContain('aria-label="Channel"');
    expect(html).toMatch(/<ol[^>]*aria-label="Messages"[^>]*aria-live="polite"/u);
    expect(html).toContain('No messages yet. Write the first one.');
    expect(html).toContain('Here now');
    expect(html).toMatch(/<label for="[^"]+-text"[^>]*>Message<\/label>/u);
    expect(html).toContain('>Send</button>');
    expect(html).toContain('Connecting…');
    // No upload function, so no file picker.
    expect(html).not.toContain('type="file"');
  });

  it('speaks Japanese', () => {
    const html = renderToStaticMarkup(
      <ChannelView channel="message" resource={messages} keyValue={ROOM} locale="ja" />,
    );
    expect(html).toContain(`aria-label="${ja.channelLabel}"`);
    expect(html).toContain(`aria-label="${ja.messagesLabel}"`);
    expect(html).toContain(ja.noMessages);
    expect(html).toContain(`>${ja.send}</button>`);
  });

  it('offers a file picker when it can upload', () => {
    const html = renderToStaticMarkup(
      <ChannelView
        channel="message"
        resource={messages}
        keyValue={ROOM}
        uploadFile={() => Promise.reject(new Error('not in a static render'))}
      />,
    );
    expect(html).toMatch(/<label for="[^"]+-file"[^>]*>Attach a file<\/label>/u);
  });

  it('gives each mention suggestion a name', () => {
    const html = renderToStaticMarkup(
      <MentionSuggestions text="ask @" members={members} strings={en} onPick={() => undefined} />,
    );
    expect(html).toContain('aria-label="Mention someone"');
    expect(html).toContain('aria-label="Mention Ann"');
    expect(html).toContain('aria-label="Mention Triage"');
    const japanese = renderToStaticMarkup(
      <MentionSuggestions text="@Tr" members={members} strings={ja} onPick={() => undefined} />,
    );
    expect(japanese).toContain('aria-label="Triage さんをメンション"');
    expect(japanese).not.toContain('Ann');
  });

  it('draws each thread once with its reply count, the author and the body without raw HTML', () => {
    const root = {
      id: 'r1',
      created_at: '2026-10-01T09:00:00.000Z',
      created_by: ANN,
      room: ROOM,
      body: 'Hello **team** <img src=x onerror=alert(1)>',
      attachments: ['abcdef0123456789'],
    };
    const reply = {
      id: 'r2',
      created_at: '2026-10-01T09:01:00.000Z',
      created_by: 'agent-triage',
      room: ROOM,
      body: 'On it',
      thread_root: 'r1',
    };
    const html = renderToStaticMarkup(
      <ChannelMessageList
        threads={[{ root, replies: [reply] }]}
        context={{ fields, members, strings: en, locale: 'en' }}
        onOpenThread={() => undefined}
      />,
    );
    expect(html).toContain('<strong>Ann</strong>');
    expect(html).toContain('<strong>team</strong>');
    expect(html).not.toContain('<img');
    expect(html).toContain('Open thread, 1 reply');
    expect(html).toContain('abcdef01');
    expect(html).not.toContain('On it');
  });

  it('names who is here, or says no one is', () => {
    expect(
      renderToStaticMarkup(<PresenceRow present={[ANN]} members={members} strings={en} />),
    ).toContain('Here now: </span>Ann');
    expect(
      renderToStaticMarkup(<PresenceRow present={[]} members={members} strings={ja} />),
    ).toContain(ja.nobodyHere);
  });
});
