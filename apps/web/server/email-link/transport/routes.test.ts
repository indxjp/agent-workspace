/**
 * The email-link routes (spec §21, "Guest"), driven as the framework drives them: a real `Request`
 * in, a real `Response` out, over the service, the binder and the directory that ship. The stores
 * are the memory adapters, the sender the fake that records messages, and time is a `fixedClock`.
 *
 * The last block runs the same sign-in over a real PostgreSQL and asks `GET /api/me`, through the
 * production session resolver, who the cookie signs in as.
 */
import crypto from 'node:crypto';

import type { DemoEntrySlug } from '@indx-workspace/contracts/demo';
import { EMAIL_LINK_TTL_SECONDS } from '@indx-workspace/contracts/email-link';
import { openDatabaseRoot, type DatabaseRoot } from '@agent-workspace/core/db';
import {
  createIsolatedTestDatabase,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GET as getMe } from '../../../app/api/me/route';
import { POST as postIssue } from '../../../app/api/auth/email-link/route';
import { POST as postVerify } from '../../../app/api/auth/email-link/verify/route';
import { clearApplicationContext } from '../../application-context';
import { installTestDomains } from '../../application-context-fixtures';
import { sessionCookieName, verifySessionToken } from '../../auth';
import { cookieValue } from '../../auth/cookies';
import { fixedClock, type FixedClock } from '../../clock';
import { counterIds } from '../../ids';
import { createMemoryGuestWorkspaceBinder } from '../adapters/guest-workspace/memory';
import { createGuestWorkspaceBinder } from '../adapters/guest-workspace/production';
import { FakeChallengeVerifier } from '../adapters/challenge/fake';
import { createDisposableEmailList } from '../adapters/disposable/disposable';
import { MemoryLoginTokenStore } from '../adapters/login-tokens/memory';
import { FakeEmailLinkSender } from '../adapters/sender/fake';
import type { EmailLinkService } from '../ports';
import { createEmailLinkServiceFrom } from '../service';
import { issueEmailLink, verifyEmailLink, type EmailLinkRuntime } from './routes';
import { asOwner } from '../../rbac/directory.test-support';
import { Principal } from '../../rbac/principal';
import { createPostgresDirectory } from '../../rbac/postgres-directory';
import type { DirectoryRoot } from '../../rbac/directory';

const SECRET = 'an-email-link-route-test-session-secret-long-enough';
const HOST = 'store.example.test';
const T0 = '2026-11-16T09:00:00.000Z';

interface Rig {
  readonly clock: FixedClock;
  readonly sender: FakeEmailLinkSender;
  readonly store: MemoryLoginTokenStore;
  readonly directory: DirectoryRoot;
  readonly runtime: EmailLinkRuntime;
}

type Overrides = {
  readonly sender?: FakeEmailLinkSender | null;
  readonly linkBaseUrl?: string | null;
  readonly challenge?: boolean;
  /** The entries the binder says have a demo template. */
  readonly entries?: readonly string[];
};

function rig(overrides: Overrides = {}): Rig {
  const clock = fixedClock(T0);
  const ids = counterIds();
  const sender = overrides.sender === null ? null : (overrides.sender ?? new FakeEmailLinkSender());
  const store = new MemoryLoginTokenStore();
  const memory = createMemoryGuestWorkspaceBinder({ ids });
  const { directory } = memory;
  const entries = overrides.entries ?? [];
  const binder = {
    bind: (input: Parameters<typeof memory.binder.bind>[0]) => memory.binder.bind(input),
    hasEntry: (entry: DemoEntrySlug) => Promise.resolve(entries.includes(entry)),
  };
  const service: EmailLinkService = createEmailLinkServiceFrom({
    clock,
    ids,
    clientIdentity: { trustedProxyHops: 1, sessionSecret: SECRET },
    store,
    binder,
    sender,
    linkBaseUrl: overrides.linkBaseUrl === undefined ? `https://${HOST}` : overrides.linkBaseUrl,
    challenge: overrides.challenge === false ? null : new FakeChallengeVerifier(CHALLENGE),
    disposable: createDisposableEmailList(),
  });
  return {
    clock,
    sender: sender ?? new FakeEmailLinkSender(),
    store,
    directory,
    runtime: { kind: 'ready', service, clock },
  };
}

let nextClient = 0;
/** A client address no other test in this file uses, as a trusted proxy would report it. */
function client(): string {
  nextClient += 1;
  return `203.0.113.${String(nextClient)}`;
}

function post(
  path: string,
  body: unknown,
  options: { readonly ip: string; readonly origin?: string | null; readonly raw?: string } = {
    ip: client(),
  },
): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': options.ip,
  };
  const origin = options.origin === undefined ? `https://${HOST}` : options.origin;
  if (origin !== null) headers['origin'] = origin;
  return new Request(`https://${HOST}${path}`, {
    method: 'POST',
    headers,
    body: options.raw ?? JSON.stringify(body),
  });
}

/** The one answer the fake challenge verifier passes. */
const CHALLENGE = 'challenge-answer';

const issue = (
  runtime: EmailLinkRuntime | null,
  email: string,
  ip = client(),
  extra: { readonly challenge?: string; readonly entry?: string } = {},
) =>
  issueEmailLink(
    post('/api/auth/email-link', { email, consent: true, challenge: CHALLENGE, ...extra }, { ip }),
    runtime,
  );

const verify = (
  runtime: EmailLinkRuntime | null,
  body: { email: string; token: string; entry?: string },
  ip = client(),
  secret: string | null = SECRET,
) => verifyEmailLink(post('/api/auth/email-link/verify', body, { ip }), runtime, secret);

/** The `token` the link in the last message carries. */
function tokenOf(sender: FakeEmailLinkSender): string {
  const message = sender.messages.at(-1);
  if (message === undefined) throw new Error('no link was sent');
  const token = new URLSearchParams(new URL(message.link).hash.slice(1)).get('token');
  if (token === null) throw new Error('the link carries no token');
  return token;
}

async function problem(response: Response): Promise<{ status: number; code: string }> {
  const body = (await response.json()) as { error: { code: string } };
  return { status: response.status, code: body.error.code };
}

describe('POST /api/auth/email-link', () => {
  it('answers 202 { status: "sent" } for an unknown, a known and a refused address alike', async () => {
    const { runtime, sender, clock } = rig();
    const answers: { status: number; body: unknown }[] = [];
    const ask = async (email: string) => {
      const response = await issue(runtime, email);
      answers.push({ status: response.status, body: await response.json() });
    };
    await ask('unknown@example.test');
    // A known address: it signed in before, so it has a user and a demo workspace.
    await ask('known@example.test');
    const token = tokenOf(sender);
    expect((await verify(runtime, { email: 'known@example.test', token })).status).toBe(200);
    clock.advance(60_000);
    await ask('known@example.test');
    // A refused address: the per-address limit (three links in fifteen minutes) is spent.
    await ask('flood@example.test');
    await ask('flood@example.test');
    await ask('flood@example.test');
    const before = sender.messages.length;
    await ask('flood@example.test');
    expect(sender.messages.length).toBe(before);
    expect(answers.length).toBeGreaterThan(5);
    for (const answer of answers) {
      expect(answer).toEqual({ status: 202, body: { status: 'sent' } });
    }
  });

  it('sends the link to the lower-cased address and carries the secret only in the message', async () => {
    const { runtime, sender, store } = rig();
    const response = await issue(runtime, '  Person@Example.TEST ');
    expect(response.status).toBe(202);
    expect(await response.text()).not.toContain(tokenOf(sender));
    expect(sender.messages.at(-1)?.to).toBe('person@example.test');
    expect(JSON.stringify(store.snapshot())).not.toContain(tokenOf(sender));
  });

  it.each([
    ['a body that is not JSON', { raw: '{not json' }],
    ['no body', { raw: '' }],
    ['an array', { raw: '[]' }],
    ['no email', { raw: '{}' }],
    ['an email that is not an address', { raw: '{"email":"nobody"}' }],
    ['an unknown key', { raw: '{"email":"a@example.test","role":"owner"}' }],
    ['a non-string email', { raw: '{"email":42}' }],
  ])('answers 400 invalid_body for %s', async (_label, { raw }) => {
    const { runtime, sender } = rig();
    const response = await issueEmailLink(
      post('/api/auth/email-link', undefined, { ip: client(), raw }),
      runtime,
    );
    expect(await problem(response)).toEqual({ status: 400, code: 'invalid_body' });
    expect(sender.messages).toHaveLength(0);
  });

  it.each([
    ['consent absent', { email: 'a@example.test', challenge: CHALLENGE }],
    ['consent false', { email: 'a@example.test', consent: false, challenge: CHALLENGE }],
    [
      'consent the string "true"',
      { email: 'a@example.test', consent: 'true', challenge: CHALLENGE },
    ],
  ])(
    'refuses the sign-up with 400 invalid_body and sends nothing when %s',
    async (_label, body) => {
      const { runtime, sender, store } = rig();
      const response = await issueEmailLink(
        post('/api/auth/email-link', body, { ip: client() }),
        runtime,
      );
      expect(await problem(response)).toEqual({ status: 400, code: 'invalid_body' });
      expect(sender.messages).toHaveLength(0);
      expect(store.snapshot()).toHaveLength(0);
    },
  );

  it('accepts a sign-up from the store origin the deployment names, and refuses any other origin', async () => {
    const { runtime, sender } = rig();
    const shop = 'https://shop.example.test/signin';
    const fromStore = await issueEmailLink(
      post(
        '/api/auth/email-link',
        { email: 'a@example.test', consent: true, challenge: CHALLENGE },
        { ip: client(), origin: 'https://shop.example.test' },
      ),
      runtime,
      shop,
    );
    expect(fromStore.status).toBe(202);
    expect(sender.messages).toHaveLength(1);
    for (const [origin, baseUrl] of [
      ['https://evil.example.test', shop],
      ['https://shop.example.test', null],
    ] as const) {
      const other = await issueEmailLink(
        post(
          '/api/auth/email-link',
          { email: 'b@example.test', consent: true, challenge: CHALLENGE },
          { ip: client(), origin },
        ),
        runtime,
        baseUrl,
      );
      expect(await problem(other), origin).toEqual({ status: 403, code: 'cross_origin' });
    }
    expect(sender.messages).toHaveLength(1);
  });

  it('answers 400 invalid_body for a body that is not JSON content', async () => {
    const { runtime } = rig();
    const request = new Request(`https://${HOST}/api/auth/email-link`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        origin: `https://${HOST}`,
        'x-forwarded-for': client(),
      },
      body: '{"email":"a@example.test"}',
    });
    expect(await problem(await issueEmailLink(request, runtime))).toEqual({
      status: 400,
      code: 'invalid_body',
    });
  });

  it('answers 429 with Retry-After once a client has asked too often', async () => {
    const { runtime } = rig();
    const ip = client();
    for (let index = 0; index < 5; index += 1) {
      expect((await issue(runtime, `person${String(index)}@example.test`, ip)).status).toBe(202);
    }
    const limited = await issue(runtime, 'person5@example.test', ip);
    expect(await problem(limited.clone())).toEqual({
      status: 429,
      code: 'email_link_rate_limited',
    });
    const retryAfter = Number(limited.headers.get('retry-after'));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    // Another client is not affected.
    expect((await issue(runtime, 'person6@example.test')).status).toBe(202);
  });

  it.each([
    ['the sender is unset', { sender: null }],
    ['the base URL is unset', { linkBaseUrl: null }],
  ] as const)('answers 503 email_link_unavailable when %s', async (_label, overrides) => {
    const { runtime, store } = rig(overrides);
    expect(await problem(await issue(runtime, 'person@example.test'))).toEqual({
      status: 503,
      code: 'email_link_unavailable',
    });
    expect(store.snapshot()).toHaveLength(0);
  });

  it('answers 503 email_link_unavailable when the deployment wired no email link', async () => {
    for (const runtime of [null, { kind: 'unavailable' } as const]) {
      expect(await problem(await issue(runtime, 'person@example.test'))).toEqual({
        status: 503,
        code: 'email_link_unavailable',
      });
    }
  });

  it('answers 403 email_link_challenge_failed for a wrong answer and sends nothing', async () => {
    const { runtime, sender, store } = rig();
    expect(
      await problem(await issue(runtime, 'person@example.test', client(), { challenge: 'nope' })),
    ).toEqual({ status: 403, code: 'email_link_challenge_failed' });
    expect(sender.messages).toHaveLength(0);
    expect(store.snapshot()).toHaveLength(0);
  });

  it('answers 400 invalid_body when the challenge answer is missing', async () => {
    const { runtime, sender } = rig();
    const response = await issueEmailLink(
      post('/api/auth/email-link', { email: 'person@example.test' }),
      runtime,
    );
    expect(await problem(response)).toEqual({ status: 400, code: 'invalid_body' });
    expect(sender.messages).toHaveLength(0);
  });

  it('answers 503 email_link_unavailable when no challenge is configured', async () => {
    const { runtime, sender } = rig({ challenge: false });
    expect(await problem(await issue(runtime, 'person@example.test'))).toEqual({
      status: 503,
      code: 'email_link_unavailable',
    });
    expect(sender.messages).toHaveLength(0);
  });

  it('answers 422 email_link_address_refused for a disposable address, subdomain and case included', async () => {
    const { runtime, sender } = rig();
    for (const email of ['a@mailinator.com', 'A@Mailinator.COM', 'a@mx.mailinator.com']) {
      expect(await problem(await issue(runtime, email))).toEqual({
        status: 422,
        code: 'email_link_address_refused',
      });
    }
    expect(sender.messages).toHaveLength(0);
  });

  it('answers 404 demo_entry_unavailable for an entry with no demo, and sends nothing', async () => {
    const { runtime, sender } = rig({ entries: ['invoice-checker'] });
    expect(
      await problem(await issue(runtime, 'person@example.test', client(), { entry: 'no-such' })),
    ).toEqual({ status: 404, code: 'demo_entry_unavailable' });
    expect(sender.messages).toHaveLength(0);
  });

  it('puts the chosen entry in the link fragment, never in the query', async () => {
    const { runtime, sender } = rig({ entries: ['invoice-checker'] });
    expect(
      (await issue(runtime, 'person@example.test', client(), { entry: 'invoice-checker' })).status,
    ).toBe(202);
    const link = new URL(sender.messages[0]?.link ?? '');
    expect(link.search).toBe('');
    expect(new URLSearchParams(link.hash.slice(1)).get('entry')).toBe('invoice-checker');
  });

  it('refuses a cross-origin request and a request with no Origin, sending nothing', async () => {
    const { runtime, sender } = rig();
    for (const origin of ['https://evil.example.test', null]) {
      const response = await issueEmailLink(
        post(
          '/api/auth/email-link',
          { email: 'a@example.test', consent: true, challenge: CHALLENGE },
          { ip: client(), origin },
        ),
        runtime,
      );
      expect(await problem(response)).toEqual({ status: 403, code: 'cross_origin' });
    }
    expect(sender.messages).toHaveLength(0);
  });
});

describe('POST /api/auth/email-link/verify', () => {
  const EMAIL = 'guest@example.test';

  async function sentLink(rigged: Rig, email = EMAIL): Promise<string> {
    expect((await issue(rigged.runtime, email)).status).toBe(202);
    return tokenOf(rigged.sender);
  }

  /** `name=value` of the session cookie a response sets, or `null`. */
  function sessionCookieOf(response: Response): string | null {
    const cookie = response.headers
      .getSetCookie()
      .find((line) => line.startsWith(`${sessionCookieName()}=`));
    return cookie === undefined ? null : (cookie.split(';')[0] ?? null);
  }

  async function membershipsOf(rigged: Rig, email: string) {
    const user = await rigged.directory.findUserByEmail(email);
    return user === null ? [] : rigged.directory.membershipsForUser(user.id);
  }

  it('answers 200 with the demo workspace and sets the session cookie', async () => {
    const rigged = rig();
    const token = await sentLink(rigged);
    const response = await verify(rigged.runtime, { email: EMAIL, token });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as {
      workspaceId: string;
      workspaceSlug: string;
      role: string;
      created: boolean;
    };
    expect(body).toMatchObject({ role: 'guest', created: true });
    expect(body.workspaceSlug).toMatch(/^demo-[0-9a-f]{12}$/u);
    const cookie = sessionCookieOf(response);
    expect(cookie).not.toBeNull();
    const setCookie = response.headers.getSetCookie().join('\n');
    expect(setCookie).toMatch(/HttpOnly/iu);
    expect(setCookie).toMatch(/SameSite=lax/iu);
    const verified = await verifySessionToken(cookie?.split('=').slice(1).join('='), SECRET);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims.sub).toBe(EMAIL);
      expect(verified.claims.ws).toBe(body.workspaceSlug);
    }
  });

  it('signs a guest in so that GET /api/me answers role guest in the demo workspace', async () => {
    const rigged = rig();
    const token = await sentLink(rigged);
    const response = await verify(rigged.runtime, { email: EMAIL, token });
    const body = (await response.json()) as { workspaceId: string; workspaceSlug: string };
    const cookie = sessionCookieOf(response);
    if (cookie === null) throw new Error('no session cookie');
    installTestDomains({
      rbac: {
        directory: rigged.directory,
        identify: async (request) => {
          const value = cookieValue(request.headers.get('cookie'), sessionCookieName());
          const verified = await verifySessionToken(value, SECRET);
          if (!verified.ok) return null;
          const user = await rigged.directory.findUserByEmail(verified.claims.sub);
          if (user === null) return null;
          const held = (await rigged.directory.membershipsForUser(user.id)).find(
            (candidate) => candidate.workspaceSlug === verified.claims.ws,
          );
          if (held === undefined) return null;
          const built = Principal.fromSession(
            verified.claims,
            { id: held.workspaceId, slug: held.workspaceSlug },
            held.role,
            { principalId: held.principalId, userId: user.id, label: user.name },
          );
          return built.ok ? built.principal : null;
        },
      },
    });
    try {
      const me = await getMe(new Request(`https://${HOST}/api/me`, { headers: { cookie } }));
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({
        role: 'guest',
        workspaceId: body.workspaceId,
        kind: 'membership',
      });
    } finally {
      clearApplicationContext();
    }
  });

  it('marks the session it sets as an email-link session', async () => {
    const rigged = rig();
    const response = await verify(rigged.runtime, {
      email: EMAIL,
      token: await sentLink(rigged),
    });
    const cookie = sessionCookieOf(response);
    const verified = await verifySessionToken(
      decodeURIComponent(cookie?.split('=')[1] ?? ''),
      SECRET,
    );
    expect(verified.ok && verified.claims.via).toBe('email_link');
  });

  it('answers 404 demo_entry_unavailable for an unknown entry, sets no cookie, and the link still works after', async () => {
    const rigged = rig({ entries: ['invoice-checker'] });
    const token = await sentLink(rigged);
    const refused = await verify(rigged.runtime, { email: EMAIL, token, entry: 'no-such' });
    expect(await problem(refused)).toEqual({ status: 404, code: 'demo_entry_unavailable' });
    expect(sessionCookieOf(refused)).toBeNull();
    const retry = await verify(rigged.runtime, { email: EMAIL, token, entry: 'invoice-checker' });
    expect(retry.status).toBe(200);
  });

  it('answers 400 email_link_invalid for a reused link and sets no cookie', async () => {
    const rigged = rig();
    const token = await sentLink(rigged);
    expect((await verify(rigged.runtime, { email: EMAIL, token })).status).toBe(200);
    const again = await verify(rigged.runtime, { email: EMAIL, token });
    expect(await problem(again.clone())).toEqual({ status: 400, code: 'email_link_invalid' });
    expect(again.headers.getSetCookie()).toEqual([]);
  });

  it('answers 400 email_link_invalid for an expired link, at the last second and after it', async () => {
    const rigged = rig();
    const token = await sentLink(rigged);
    rigged.clock.advance(EMAIL_LINK_TTL_SECONDS * 1000);
    const expired = await verify(rigged.runtime, { email: EMAIL, token });
    expect(await problem(expired.clone())).toEqual({ status: 400, code: 'email_link_invalid' });
    expect(expired.headers.getSetCookie()).toEqual([]);

    const fresh = rig();
    const live = await sentLink(fresh);
    fresh.clock.advance(EMAIL_LINK_TTL_SECONDS * 1000 - 1);
    expect((await verify(fresh.runtime, { email: EMAIL, token: live })).status).toBe(200);
  });

  it('answers a wrong, a misaddressed and a malformed link with the one same refusal', async () => {
    const rigged = rig();
    const token = await sentLink(rigged);
    const wrong = crypto.randomBytes(32).toString('base64url');
    const answers = await Promise.all([
      verify(rigged.runtime, { email: EMAIL, token: wrong }),
      verify(rigged.runtime, { email: 'other@example.test', token }),
    ]);
    const texts = await Promise.all(answers.map((answer) => answer.text()));
    expect(answers.map((answer) => answer.status)).toEqual([400, 400]);
    expect(new Set(texts).size).toBe(1);
    expect(JSON.parse(texts[0] ?? '{}')).toMatchObject({ error: { code: 'email_link_invalid' } });
    // The right link still works: neither refusal consumed it.
    expect((await verify(rigged.runtime, { email: EMAIL, token })).status).toBe(200);
  });

  it.each([
    ['a token of the wrong shape', '{"email":"a@example.test","token":"short"}'],
    ['no token', '{"email":"a@example.test"}'],
    ['an unknown key', `{"email":"a@example.test","token":"${'a'.repeat(43)}","x":1}`],
  ])('answers 400 invalid_body for %s', async (_label, raw) => {
    const { runtime } = rig();
    const response = await verifyEmailLink(
      post('/api/auth/email-link/verify', undefined, { ip: client(), raw }),
      runtime,
      SECRET,
    );
    expect(await problem(response)).toEqual({ status: 400, code: 'invalid_body' });
  });

  it('answers 429 with Retry-After beyond ten attempts a minute from one client', async () => {
    const { runtime } = rig();
    const ip = client();
    const body = { email: EMAIL, token: crypto.randomBytes(32).toString('base64url') };
    for (let index = 0; index < 10; index += 1) {
      expect((await verify(runtime, body, ip)).status).toBe(400);
    }
    const limited = await verify(runtime, body, ip);
    expect(await problem(limited.clone())).toEqual({
      status: 429,
      code: 'email_link_rate_limited',
    });
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('answers 503 when no session secret is configured or no email link is wired', async () => {
    const rigged = rig();
    const token = await sentLink(rigged);
    const noSecret = await verify(rigged.runtime, { email: EMAIL, token }, client(), null);
    expect(await problem(noSecret)).toEqual({ status: 503, code: 'email_link_unavailable' });
    expect(await problem(await verify(null, { email: EMAIL, token }))).toEqual({
      status: 503,
      code: 'email_link_unavailable',
    });
    // The refusal consumed nothing: the link still opens once the secret is there.
    expect((await verify(rigged.runtime, { email: EMAIL, token })).status).toBe(200);
  });

  it('refuses a cross-origin request before it reads the link', async () => {
    const rigged = rig();
    const token = await sentLink(rigged);
    const response = await verifyEmailLink(
      post(
        '/api/auth/email-link/verify',
        { email: EMAIL, token },
        { ip: client(), origin: 'https://evil.example.test' },
      ),
      rigged.runtime,
      SECRET,
    );
    expect(await problem(response)).toEqual({ status: 403, code: 'cross_origin' });
    expect((await verify(rigged.runtime, { email: EMAIL, token })).status).toBe(200);
  });

  it('returns the same demo workspace within 24 hours and makes a new one after', async () => {
    const rigged = rig();
    const open = async () => {
      const token = await sentLink(rigged);
      const response = await verify(rigged.runtime, { email: EMAIL, token });
      expect(response.status).toBe(200);
      return (await response.json()) as { workspaceId: string; created: boolean };
    };
    const first = await open();
    rigged.clock.advance(3_600_000);
    const second = await open();
    expect(second).toEqual({ ...first, created: false });
    rigged.clock.advance(24 * 3_600_000);
    const third = await open();
    expect(third.created).toBe(true);
    expect(third.workspaceId).not.toBe(first.workspaceId);
  });

  it.each(['owner', 'admin', 'builder', 'viewer'] as const)(
    'answers 400 email_link_invalid and sets no cookie for an address that holds a real %s membership',
    async (role) => {
      const rigged = rig();
      await rigged.directory
        .forWorkspace('00000000-0000-4000-8000-0000000000c1')
        .createUser({ email: EMAIL, name: 'Real', role: asOwner(role) });
      const workspacesBefore = await membershipsOf(rigged, EMAIL);
      const token = await sentLink(rigged);
      const response = await verify(rigged.runtime, { email: EMAIL, token });
      expect(await problem(response)).toEqual({ status: 400, code: 'email_link_invalid' });
      expect(sessionCookieOf(response)).toBeNull();
      // Nothing was bound: no demo workspace was made and the real membership is unchanged.
      expect(await membershipsOf(rigged, EMAIL)).toEqual(workspacesBefore);
    },
  );

  it('wires the binder it was given: the route answers from the binding, not from the request', async () => {
    const rigged = rig();
    const token = await sentLink(rigged);
    const response = await verify(rigged.runtime, { email: EMAIL.toUpperCase(), token });
    expect(response.status).toBe(200);
    const user = await rigged.directory.findUserByEmail(EMAIL);
    expect(user?.email).toBe(EMAIL);
  });
});

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describe.skipIf(!hasDatabase)('email-link sign-in over a real PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;
  let database: DatabaseRoot;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_email_link_routes');
    database = await openDatabaseRoot({ DATABASE_URL: isolated.url });
  }, 180_000);

  afterAll(async () => {
    await database.close();
    await isolated.close();
  });

  beforeEach(() => {
    clearApplicationContext();
  });
  afterEach(() => {
    clearApplicationContext();
  });

  it('signs the guest in so that the production session resolver answers role guest in the demo workspace', async () => {
    const { installRbacApi } = await import('../../composition/session-rbac');
    const installed = await installRbacApi(database, SECRET);
    const directory = createPostgresDirectory(database.directory);
    const clock = fixedClock(new Date());
    const ids = { newId: () => crypto.randomUUID() };
    const sender = new FakeEmailLinkSender();
    const runtime: EmailLinkRuntime = {
      kind: 'ready',
      clock,
      service: createEmailLinkServiceFrom({
        clock,
        ids,
        clientIdentity: { trustedProxyHops: 1, sessionSecret: SECRET },
        store: new MemoryLoginTokenStore(),
        binder: createGuestWorkspaceBinder({ directory, ids }),
        sender,
        linkBaseUrl: `https://${HOST}`,
        challenge: new FakeChallengeVerifier(CHALLENGE),
        disposable: createDisposableEmailList(),
      }),
    };
    const email = `pg-guest-${crypto.randomUUID().slice(0, 8)}@example.test`;
    expect((await issue(runtime, email)).status).toBe(202);
    const response = await verify(runtime, { email, token: tokenOf(sender) });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { workspaceId: string; workspaceSlug: string };
    const cookie = response.headers
      .getSetCookie()
      .find((line) => line.startsWith(`${sessionCookieName()}=`))
      ?.split(';')[0];
    if (cookie === undefined) throw new Error('no session cookie');

    installTestDomains({ rbac: installed.rbac });
    const me = await getMe(new Request(`https://${HOST}/api/me`, { headers: { cookie } }));
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ role: 'guest', workspaceId: body.workspaceId });
  });
});

// The routes the framework serves are these handlers behind one line each; the line is tested by
// calling it, so a route file that stopped passing the runtime on would fail here.
describe('the route files', () => {
  it('answer 503 until the composition root installs an email link', async () => {
    clearApplicationContext();
    const issued = await postIssue(post('/api/auth/email-link', { email: 'a@example.test' }));
    expect(await problem(issued)).toEqual({ status: 503, code: 'email_link_unavailable' });
    const verified = await postVerify(
      post('/api/auth/email-link/verify', { email: 'a@example.test', token: 'a'.repeat(43) }),
    );
    expect(await problem(verified)).toEqual({ status: 503, code: 'email_link_unavailable' });
  });
});
