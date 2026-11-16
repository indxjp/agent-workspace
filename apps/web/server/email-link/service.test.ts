import type { DemoEntrySlug } from '@indx-workspace/contracts/demo';
import { EMAIL_LINK_TTL_SECONDS } from '@indx-workspace/contracts/email-link';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fixedClock } from '../clock';
import { hashApiKeySecret } from '../identity';
import { counterIds } from '../ids';
import { MemoryLoginTokenStore } from './adapters/login-tokens/memory';
import { FakeChallengeVerifier } from './adapters/challenge/fake';
import { createDisposableEmailList } from './adapters/disposable/disposable';
import { FakeEmailLinkSender } from './adapters/sender/fake';
import { EMAIL_LINK_ADDRESS_WINDOW_MS } from './core/rules';
import type { GuestBinding, GuestWorkspaceBinder } from './ports';
import { createEmailLinkServiceFrom } from './service';

const IDENTITY = { trustedProxyHops: 1, sessionSecret: 'a-session-secret-of-at-least-32-bytes!!' };
const BASE_URL = 'https://store.example.test';
const EMAIL = 'visitor@example.com';
const PASS = 'challenge-answer';
const ENTRY = 'invoice-checker' as DemoEntrySlug;
const START = '2026-11-16T10:00:00.000Z';

const from = (ip: string) => new Headers({ 'x-forwarded-for': ip });

class FakeBinder implements GuestWorkspaceBinder {
  public readonly calls: { email: string; now: Date; entry?: DemoEntrySlug }[] = [];
  public knownEntries: readonly string[] = [ENTRY];
  public failWith: Error | null = null;
  public refuseAsRealAccount = false;
  public bind(input: {
    email: string;
    now: Date;
    entry?: DemoEntrySlug;
  }): Promise<GuestBinding | null> {
    if (this.refuseAsRealAccount) return Promise.resolve(null);
    if (this.failWith !== null) return Promise.reject(this.failWith);
    this.calls.push(input);
    return Promise.resolve({
      userId: '00000000-0000-4000-8000-0000000000a1',
      workspaceId: '00000000-0000-4000-8000-0000000000b1',
      workspaceSlug: 'demo-1',
      created: this.calls.length === 1,
    });
  }
  public hasEntry(entry: DemoEntrySlug): Promise<boolean> {
    return Promise.resolve(this.knownEntries.includes(entry));
  }
}

function setup(options: { sender?: boolean; baseUrl?: string | null; challenge?: boolean } = {}) {
  const clock = fixedClock(START);
  const store = new MemoryLoginTokenStore();
  const sender = new FakeEmailLinkSender();
  const binder = new FakeBinder();
  const verifier = new FakeChallengeVerifier(PASS);
  const service = createEmailLinkServiceFrom({
    clock,
    ids: counterIds(),
    clientIdentity: IDENTITY,
    store,
    binder,
    sender: options.sender === false ? null : sender,
    linkBaseUrl: options.baseUrl === undefined ? BASE_URL : options.baseUrl,
    challenge: options.challenge === false ? null : verifier,
    disposable: createDisposableEmailList(),
  });
  const issue = (
    email = EMAIL,
    ip = '203.0.113.1',
    extra: { challenge?: string; entry?: DemoEntrySlug } = {},
  ) =>
    service.issue({
      email,
      challenge: extra.challenge ?? PASS,
      headers: from(ip),
      ...(extra.entry === undefined ? {} : { entry: extra.entry }),
    });
  /** The secret the fake sender was handed, read back from the link's fragment. */
  const lastToken = () => {
    const message = sender.messages.at(-1);
    if (message === undefined) throw new Error('no message was sent');
    return new URLSearchParams(new URL(message.link).hash.slice(1)).get('token') ?? '';
  };
  const verify = (token = lastToken(), email = EMAIL, ip = '203.0.113.9', entry?: DemoEntrySlug) =>
    service.verify({ email, token, headers: from(ip), ...(entry === undefined ? {} : { entry }) });
  return { clock, store, sender, binder, verifier, service, issue, verify, lastToken };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('issue', () => {
  it('sends one link to the address and answers sent', async () => {
    const { issue, sender, clock } = setup();
    await expect(issue()).resolves.toEqual({ kind: 'issued', body: { status: 'sent' } });
    expect(sender.messages).toHaveLength(1);
    const [message] = sender.messages;
    expect(message?.to).toBe(EMAIL);
    expect(message?.expiresAt.getTime()).toBe(
      clock.now().getTime() + EMAIL_LINK_TTL_SECONDS * 1000,
    );
    const link = new URL(message?.link ?? '');
    expect(link.origin + link.pathname).toBe(`${BASE_URL}/sign-in`);
    expect(link.search).toBe('');
    const fragment = new URLSearchParams(link.hash.slice(1));
    expect(fragment.get('token')).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(fragment.get('email')).toBe(EMAIL);
  });

  it('lower-cases the address and mints a different secret each time', async () => {
    const { issue, sender, lastToken } = setup();
    await issue('Visitor@Example.COM');
    const first = lastToken();
    await issue('visitor@example.com');
    expect(sender.messages.map((m) => m.to)).toEqual([EMAIL, EMAIL]);
    expect(lastToken()).not.toBe(first);
  });

  it('answers 503 email_link_unavailable with no sender, no base url and no challenge', async () => {
    for (const options of [{ sender: false }, { baseUrl: null }, { challenge: false }]) {
      const { issue, store } = setup(options);
      await expect(issue()).resolves.toEqual({ kind: 'refused', code: 'email_link_unavailable' });
      expect(store.snapshot()).toHaveLength(0);
    }
  });

  it('answers the same sent when the sender fails, and stores nothing for it', async () => {
    const { issue, sender, store } = setup();
    sender.failWith(new Error('provider down'));
    await expect(issue()).resolves.toMatchObject({ kind: 'issued' });
    expect(store.snapshot()).toHaveLength(0);
  });

  it('limits a client to 5 requests a minute and says when to retry', async () => {
    const { issue, clock, sender } = setup();
    for (let i = 0; i < 5; i += 1) {
      await expect(issue(`p${i}@example.com`)).resolves.toMatchObject({ kind: 'issued' });
    }
    const refused = await issue('p9@example.com');
    expect(refused).toMatchObject({ kind: 'refused', code: 'email_link_rate_limited' });
    expect(refused.kind === 'refused' ? refused.retryAfterSeconds : 0).toBeGreaterThan(0);
    expect(sender.messages).toHaveLength(5);
    // another client is unaffected, and the first one is admitted again a minute later
    await expect(issue('p9@example.com', '203.0.113.77')).resolves.toMatchObject({
      kind: 'issued',
    });
    clock.advance(60_000);
    await expect(issue('p10@example.com')).resolves.toMatchObject({ kind: 'issued' });
  });

  it('sends an address at most 3 links in 15 minutes, with the same answer for the fourth', async () => {
    const { issue, sender, clock } = setup();
    const answers = [];
    for (let i = 0; i < 4; i += 1) {
      answers.push(await issue(EMAIL, `203.0.113.${i + 1}`));
      clock.advance(1000);
    }
    expect(answers.every((answer) => answer.kind === 'issued')).toBe(true);
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(sender.messages).toHaveLength(3);
    clock.advance(EMAIL_LINK_ADDRESS_WINDOW_MS);
    await issue(EMAIL, '203.0.113.50');
    expect(sender.messages).toHaveLength(4);
  });

  it('answers a refused address exactly as it answers a new one', async () => {
    const { issue, clock } = setup();
    const fresh = await issue('new@example.com', '203.0.113.20');
    for (let i = 0; i < 3; i += 1) {
      await issue(EMAIL, `203.0.113.${30 + i}`);
      clock.advance(1);
    }
    expect(await issue(EMAIL, '203.0.113.40')).toEqual(fresh);
  });

  it('never sends an address more than 3 links when requests for it race from many clients', async () => {
    const { issue, sender, store } = setup();
    await Promise.all(Array.from({ length: 12 }, (_, i) => issue(EMAIL, `198.51.100.${i + 1}`)));
    expect(sender.messages).toHaveLength(3);
    expect(store.snapshot()).toHaveLength(3);
  });

  describe('the sign-up challenge', () => {
    it('sends a link when the answer passes, and hands the verifier the answer and headers', async () => {
      const { issue, sender, verifier } = setup();
      await expect(issue()).resolves.toMatchObject({ kind: 'issued' });
      expect(sender.messages).toHaveLength(1);
      expect(verifier.calls.map((call) => call.answer)).toEqual([PASS]);
      expect(verifier.calls[0]?.headers.get('x-forwarded-for')).toBe('203.0.113.1');
    });

    it('answers 403 email_link_challenge_failed for a wrong answer and sends and stores nothing', async () => {
      const { issue, sender, store } = setup();
      await expect(issue(EMAIL, '203.0.113.1', { challenge: 'wrong' })).resolves.toEqual({
        kind: 'refused',
        code: 'email_link_challenge_failed',
      });
      expect(sender.messages).toHaveLength(0);
      expect(store.snapshot()).toHaveLength(0);
    });

    it('is checked after the per-IP limit, so a flooding client is not given free challenge checks', async () => {
      const { issue, verifier } = setup();
      for (let i = 0; i < 5; i += 1) await issue(`p${i}@example.com`);
      const checked = verifier.calls.length;
      await expect(
        issue('p9@example.com', '203.0.113.1', { challenge: 'wrong' }),
      ).resolves.toMatchObject({ kind: 'refused', code: 'email_link_rate_limited' });
      expect(verifier.calls).toHaveLength(checked);
    });

    it('is checked before the address, so the answer does not say whether an address is disposable', async () => {
      const { issue } = setup();
      await expect(
        issue('a@mailinator.com', '203.0.113.1', { challenge: 'wrong' }),
      ).resolves.toEqual({ kind: 'refused', code: 'email_link_challenge_failed' });
    });
  });

  describe('the disposable-email blocklist', () => {
    it.each(['a@mailinator.com', 'A@MAILINATOR.COM', 'a@mx.mailinator.com', 'a@Sub.Yopmail.com'])(
      'answers 422 email_link_address_refused for %s and sends and stores nothing',
      async (address) => {
        const { issue, sender, store } = setup();
        await expect(issue(address)).resolves.toEqual({
          kind: 'refused',
          code: 'email_link_address_refused',
        });
        expect(sender.messages).toHaveLength(0);
        expect(store.snapshot()).toHaveLength(0);
      },
    );

    it('lets an address on a similar-looking domain through', async () => {
      const { issue, sender } = setup();
      await issue('a@notmailinator.com');
      expect(sender.messages).toHaveLength(1);
    });
  });

  describe('the demo entry', () => {
    it('is carried in the link fragment', async () => {
      const { issue, sender } = setup();
      await issue(EMAIL, '203.0.113.1', { entry: ENTRY });
      const fragment = new URLSearchParams(new URL(sender.messages[0]?.link ?? '').hash.slice(1));
      expect(fragment.get('entry')).toBe(ENTRY);
    });

    it('is absent from the fragment when none was chosen', async () => {
      const { issue, sender } = setup();
      await issue();
      expect(new URL(sender.messages[0]?.link ?? '').hash).not.toContain('entry');
    });

    it('answers 404 demo_entry_unavailable for an entry with no demo, before anything is sent or stored', async () => {
      const { issue, sender, store } = setup();
      await expect(issue(EMAIL, '203.0.113.1', { entry: 'no-such-demo' })).resolves.toEqual({
        kind: 'refused',
        code: 'demo_entry_unavailable',
      });
      expect(sender.messages).toHaveLength(0);
      expect(store.snapshot()).toHaveLength(0);
    });

    it('is checked after the disposable list and before the per-address limit', async () => {
      const { issue } = setup();
      await expect(
        issue('a@mailinator.com', '203.0.113.1', { entry: 'no-such-demo' }),
      ).resolves.toEqual({ kind: 'refused', code: 'email_link_address_refused' });
      for (let i = 0; i < 3; i += 1) await issue(EMAIL, `203.0.113.${i + 10}`);
      await expect(issue(EMAIL, '203.0.113.99', { entry: 'no-such-demo' })).resolves.toEqual({
        kind: 'refused',
        code: 'demo_entry_unavailable',
      });
    });
  });
});

describe('verify', () => {
  it('hands the chosen entry to the binder', async () => {
    const { issue, verify, binder } = setup();
    await issue(EMAIL, '203.0.113.1', { entry: ENTRY });
    await expect(verify(undefined, EMAIL, '203.0.113.9', ENTRY)).resolves.toMatchObject({
      kind: 'verified',
    });
    expect(binder.calls).toEqual([{ email: EMAIL, now: new Date(START), entry: ENTRY }]);
  });

  it('answers 404 demo_entry_unavailable for an unknown entry and leaves the link usable', async () => {
    const { issue, verify, binder } = setup();
    await issue();
    await expect(verify(undefined, EMAIL, '203.0.113.9', 'no-such-demo')).resolves.toEqual({
      kind: 'refused',
      code: 'demo_entry_unavailable',
    });
    expect(binder.calls).toHaveLength(0);
    await expect(verify()).resolves.toMatchObject({ kind: 'verified' });
  });

  it('consumes the link, binds the guest and returns the binding', async () => {
    const { issue, verify, binder } = setup();
    await issue();
    const result = await verify();
    expect(result).toEqual({
      kind: 'verified',
      body: {
        workspaceId: '00000000-0000-4000-8000-0000000000b1',
        workspaceSlug: 'demo-1',
        role: 'guest',
        created: true,
      },
      binding: {
        userId: '00000000-0000-4000-8000-0000000000a1',
        workspaceId: '00000000-0000-4000-8000-0000000000b1',
        workspaceSlug: 'demo-1',
        created: true,
      },
      email: EMAIL,
    });
    expect(binder.calls).toEqual([{ email: EMAIL, now: new Date(START) }]);
  });

  it('refuses a reused link with email_link_invalid and binds nothing the second time', async () => {
    const { issue, verify, binder } = setup();
    await issue();
    await verify();
    await expect(verify()).resolves.toEqual({ kind: 'refused', code: 'email_link_invalid' });
    expect(binder.calls).toHaveLength(1);
  });

  it('refuses an expired link', async () => {
    const { issue, verify, clock, binder } = setup();
    await issue();
    clock.advance(EMAIL_LINK_TTL_SECONDS * 1000);
    await expect(verify()).resolves.toEqual({ kind: 'refused', code: 'email_link_invalid' });
    expect(binder.calls).toHaveLength(0);
  });

  it('accepts a link one second before it expires', async () => {
    const { issue, verify, clock } = setup();
    await issue();
    clock.advance(EMAIL_LINK_TTL_SECONDS * 1000 - 1000);
    await expect(verify()).resolves.toMatchObject({ kind: 'verified' });
  });

  it('refuses a tampered token and a malformed one with the same answer', async () => {
    const { issue, verify, lastToken, binder } = setup();
    await issue();
    const token = lastToken();
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    const answers = [await verify(tampered), await verify('short'), await verify('')];
    for (const answer of answers) {
      expect(answer).toEqual({ kind: 'refused', code: 'email_link_invalid' });
    }
    expect(binder.calls).toHaveLength(0);
    await expect(verify(token)).resolves.toMatchObject({ kind: 'verified' });
  });

  it('refuses a link opened for another address, and leaves it usable by its own', async () => {
    const { issue, verify, lastToken } = setup();
    await issue();
    await expect(verify(lastToken(), 'other@example.com')).resolves.toEqual({
      kind: 'refused',
      code: 'email_link_invalid',
    });
    await expect(verify(lastToken(), 'VISITOR@example.com')).resolves.toMatchObject({
      kind: 'verified',
    });
  });

  it('limits a client to 10 verifications a minute', async () => {
    const { verify } = setup();
    for (let i = 0; i < 10; i += 1) await verify('x'.repeat(43));
    const refused = await verify('x'.repeat(43));
    expect(refused).toMatchObject({ kind: 'refused', code: 'email_link_rate_limited' });
    expect(refused.kind === 'refused' ? refused.retryAfterSeconds : 0).toBeGreaterThan(0);
  });

  it('answers the one invalid-link refusal for an address that holds a real membership', async () => {
    const { issue, verify, binder } = setup();
    await issue();
    binder.refuseAsRealAccount = true;
    const outcome = await verify();
    expect(outcome.kind === 'refused' ? outcome.code : outcome.kind).toBe('email_link_invalid');
  });

  it('lets a binder failure surface, the link already consumed', async () => {
    const { issue, verify, binder } = setup();
    await issue();
    binder.failWith = new Error('database down');
    await expect(verify()).rejects.toThrow('database down');
  });
});

describe('what is stored and logged', () => {
  it('never holds or logs the raw token or the address', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    const { issue, verify, store, lastToken } = setup();
    await issue();
    const token = lastToken();
    await verify();
    await verify();

    const [row] = store.snapshot();
    expect(row).toBeDefined();
    const stored = JSON.stringify(store.snapshot());
    expect(stored).not.toContain(token);
    expect(stored.toLowerCase()).not.toContain(EMAIL);
    expect(row?.tokenHash).toBe(await hashApiKeySecret(token));
    expect(row?.emailHash).toBe(await hashApiKeySecret(EMAIL));
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/u);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('writes row ids from the id generator and times from the clock', async () => {
    const { issue, store, clock } = setup();
    await issue();
    const [row] = store.snapshot();
    expect(row?.id).toBe(counterIds().newId());
    expect(row?.createdAt).toEqual(new Date(START));
    expect((row?.expiresAt.getTime() ?? 0) - clock.now().getTime()).toBe(
      EMAIL_LINK_TTL_SECONDS * 1000,
    );
  });
});
