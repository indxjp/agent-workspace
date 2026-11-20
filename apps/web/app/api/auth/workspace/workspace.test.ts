/**
 * `GET`/`POST /api/auth/workspace` — issue #118's verifier attack, driven against the real route
 * module Next.js calls, with a real in-memory {@link DirectoryRoot} installed the same way
 * `apps/web/app/api/metrics/metrics.test.ts` installs one for its own route.
 *
 * Named `workspace.test.ts`, not `route.test.ts`, for the reason `metrics.test.ts`'s header
 * gives: `tests/route-inventory.policy-check.ts`'s `classifyAppFile` would otherwise read a colocated
 * `route.test.ts` as a second route file. The JSON branch and the email-link marks live in
 * `workspace.json.test.ts` and `workspace.email-link.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  mintSelectionToken,
  selectionCookieName,
  signInSessionCookieName,
} from '../../../../server/auth';

import { GET, POST } from './route';
import {
  HOST,
  MULTI_WORKSPACE_SEED,
  SINGLE_WORKSPACE_SEED,
  U1_EMAIL,
  URL_,
  installDirectory,
  postAsSession,
  request,
  setCookieValue,
  uninstallDirectory,
  viewer,
  SECRET,
} from './workspace.test-support';

const NOT_AVAILABLE_LOCATION = '/api/auth/workspace?error=workspace_not_available';
const SESSION_EXPIRED_LOCATION = '/signin?error=session_expired';
const FOREIGN_ORIGIN = 'https://attacker.example';
const UNSAFE_NEXT_TARGETS = ['//evil.example', 'https://evil.example', '/\\evil.example'];

describe('POST /api/auth/workspace membership', () => {
  let directory: ReturnType<typeof installDirectory>;

  beforeEach(() => {
    directory = installDirectory(MULTI_WORKSPACE_SEED);
  });

  afterEach(uninstallDirectory);

  it('refuses a workspace outside the caller’s memberships — identically by id, by slug, and for one that does not exist', async () => {
    // U1 is a member of A (from the seed) and, added here, of B — so this proves a real "not C"
    // refusal rather than merely "not a member of anything".
    await directory.forWorkspace('ws-b').createMembership({ email: U1_EMAIL, role: viewer });

    const byId = await postAsSession({ workspace: 'ws-c' });
    const bySlug = await postAsSession({ workspace: 'gamma' });
    const unknown = await postAsSession({ workspace: 'no-such-workspace' });

    // All three are the same outcome: no session minted, sent back to the same place — the
    // response must not be an oracle for "exists but not mine" versus "does not exist".
    for (const response of [byId, bySlug, unknown]) {
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe(NOT_AVAILABLE_LOCATION);
      expect(setCookieValue(response, signInSessionCookieName())).toBeUndefined();
    }
    expect(byId.headers.get('location')).toBe(bySlug.headers.get('location'));
    expect(byId.headers.get('location')).toBe(unknown.headers.get('location'));

    // BREAK-IT CHECK (done by hand while writing this test, reverted before commit): replacing
    // the `memberships.find(candidate => candidate.workspaceId === requested || …)` guard in
    // route.ts with `memberships[0]` makes this test fail — U1's own membership in A would then
    // be minted for a request naming C. Restoring the guard makes it pass again, and the diff
    // after reverting is empty.
  });

  it('mints a session for a workspace the caller really belongs to, by slug', async () => {
    const response = await postAsSession({ workspace: 'acme' });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/');
    expect(setCookieValue(response, signInSessionCookieName())).toBeDefined();
  });

  // The `Location` this route answers with carries no origin at all, and that is the whole point:
  // `request.url` is the address this server is *bound* to, and a redirect built from it sends the
  // browser to a different origin than the one it asked — a container port map, a reverse proxy or
  // a `localhost`/`127.0.0.1` alias is enough. The session cookie was set for the origin the caller
  // used, so it is not sent to the other one, and a switch that succeeded arrives signed out.
  it('answers a relative Location, so the redirect stays on the origin the caller actually used', async () => {
    const switched = await postAsSession({ workspace: 'acme' });
    expect(switched.status).toBe(303);
    expect(switched.headers.get('location')).toBe('/');
    // And the cookies still ride on that same response — a relative Location is a header change,
    // not a different response.
    expect(setCookieValue(switched, signInSessionCookieName())).toBeDefined();

    const expired = await POST(request({ method: 'POST', form: { workspace: 'acme' } }));
    expect(expired.status).toBe(303);
    expect(expired.headers.get('location')).toBe(SESSION_EXPIRED_LOCATION);

    // Asserted as whole strings rather than by `.pathname`, because parsing is exactly what hides
    // the defect: `new URL('https://app.example.test/').pathname` is also `/`.
    for (const response of [switched, expired]) {
      expect(response.headers.get('location')).not.toContain(HOST);
      expect(response.headers.get('location')).not.toContain('://');
    }
  });

  it('re-reads membership: a since-removed membership is refused even with a valid selection cookie, and a surviving one still mints', async () => {
    const u1 = await directory.findUserByEmail(U1_EMAIL);
    if (u1 === null) throw new Error('seed missing u1@example.test');
    await directory.forWorkspace('ws-b').createMembership({ email: U1_EMAIL, role: viewer });

    // The selection cookie is minted while B is still a real membership …
    const selection = await mintSelectionToken(u1.id, U1_EMAIL, SECRET);

    // … and then B is removed before the cookie is ever used.
    const bMembership = (await directory.forWorkspace('ws-b').listMemberships()).find(
      (row) => row.email === U1_EMAIL,
    );
    if (bMembership === undefined) throw new Error('membership in B not found');
    await directory.forWorkspace('ws-b').deleteMembership(bMembership.id);

    const postWithSelection = (workspace: string) =>
      POST(
        request({
          method: 'POST',
          cookies: { [selectionCookieName()]: selection },
          form: { workspace },
        }),
      );

    const refused = await postWithSelection('beta');
    expect(refused.status).toBe(303);
    expect(refused.headers.get('location')).toContain('error=workspace_not_available');
    expect(setCookieValue(refused, signInSessionCookieName())).toBeUndefined();

    // A still exists: replaying the SAME selection cookie twice, selecting A, mints a session both
    // times. Neither replay is treated as fatal (the cookie carries no single-use nonce — only a
    // short TTL, which the task card's minimum implementation calls for) and in neither case is a
    // session minted for B, which no longer exists.
    const firstA = await postWithSelection('acme');
    const secondA = await postWithSelection('acme');
    for (const response of [firstA, secondA]) {
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/');
      expect(setCookieValue(response, signInSessionCookieName())).toBeDefined();
    }
  });
});

describe('POST /api/auth/workspace origin and session', () => {
  beforeEach(() => {
    installDirectory(MULTI_WORKSPACE_SEED);
  });

  afterEach(uninstallDirectory);

  it('refuses a cross-origin POST before it ever mints anything', async () => {
    const response = await postAsSession({ workspace: 'acme' }, FOREIGN_ORIGIN);
    expect(response.status).toBe(403);
    expect(setCookieValue(response, signInSessionCookieName())).toBeUndefined();

    // BREAK-IT CHECK (done by hand, reverted before commit): commenting out the `if (!origin.ok)`
    // early return in route.ts makes this test fail — the mismatched Origin stops mattering and a
    // session is minted for `acme` instead of refused. Restoring the check makes it pass again.
  });

  it('refuses with neither a valid session nor a valid selection cookie', async () => {
    const response = await POST(request({ method: 'POST', form: { workspace: 'acme' } }));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(SESSION_EXPIRED_LOCATION);
    expect(setCookieValue(response, signInSessionCookieName())).toBeUndefined();
  });
});

describe('POST /api/auth/workspace next', () => {
  beforeEach(() => {
    installDirectory(MULTI_WORKSPACE_SEED);
  });

  afterEach(uninstallDirectory);

  it('lands on a safe next after the pick, as a relative Location', async () => {
    const response = await postAsSession({
      workspace: 'acme',
      next: '/oauth/authorize?client_id=x&state=y',
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/oauth/authorize?client_id=x&state=y');
    expect(setCookieValue(response, signInSessionCookieName())).toBeDefined();
  });

  it.each(['//evil.example', 'https://evil.example', '/\\evil.example', '/.//evil.example'])(
    'lands on / for the unsafe next %s',
    async (next) => {
      const response = await postAsSession({ workspace: 'acme', next });
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/');
    },
  );

  it('keeps a safe next on the refusal redirect and drops an unsafe one', async () => {
    const post = (next: string) => postAsSession({ workspace: 'no-such-workspace', next });
    const safe = await post('/oauth/authorize?client_id=x');
    expect(safe.headers.get('location')).toBe(
      `${NOT_AVAILABLE_LOCATION}&next=%2Foauth%2Fauthorize%3Fclient_id%3Dx`,
    );
    expect(setCookieValue(safe, signInSessionCookieName())).toBeUndefined();
    const unsafe = await post('//evil.example');
    expect(unsafe.headers.get('location')).toBe(NOT_AVAILABLE_LOCATION);
  });

  it('refuses a cross-origin POST carrying a next before it mints or redirects anywhere', async () => {
    const response = await postAsSession(
      { workspace: 'acme', next: '/oauth/authorize?client_id=x' },
      FOREIGN_ORIGIN,
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('location')).toBeNull();
    expect(setCookieValue(response, signInSessionCookieName())).toBeUndefined();
  });
});

describe('GET /api/auth/workspace', () => {
  let directory: ReturnType<typeof installDirectory>;

  beforeEach(() => {
    directory = installDirectory(SINGLE_WORKSPACE_SEED);
  });

  afterEach(uninstallDirectory);

  /** A GET carrying a valid selection cookie for U1. */
  const selectionRequest = async (): Promise<Request> => {
    const u1 = await directory.findUserByEmail(U1_EMAIL);
    if (u1 === null) throw new Error('seed missing u1@example.test');
    const selection = await mintSelectionToken(u1.id, U1_EMAIL, SECRET);
    return request({ method: 'GET', cookies: { [selectionCookieName()]: selection } });
  };

  it('renders the caller’s current memberships when the selection cookie is valid', async () => {
    const response = await GET(await selectionRequest());
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(U1_EMAIL);
    expect(html).toContain('Acme');
  });

  it('puts a safe next, HTML-escaped, into a hidden field', async () => {
    const u1 = await directory.findUserByEmail(U1_EMAIL);
    if (u1 === null) throw new Error('seed missing u1@example.test');
    const selection = await mintSelectionToken(u1.id, U1_EMAIL, SECRET);
    const get = async (next: string) =>
      (
        await GET(
          new Request(`${URL_}?${new URLSearchParams({ next }).toString()}`, {
            headers: { host: HOST, cookie: `${selectionCookieName()}=${selection}` },
          }),
        )
      ).text();

    const plain = await get('/oauth/authorize?client_id=x&state=y');
    expect(plain).toContain(
      '<input type="hidden" name="next" value="/oauth/authorize?client_id=x&amp;state=y" />',
    );

    const hostile = await get('/a?"><script>alert(1)</script>');
    expect(hostile).not.toContain('<script>');
    // The guard percent-encodes quotes and angle brackets, so the attribute cannot be broken out of.
    expect(hostile).toContain('name="next" value="/a?%22%3E%3Cscript%3E');

    for (const unsafe of UNSAFE_NEXT_TARGETS) {
      expect(await get(unsafe)).not.toContain('name="next"');
    }
  });

  it('renders no next field without a next', async () => {
    const response = await GET(await selectionRequest());
    expect(await response.text()).not.toContain('name="next"');
  });

  it('sends an expired or missing selection to sign-in, not to an empty list', async () => {
    const response = await GET(request({ method: 'GET' }));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(SESSION_EXPIRED_LOCATION);
  });
});
