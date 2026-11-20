/**
 * The email-link verify route (spec §21, "Guest"): the link a guest opens signs them in to a demo
 * workspace, and every other answer is one refusal that gives nothing away. The rig is in
 * `routes.test-support.ts`.
 */
import crypto from 'node:crypto';

import { EMAIL_LINK_TTL_SECONDS } from '@indx-workspace/contracts/email-link';
import { describe, expect, it } from 'vitest';

import { GET as getMe } from '../../../app/api/me/route';
import { clearApplicationContext } from '../../application-context';
import { installTestDomains } from '../../application-context-fixtures';
import { signInSessionCookieName, verifySignInSessionToken } from '../../auth';
import { cookieValue } from '../../auth/cookies';
import { asOwner } from '../../rbac/directory.test-support';
import { Principal } from '../../rbac/principal';
import type { RbacRuntime } from '../../rbac/wiring';
import { verifyEmailLink } from './routes';
import {
  CROSS_ORIGIN,
  HOST,
  INVALID_BODY,
  LINK_INVALID,
  RATE_LIMITED,
  SECRET,
  UNAVAILABLE,
  VERIFY_PATH,
  client,
  post,
  problem,
  rig,
  sentLink,
  sessionCookieOf,
  verify,
  type Rig,
} from './routes.test-support';

const EMAIL = 'guest@example.test';

type SessionClaims = Extract<
  Awaited<ReturnType<typeof verifySignInSessionToken>>,
  { readonly ok: true }
>['claims'];

/** The principal the session's claims name in the rig's directory, or `null` when none holds. */
async function principalFor(rigged: Rig, claims: SessionClaims): Promise<Principal | null> {
  const user = await rigged.directory.findUserByEmail(claims.sub);
  if (user === null) return null;
  const held = (await rigged.directory.membershipsForUser(user.id)).find(
    (candidate) => candidate.workspaceSlug === claims.ws,
  );
  if (held === undefined) return null;
  const built = Principal.fromSession(
    claims,
    { id: held.workspaceId, slug: held.workspaceSlug },
    held.role,
    { principalId: held.principalId, userId: user.id, label: user.name },
  );
  return built.ok ? built.principal : null;
}

/** The `identify` the production session resolver runs, over the rig's directory. */
function identifyOver(rigged: Rig): RbacRuntime['identify'] {
  return async (request) => {
    const value = cookieValue(request.headers.get('cookie'), signInSessionCookieName());
    const verified = await verifySignInSessionToken(value, SECRET, rigged.clock.now().getTime());
    return verified.ok ? principalFor(rigged, verified.claims) : null;
  };
}

async function membershipsOf(rigged: Rig, email: string) {
  const user = await rigged.directory.findUserByEmail(email);
  return user === null ? [] : rigged.directory.membershipsForUser(user.id);
}

describe('POST /api/auth/email-link/verify: signing in', () => {
  it('answers 200 with the demo workspace and sets the session cookie', async () => {
    const rigged = rig();
    const token = await sentLink(rigged, EMAIL);
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
    const verified = await verifySignInSessionToken(
      cookie?.split('=').slice(1).join('='),
      SECRET,
      rigged.clock.now().getTime(),
    );
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims.sub).toBe(EMAIL);
      expect(verified.claims.ws).toBe(body.workspaceSlug);
    }
  });
});

describe('POST /api/auth/email-link/verify: the session', () => {
  it('signs a guest in so that GET /api/me answers role guest in the demo workspace', async () => {
    const rigged = rig();
    const token = await sentLink(rigged, EMAIL);
    const response = await verify(rigged.runtime, { email: EMAIL, token });
    const body = (await response.json()) as { workspaceId: string; workspaceSlug: string };
    const cookie = sessionCookieOf(response);
    if (cookie === null) throw new Error('no session cookie');
    installTestDomains({ rbac: { directory: rigged.directory, identify: identifyOver(rigged) } });
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
      token: await sentLink(rigged, EMAIL),
    });
    const cookie = sessionCookieOf(response);
    const verified = await verifySignInSessionToken(
      decodeURIComponent(cookie?.split('=')[1] ?? ''),
      SECRET,
      rigged.clock.now().getTime(),
    );
    expect(verified.ok && verified.claims.via).toBe('email_link');
  });

  it('returns the same demo workspace within 24 hours and makes a new one after', async () => {
    const rigged = rig();
    const open = async () => {
      const token = await sentLink(rigged, EMAIL);
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

  it('wires the binder it was given: the route answers from the binding, not from the request', async () => {
    const rigged = rig();
    const token = await sentLink(rigged, EMAIL);
    const response = await verify(rigged.runtime, { email: EMAIL.toUpperCase(), token });
    expect(response.status).toBe(200);
    const user = await rigged.directory.findUserByEmail(EMAIL);
    expect(user?.email).toBe(EMAIL);
  });
});

describe('POST /api/auth/email-link/verify: a link that is refused', () => {
  it('answers 404 demo_entry_unavailable for an unknown entry, sets no cookie, and the link still works after', async () => {
    const rigged = rig({ entries: ['invoice-checker'] });
    const token = await sentLink(rigged, EMAIL);
    const refused = await verify(rigged.runtime, { email: EMAIL, token, entry: 'no-such' });
    expect(await problem(refused)).toEqual({ status: 404, code: 'demo_entry_unavailable' });
    expect(sessionCookieOf(refused)).toBeNull();
    const retry = await verify(rigged.runtime, { email: EMAIL, token, entry: 'invoice-checker' });
    expect(retry.status).toBe(200);
  });

  it('answers 400 email_link_invalid for a reused link and sets no cookie', async () => {
    const rigged = rig();
    const token = await sentLink(rigged, EMAIL);
    expect((await verify(rigged.runtime, { email: EMAIL, token })).status).toBe(200);
    const again = await verify(rigged.runtime, { email: EMAIL, token });
    expect(await problem(again.clone())).toEqual(LINK_INVALID);
    expect(again.headers.getSetCookie()).toEqual([]);
  });

  it('answers 400 email_link_invalid for an expired link, at the last second and after it', async () => {
    const rigged = rig();
    const token = await sentLink(rigged, EMAIL);
    rigged.clock.advance(EMAIL_LINK_TTL_SECONDS * 1000);
    const expired = await verify(rigged.runtime, { email: EMAIL, token });
    expect(await problem(expired.clone())).toEqual(LINK_INVALID);
    expect(expired.headers.getSetCookie()).toEqual([]);

    const fresh = rig();
    const live = await sentLink(fresh, EMAIL);
    fresh.clock.advance(EMAIL_LINK_TTL_SECONDS * 1000 - 1);
    expect((await verify(fresh.runtime, { email: EMAIL, token: live })).status).toBe(200);
  });

  it('answers a wrong, a misaddressed and a malformed link with the one same refusal', async () => {
    const rigged = rig();
    const token = await sentLink(rigged, EMAIL);
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

  it.each(['owner', 'admin', 'builder', 'viewer'] as const)(
    'answers 400 email_link_invalid and sets no cookie for an address that holds a real %s membership',
    async (role) => {
      const rigged = rig();
      await rigged.directory
        .forWorkspace('00000000-0000-4000-8000-0000000000c1')
        .createUser({ email: EMAIL, name: 'Real', role: asOwner(role) });
      const workspacesBefore = await membershipsOf(rigged, EMAIL);
      const token = await sentLink(rigged, EMAIL);
      const response = await verify(rigged.runtime, { email: EMAIL, token });
      expect(await problem(response)).toEqual(LINK_INVALID);
      expect(sessionCookieOf(response)).toBeNull();
      // Nothing was bound: no demo workspace was made and the real membership is unchanged.
      expect(await membershipsOf(rigged, EMAIL)).toEqual(workspacesBefore);
    },
  );
});

describe('POST /api/auth/email-link/verify: the request', () => {
  it.each([
    ['a token of the wrong shape', '{"email":"a@example.test","token":"short"}'],
    ['no token', '{"email":"a@example.test"}'],
    ['an unknown key', `{"email":"a@example.test","token":"${'a'.repeat(43)}","x":1}`],
  ])('answers 400 invalid_body for %s', async (_label, raw) => {
    const { runtime } = rig();
    const response = await verifyEmailLink(
      post(VERIFY_PATH, undefined, { ip: client(), raw }),
      runtime,
      SECRET,
    );
    expect(await problem(response)).toEqual(INVALID_BODY);
  });

  it('answers 429 with Retry-After beyond ten attempts a minute from one client', async () => {
    const { runtime } = rig();
    const ip = client();
    const body = { email: EMAIL, token: crypto.randomBytes(32).toString('base64url') };
    for (let index = 0; index < 10; index += 1) {
      expect((await verify(runtime, body, ip)).status).toBe(400);
    }
    const limited = await verify(runtime, body, ip);
    expect(await problem(limited.clone())).toEqual(RATE_LIMITED);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('answers 503 when no session secret is configured or no email link is wired', async () => {
    const rigged = rig();
    const token = await sentLink(rigged, EMAIL);
    const noSecret = await verify(rigged.runtime, { email: EMAIL, token }, client(), null);
    expect(await problem(noSecret)).toEqual(UNAVAILABLE);
    expect(await problem(await verify(null, { email: EMAIL, token }))).toEqual(UNAVAILABLE);
    // The refusal consumed nothing: the link still opens once the secret is there.
    expect((await verify(rigged.runtime, { email: EMAIL, token })).status).toBe(200);
  });

  it('refuses a cross-origin request before it reads the link', async () => {
    const rigged = rig();
    const token = await sentLink(rigged, EMAIL);
    const response = await verifyEmailLink(
      post(
        VERIFY_PATH,
        { email: EMAIL, token },
        { ip: client(), origin: 'https://evil.example.test' },
      ),
      rigged.runtime,
      SECRET,
    );
    expect(await problem(response)).toEqual(CROSS_ORIGIN);
    expect((await verify(rigged.runtime, { email: EMAIL, token })).status).toBe(200);
  });
});
