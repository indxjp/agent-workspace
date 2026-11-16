import { describe, expect, it } from 'vitest';

import { CHAT_TITLE_MAX, chatTitleFrom, continueChatHref, resumedSessionFrom } from './model';

const SESSION = '33333333-3333-4333-8333-333333333333';

// UX-05 in #2086: the link a recent chat opens, read back by the home page.
describe('continuing a chat from its link', () => {
  it('builds /?session=<id> and reads it back', () => {
    expect(continueChatHref(SESSION)).toBe(`/?session=${SESSION}`);
    expect(resumedSessionFrom({ session: SESSION })).toBe(SESSION);
  });

  it('reads nothing from an absent, repeated or malformed parameter', () => {
    expect(resumedSessionFrom({})).toBeNull();
    expect(resumedSessionFrom({ session: [SESSION, SESSION] })).toBeNull();
    expect(resumedSessionFrom({ session: 'not-a-uuid' })).toBeNull();
    expect(resumedSessionFrom({ session: `${SESSION}x` })).toBeNull();
  });
});

describe("a new chat's title, from its first message", () => {
  it('is one line with its spaces collapsed', () => {
    expect(chatTitleFrom('  Write the Q3\n\nrefunds   report  ')).toBe(
      'Write the Q3 refunds report',
    );
  });

  it('is cut to the maximum with an ellipsis, and kept whole when it fits exactly', () => {
    const exact = 'a'.repeat(CHAT_TITLE_MAX);
    expect(chatTitleFrom(exact)).toBe(exact);
    const long = chatTitleFrom(`${'word '.repeat(40)}end`);
    expect(long).not.toBeNull();
    expect(long?.length).toBeLessThanOrEqual(CHAT_TITLE_MAX);
    expect(long?.endsWith('…')).toBe(true);
  });

  it('is null for a message with no text', () => {
    expect(chatTitleFrom(' \n\t ')).toBeNull();
  });
});
