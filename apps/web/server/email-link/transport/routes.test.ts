/**
 * The email-link issue route (spec §21, "Guest"), driven as the framework drives it: a real
 * `Request` in, a real `Response` out, over the service, the binder and the directory that ship.
 * The rig is in `routes.test-support.ts`; the verify route and the PostgreSQL sign-in have their
 * own files beside this one.
 */
import { describe, expect, it } from 'vitest';

import { POST as postIssue } from '../../../app/api/auth/email-link/route';
import { POST as postVerify } from '../../../app/api/auth/email-link/verify/route';
import { clearApplicationContext } from '../../application-context';
import { issueEmailLink } from './routes';
import {
  CROSS_ORIGIN,
  HOST,
  INVALID_BODY,
  ISSUE_PATH,
  RATE_LIMITED,
  UNAVAILABLE,
  VERIFY_PATH,
  CHALLENGE,
  client,
  issue,
  post,
  problem,
  rig,
  signUpBody,
  tokenOf,
  verify,
} from './routes.test-support';

describe('POST /api/auth/email-link: the answer', () => {
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

  it('puts the chosen entry in the link fragment, never in the query', async () => {
    const { runtime, sender } = rig({ entries: ['invoice-checker'] });
    expect(
      (await issue(runtime, 'person@example.test', client(), { entry: 'invoice-checker' })).status,
    ).toBe(202);
    const link = new URL(sender.messages[0]?.link ?? '');
    expect(link.search).toBe('');
    expect(new URLSearchParams(link.hash.slice(1)).get('entry')).toBe('invoice-checker');
  });

  it('answers 429 with Retry-After once a client has asked too often', async () => {
    const { runtime } = rig();
    const ip = client();
    for (let index = 0; index < 5; index += 1) {
      expect((await issue(runtime, `person${String(index)}@example.test`, ip)).status).toBe(202);
    }
    const limited = await issue(runtime, 'person5@example.test', ip);
    expect(await problem(limited.clone())).toEqual(RATE_LIMITED);
    const retryAfter = Number(limited.headers.get('retry-after'));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    // Another client is not affected.
    expect((await issue(runtime, 'person6@example.test')).status).toBe(202);
  });
});

describe('POST /api/auth/email-link: the body', () => {
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
      post(ISSUE_PATH, undefined, { ip: client(), raw }),
      runtime,
    );
    expect(await problem(response)).toEqual(INVALID_BODY);
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
      const response = await issueEmailLink(post(ISSUE_PATH, body, { ip: client() }), runtime);
      expect(await problem(response)).toEqual(INVALID_BODY);
      expect(sender.messages).toHaveLength(0);
      expect(store.snapshot()).toHaveLength(0);
    },
  );

  it('answers 400 invalid_body for a body that is not JSON content', async () => {
    const { runtime } = rig();
    const request = new Request(`https://${HOST}${ISSUE_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        origin: `https://${HOST}`,
        'x-forwarded-for': client(),
      },
      body: '{"email":"a@example.test"}',
    });
    expect(await problem(await issueEmailLink(request, runtime))).toEqual(INVALID_BODY);
  });

  it('answers 400 invalid_body when the challenge answer is missing', async () => {
    const { runtime, sender } = rig();
    const response = await issueEmailLink(
      post(ISSUE_PATH, { email: 'person@example.test' }),
      runtime,
    );
    expect(await problem(response)).toEqual(INVALID_BODY);
    expect(sender.messages).toHaveLength(0);
  });
});

describe('POST /api/auth/email-link: the origin', () => {
  it('accepts a sign-up from the store origin the deployment names, and refuses any other origin', async () => {
    const { runtime, sender } = rig();
    const shop = 'https://shop.example.test/signin';
    const fromStore = await issueEmailLink(
      post(ISSUE_PATH, signUpBody('a@example.test'), {
        ip: client(),
        origin: 'https://shop.example.test',
      }),
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
        post(ISSUE_PATH, signUpBody('b@example.test'), { ip: client(), origin }),
        runtime,
        baseUrl,
      );
      expect(await problem(other), origin).toEqual(CROSS_ORIGIN);
    }
    expect(sender.messages).toHaveLength(1);
  });

  it('refuses a cross-origin request and a request with no Origin, sending nothing', async () => {
    const { runtime, sender } = rig();
    for (const origin of ['https://evil.example.test', null]) {
      const response = await issueEmailLink(
        post(ISSUE_PATH, signUpBody('a@example.test'), { ip: client(), origin }),
        runtime,
      );
      expect(await problem(response)).toEqual(CROSS_ORIGIN);
    }
    expect(sender.messages).toHaveLength(0);
  });
});

describe('POST /api/auth/email-link: refusals', () => {
  it.each([
    ['the sender is unset', { sender: null }],
    ['the base URL is unset', { linkBaseUrl: null }],
  ] as const)('answers 503 email_link_unavailable when %s', async (_label, overrides) => {
    const { runtime, store } = rig(overrides);
    expect(await problem(await issue(runtime, 'person@example.test'))).toEqual(UNAVAILABLE);
    expect(store.snapshot()).toHaveLength(0);
  });

  it('answers 503 email_link_unavailable when the deployment wired no email link', async () => {
    for (const runtime of [null, { kind: 'unavailable' } as const]) {
      expect(await problem(await issue(runtime, 'person@example.test'))).toEqual(UNAVAILABLE);
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

  it('answers 503 email_link_unavailable when no challenge is configured', async () => {
    const { runtime, sender } = rig({ challenge: false });
    expect(await problem(await issue(runtime, 'person@example.test'))).toEqual(UNAVAILABLE);
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
});

// The routes the framework serves are these handlers behind one line each; the line is tested by
// calling it, so a route file that stopped passing the runtime on would fail here.
describe('the route files', () => {
  it('answer 503 until the composition root installs an email link', async () => {
    clearApplicationContext();
    const issued = await postIssue(post(ISSUE_PATH, { email: 'a@example.test' }));
    expect(await problem(issued)).toEqual(UNAVAILABLE);
    const verified = await postVerify(
      post(VERIFY_PATH, { email: 'a@example.test', token: 'a'.repeat(43) }),
    );
    expect(await problem(verified)).toEqual(UNAVAILABLE);
  });
});
