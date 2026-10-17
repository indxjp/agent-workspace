/**
 * `GET`/`POST /api/auth/workspace` — issue #118's verifier attack, driven against the real route
 * module Next.js calls, with a real in-memory {@link DirectoryRoot} installed the same way
 * `apps/web/app/api/metrics/metrics.test.ts` installs one for its own route.
 *
 * Named `workspace.test.ts`, not `route.test.ts`, for the reason `metrics.test.ts`'s header
 * gives: `tests/route-inventory.test.ts`'s `classifyAppFile` would otherwise read a colocated
 * `route.test.ts` as a second route file.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  mintSelectionToken,
  mintSessionToken,
  newSessionClaims,
  selectionCookieName,
  sessionCookieName,
} from '../../../../server/auth';
import { conferredBy } from '../../../../server/rbac/conferral';
import { createMemoryDirectory } from '../../../../server/rbac/memory-directory';
import {
  clearRbacRuntime,
  configureRbacRuntime,
  type RbacRuntime,
} from '../../../../server/rbac/runtime';
import {
  clearWorkspacesRuntime,
  configureWorkspacesRuntime,
  type WorkspaceRepositoryPort,
} from '../../../../server/workspaces/runtime';

import { GET, POST } from './route';

const SECRET = 'a'.repeat(32);
const HOST = 'app.example.test';
const URL_ = `https://${HOST}/api/auth/workspace`;
const viewer = conferredBy('owner', 'viewer', 'test fixture');

function request(options: {
  method: 'GET' | 'POST';
  cookies?: Record<string, string>;
  origin?: string | null;
  form?: Record<string, string>;
}): Request {
  const headers = new Headers();
  if (options.cookies !== undefined) {
    headers.set(
      'cookie',
      Object.entries(options.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; '),
    );
  }
  headers.set('host', HOST);
  if (options.origin !== undefined && options.origin !== null)
    headers.set('origin', options.origin);
  if (options.origin === undefined && options.method === 'POST')
    headers.set('origin', `https://${HOST}`);

  let body: string | undefined;
  if (options.form !== undefined) {
    headers.set('content-type', 'application/x-www-form-urlencoded');
    body = new URLSearchParams(options.form).toString();
  }
  return body === undefined
    ? new Request(URL_, { method: options.method, headers })
    : new Request(URL_, { method: options.method, headers, body });
}

function jsonRequest(options: {
  method: 'POST';
  cookies?: Record<string, string>;
  origin?: string | null;
  body?: unknown;
  rawBody?: string;
}): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.cookies !== undefined) {
    headers.set(
      'cookie',
      Object.entries(options.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; '),
    );
  }
  headers.set('host', HOST);
  const origin = options.origin === undefined ? `https://${HOST}` : options.origin;
  if (origin !== null) headers.set('origin', origin);
  return new Request(URL_, {
    method: options.method,
    headers,
    body: options.rawBody ?? JSON.stringify(options.body ?? {}),
  });
}

function setCookieValue(response: Response, name: string): string | undefined {
  for (const raw of response.headers.getSetCookie()) {
    if (raw.startsWith(`${name}=`)) return raw.slice(name.length + 1).split(';')[0];
  }
  return undefined;
}

describe('POST /api/auth/workspace', () => {
  let directory: ReturnType<typeof createMemoryDirectory>;

  beforeEach(() => {
    process.env['SESSION_SECRET'] = SECRET;
    directory = createMemoryDirectory({
      workspaces: [
        { id: 'ws-a', slug: 'acme', name: 'Acme' },
        { id: 'ws-b', slug: 'beta', name: 'Beta Inc' },
        { id: 'ws-c', slug: 'gamma', name: 'Gamma LLC' },
      ],
      users: [
        { email: 'u1@example.test', name: 'U1', workspaceId: 'ws-a', role: 'admin' },
        { email: 'u2@example.test', name: 'U2', workspaceId: 'ws-c', role: 'owner' },
      ],
    });
    const runtime: RbacRuntime = { directory, identify: () => Promise.resolve(null) };
    configureRbacRuntime(runtime);
  });

  afterEach(() => {
    delete process.env['SESSION_SECRET'];
    clearRbacRuntime();
  });

  it('refuses a workspace outside the caller’s memberships — identically by id, by slug, and for one that does not exist', async () => {
    // U1 is a member of A (from the seed) and, added here, of B — so this proves a real "not C"
    // refusal rather than merely "not a member of anything".
    await directory
      .forWorkspace('ws-b')
      .createMembership({ email: 'u1@example.test', role: viewer });

    const session = await mintSessionToken(newSessionClaims('u1@example.test', 'acme'), SECRET);
    const post = (workspace: string) =>
      POST(
        request({
          method: 'POST',
          cookies: { [sessionCookieName()]: session },
          form: { workspace },
        }),
      );

    const byId = await post('ws-c');
    const bySlug = await post('gamma');
    const unknown = await post('no-such-workspace');

    // All three are the same outcome: no session minted, sent back to the same place — the
    // response must not be an oracle for "exists but not mine" versus "does not exist".
    for (const response of [byId, bySlug, unknown]) {
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe(
        '/api/auth/workspace?error=workspace_not_available',
      );
      expect(setCookieValue(response, sessionCookieName())).toBeUndefined();
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
    const session = await mintSessionToken(newSessionClaims('u1@example.test', 'acme'), SECRET);
    const response = await POST(
      request({
        method: 'POST',
        cookies: { [sessionCookieName()]: session },
        form: { workspace: 'acme' },
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/');
    expect(setCookieValue(response, sessionCookieName())).toBeDefined();
  });

  // The `Location` this route answers with carries no origin at all, and that is the whole point:
  // `request.url` is the address this server is *bound* to, and a redirect built from it sends the
  // browser to a different origin than the one it asked — a container port map, a reverse proxy or
  // a `localhost`/`127.0.0.1` alias is enough. The session cookie was set for the origin the caller
  // used, so it is not sent to the other one, and a switch that succeeded arrives signed out.
  it('answers a relative Location, so the redirect stays on the origin the caller actually used', async () => {
    const session = await mintSessionToken(newSessionClaims('u1@example.test', 'acme'), SECRET);
    const switched = await POST(
      request({
        method: 'POST',
        cookies: { [sessionCookieName()]: session },
        form: { workspace: 'acme' },
      }),
    );
    expect(switched.status).toBe(303);
    expect(switched.headers.get('location')).toBe('/');
    // And the cookies still ride on that same response — a relative Location is a header change,
    // not a different response.
    expect(setCookieValue(switched, sessionCookieName())).toBeDefined();

    const expired = await POST(request({ method: 'POST', form: { workspace: 'acme' } }));
    expect(expired.status).toBe(303);
    expect(expired.headers.get('location')).toBe('/signin?error=session_expired');

    // Asserted as whole strings rather than by `.pathname`, because parsing is exactly what hides
    // the defect: `new URL('https://app.example.test/').pathname` is also `/`.
    for (const response of [switched, expired]) {
      expect(response.headers.get('location')).not.toContain(HOST);
      expect(response.headers.get('location')).not.toContain('://');
    }
  });

  it('re-reads membership: a since-removed membership is refused even with a valid selection cookie, and a surviving one still mints', async () => {
    const u1 = await directory.findUserByEmail('u1@example.test');
    if (u1 === null) throw new Error('seed missing u1@example.test');
    await directory
      .forWorkspace('ws-b')
      .createMembership({ email: 'u1@example.test', role: viewer });

    // The selection cookie is minted while B is still a real membership …
    const selection = await mintSelectionToken(u1.id, 'u1@example.test', SECRET);

    // … and then B is removed before the cookie is ever used.
    const bMembership = (await directory.forWorkspace('ws-b').listMemberships()).find(
      (row) => row.email === 'u1@example.test',
    );
    if (bMembership === undefined) throw new Error('membership in B not found');
    await directory.forWorkspace('ws-b').deleteMembership(bMembership.id);

    const refused = await POST(
      request({
        method: 'POST',
        cookies: { [selectionCookieName()]: selection },
        form: { workspace: 'beta' },
      }),
    );
    expect(refused.status).toBe(303);
    expect(refused.headers.get('location')).toContain('error=workspace_not_available');
    expect(setCookieValue(refused, sessionCookieName())).toBeUndefined();

    // A still exists: replaying the SAME selection cookie twice, selecting A, mints a session both
    // times. Neither replay is treated as fatal (the cookie carries no single-use nonce — only a
    // short TTL, which the task card's minimum implementation calls for) and in neither case is a
    // session minted for B, which no longer exists.
    const firstA = await POST(
      request({
        method: 'POST',
        cookies: { [selectionCookieName()]: selection },
        form: { workspace: 'acme' },
      }),
    );
    const secondA = await POST(
      request({
        method: 'POST',
        cookies: { [selectionCookieName()]: selection },
        form: { workspace: 'acme' },
      }),
    );
    for (const response of [firstA, secondA]) {
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/');
      expect(setCookieValue(response, sessionCookieName())).toBeDefined();
    }
  });

  it('refuses a cross-origin POST before it ever mints anything', async () => {
    const session = await mintSessionToken(newSessionClaims('u1@example.test', 'acme'), SECRET);
    const response = await POST(
      request({
        method: 'POST',
        cookies: { [sessionCookieName()]: session },
        origin: 'https://attacker.example',
        form: { workspace: 'acme' },
      }),
    );
    expect(response.status).toBe(403);
    expect(setCookieValue(response, sessionCookieName())).toBeUndefined();

    // BREAK-IT CHECK (done by hand, reverted before commit): commenting out the `if (!origin.ok)`
    // early return in route.ts makes this test fail — the mismatched Origin stops mattering and a
    // session is minted for `acme` instead of refused. Restoring the check makes it pass again.
  });

  it('refuses with neither a valid session nor a valid selection cookie', async () => {
    const response = await POST(request({ method: 'POST', form: { workspace: 'acme' } }));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/signin?error=session_expired');
    expect(setCookieValue(response, sessionCookieName())).toBeUndefined();
  });

  it('lands on a safe next after the pick, as a relative Location', async () => {
    const session = await mintSessionToken(newSessionClaims('u1@example.test', 'acme'), SECRET);
    const response = await POST(
      request({
        method: 'POST',
        cookies: { [sessionCookieName()]: session },
        form: { workspace: 'acme', next: '/oauth/authorize?client_id=x&state=y' },
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/oauth/authorize?client_id=x&state=y');
    expect(setCookieValue(response, sessionCookieName())).toBeDefined();
  });

  it.each(['//evil.example', 'https://evil.example', '/\\evil.example', '/.//evil.example'])(
    'lands on / for the unsafe next %s',
    async (next) => {
      const session = await mintSessionToken(newSessionClaims('u1@example.test', 'acme'), SECRET);
      const response = await POST(
        request({
          method: 'POST',
          cookies: { [sessionCookieName()]: session },
          form: { workspace: 'acme', next },
        }),
      );
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/');
    },
  );

  it('keeps a safe next on the refusal redirect and drops an unsafe one', async () => {
    const session = await mintSessionToken(newSessionClaims('u1@example.test', 'acme'), SECRET);
    const post = (next: string) =>
      POST(
        request({
          method: 'POST',
          cookies: { [sessionCookieName()]: session },
          form: { workspace: 'no-such-workspace', next },
        }),
      );
    const safe = await post('/oauth/authorize?client_id=x');
    expect(safe.headers.get('location')).toBe(
      '/api/auth/workspace?error=workspace_not_available&next=%2Foauth%2Fauthorize%3Fclient_id%3Dx',
    );
    expect(setCookieValue(safe, sessionCookieName())).toBeUndefined();
    const unsafe = await post('//evil.example');
    expect(unsafe.headers.get('location')).toBe(
      '/api/auth/workspace?error=workspace_not_available',
    );
  });

  it('refuses a cross-origin POST carrying a next before it mints or redirects anywhere', async () => {
    const session = await mintSessionToken(newSessionClaims('u1@example.test', 'acme'), SECRET);
    const response = await POST(
      request({
        method: 'POST',
        cookies: { [sessionCookieName()]: session },
        origin: 'https://attacker.example',
        form: { workspace: 'acme', next: '/oauth/authorize?client_id=x' },
      }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('location')).toBeNull();
    expect(setCookieValue(response, sessionCookieName())).toBeUndefined();
  });
});

describe('GET /api/auth/workspace', () => {
  let directory: ReturnType<typeof createMemoryDirectory>;

  beforeEach(() => {
    process.env['SESSION_SECRET'] = SECRET;
    directory = createMemoryDirectory({
      workspaces: [{ id: 'ws-a', slug: 'acme', name: 'Acme' }],
      users: [{ email: 'u1@example.test', name: 'U1', workspaceId: 'ws-a', role: 'admin' }],
    });
    configureRbacRuntime({ directory, identify: () => Promise.resolve(null) });
  });

  afterEach(() => {
    delete process.env['SESSION_SECRET'];
    clearRbacRuntime();
  });

  it('renders the caller’s current memberships when the selection cookie is valid', async () => {
    const u1 = await directory.findUserByEmail('u1@example.test');
    if (u1 === null) throw new Error('seed missing u1@example.test');
    const selection = await mintSelectionToken(u1.id, 'u1@example.test', SECRET);
    const response = await GET(
      request({ method: 'GET', cookies: { [selectionCookieName()]: selection } }),
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('u1@example.test');
    expect(html).toContain('Acme');
  });

  it('puts a safe next, HTML-escaped, into a hidden field', async () => {
    const u1 = await directory.findUserByEmail('u1@example.test');
    if (u1 === null) throw new Error('seed missing u1@example.test');
    const selection = await mintSelectionToken(u1.id, 'u1@example.test', SECRET);
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

    for (const unsafe of ['//evil.example', 'https://evil.example', '/\\evil.example']) {
      expect(await get(unsafe)).not.toContain('name="next"');
    }
  });

  it('renders no next field without a next', async () => {
    const u1 = await directory.findUserByEmail('u1@example.test');
    if (u1 === null) throw new Error('seed missing u1@example.test');
    const selection = await mintSelectionToken(u1.id, 'u1@example.test', SECRET);
    const response = await GET(
      request({ method: 'GET', cookies: { [selectionCookieName()]: selection } }),
    );
    expect(await response.text()).not.toContain('name="next"');
  });

  it('sends an expired or missing selection to sign-in, not to an empty list', async () => {
    const response = await GET(request({ method: 'GET' }));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/signin?error=session_expired');
  });
});

/**
 * The JSON branch (issue #236, SDK-04, S-2): same route, same shared logic above, `Content-Type:
 * application/json` in and `200 { workspace }` + `Set-Cookie` out instead of a `303`. Every
 * failure here is the standard `{ error: { code, message } }` envelope (`detail` a deprecated duplicate), which is also the property
 * that would catch a regression toward the form path's bare codes on this branch specifically.
 */
describe('POST /api/auth/workspace (application/json)', () => {
  let directory: ReturnType<typeof createMemoryDirectory>;
  const WS_A_RECORD = {
    id: 'ws-a',
    slug: 'acme',
    name: 'Acme',
    publicSharingEnabled: false,
    archivedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  function fakeWorkspaceRepository(role: Record<string, string>): WorkspaceRepositoryPort {
    const notImplemented = (): never => {
      throw new Error('not used by these fixtures');
    };
    return {
      listForUser: notImplemented,
      get: (id) => Promise.resolve(id === WS_A_RECORD.id ? { ...WS_A_RECORD } : null),
      getForMember: (id, userId) => {
        const memberRole = role[userId];
        if (id !== WS_A_RECORD.id || memberRole === undefined) return Promise.resolve(null);
        return Promise.resolve({ ...WS_A_RECORD, role: memberRole as never });
      },
      create: notImplemented,
      update: notImplemented,
      archive: notImplemented,
      restore: notImplemented,
    };
  }

  beforeEach(() => {
    process.env['SESSION_SECRET'] = SECRET;
    directory = createMemoryDirectory({
      workspaces: [{ id: 'ws-a', slug: 'acme', name: 'Acme' }],
      users: [{ email: 'u1@example.test', name: 'U1', workspaceId: 'ws-a', role: 'admin' }],
    });
    configureRbacRuntime({ directory, identify: () => Promise.resolve(null) });
  });

  afterEach(() => {
    delete process.env['SESSION_SECRET'];
    clearRbacRuntime();
    clearWorkspacesRuntime();
  });

  it('answers 200 with the membership view and the new session cookie', async () => {
    const u1 = await directory.findUserByEmail('u1@example.test');
    if (u1 === null) throw new Error('seed missing u1@example.test');
    configureWorkspacesRuntime({ repository: fakeWorkspaceRepository({ [u1.id]: 'admin' }) });

    const session = await mintSessionToken(newSessionClaims('u1@example.test', 'acme'), SECRET);
    const response = await POST(
      jsonRequest({
        method: 'POST',
        cookies: { [sessionCookieName()]: session },
        body: { workspace: 'acme' },
      }),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as {
      workspace: { id: string; slug: string; role: string };
    };
    expect(body.workspace).toMatchObject({ id: 'ws-a', slug: 'acme', role: 'admin' });
    expect(setCookieValue(response, sessionCookieName())).toBeDefined();
  });

  it('answers a workspace the caller does not belong to exactly like one that does not exist', async () => {
    const u1 = await directory.findUserByEmail('u1@example.test');
    if (u1 === null) throw new Error('seed missing u1@example.test');
    configureWorkspacesRuntime({ repository: fakeWorkspaceRepository({ [u1.id]: 'admin' }) });
    const session = await mintSessionToken(newSessionClaims('u1@example.test', 'acme'), SECRET);

    const notMine = await POST(
      jsonRequest({
        method: 'POST',
        cookies: { [sessionCookieName()]: session },
        body: { workspace: 'no-such-workspace' },
      }),
    );
    expect(notMine.status).toBe(404);
    const notMineBody = (await notMine.json()) as unknown;
    expect(notMineBody).toEqual({
      error: {
        code: 'workspace_not_available',
        message: expect.any(String) as unknown,
        detail: expect.any(String) as unknown,
      },
    });
    expect(setCookieValue(notMine, sessionCookieName())).toBeUndefined();
  });

  it('rejects a malformed body and an unknown field in the standard envelope', async () => {
    const session = await mintSessionToken(newSessionClaims('u1@example.test', 'acme'), SECRET);
    for (const request_ of [
      jsonRequest({ method: 'POST', cookies: { [sessionCookieName()]: session }, rawBody: '{' }),
      jsonRequest({
        method: 'POST',
        cookies: { [sessionCookieName()]: session },
        body: { workspace: 'acme', extra: 1 },
      }),
      jsonRequest({ method: 'POST', cookies: { [sessionCookieName()]: session }, body: {} }),
    ]) {
      const response = await POST(request_);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('malformed_request');
    }
  });

  it('still refuses cross-origin before anything is minted, in the standard envelope', async () => {
    const session = await mintSessionToken(newSessionClaims('u1@example.test', 'acme'), SECRET);
    const response = await POST(
      jsonRequest({
        method: 'POST',
        cookies: { [sessionCookieName()]: session },
        origin: 'https://attacker.example',
        body: { workspace: 'acme' },
      }),
    );
    expect(response.status).toBe(403);
    const crossOriginBody = (await response.json()) as unknown;
    expect(crossOriginBody).toEqual({
      error: {
        code: 'cross_origin',
        message: expect.any(String) as unknown,
        detail: expect.any(String) as unknown,
      },
    });
    expect(setCookieValue(response, sessionCookieName())).toBeUndefined();
  });

  it('sends an expired session to a 401 in the standard envelope, never a redirect', async () => {
    const response = await POST(jsonRequest({ method: 'POST', body: { workspace: 'acme' } }));
    expect(response.status).toBe(401);
    const expiredBody = (await response.json()) as unknown;
    expect(expiredBody).toEqual({
      error: {
        code: 'session_expired',
        message: expect.any(String) as unknown,
        detail: expect.any(String) as unknown,
      },
    });
  });
});
