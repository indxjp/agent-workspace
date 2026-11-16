import { describe, expect, it } from 'vitest';

import { FakeEmailLinkSender } from './fake';
import { createEmailLinkSender } from './production';

describe('createEmailLinkSender', () => {
  it.each([null, '', '   '])('returns null for an unset sender (%j)', (name) => {
    expect(createEmailLinkSender(name)).toBeNull();
  });

  it('refuses a name no provider answers to', () => {
    expect(() => createEmailLinkSender('smtp')).toThrow(/AW_EMAIL_LINK_SENDER "smtp"/u);
    expect(() => createEmailLinkSender('constructor')).toThrow(/not a known email-link sender/u);
  });
});

describe('FakeEmailLinkSender', () => {
  const message = {
    to: 'a@example.com',
    link: 'https://x.test/sign-in#token=t',
    expiresAt: new Date('2026-11-16T10:15:00.000Z'),
  };

  it('records what it is given and can be made to fail', async () => {
    const sender = new FakeEmailLinkSender();
    await sender.send(message);
    expect(sender.messages).toEqual([message]);
    sender.failWith(new Error('down'));
    await expect(sender.send(message)).rejects.toThrow('down');
    expect(sender.messages).toHaveLength(1);
  });
});
