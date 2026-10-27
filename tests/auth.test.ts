/**
 * W1-CP-06 — the authentication gate.
 *
 * Acceptance criterion, verbatim from the development plan §6.3: *"Unauthenticated request
 * to any `/api/**` route returns 401"*, demonstrated against a running server for every route
 * that exists.
 *
 * The file has two halves and they prove different things.
 *
 *   * **Unit.** The classifier, the token and the origin check, exercised directly. These are
 *     the parts where a wrong answer is a security hole rather than a bug, so each one is
 *     asserted on its *rejections* as much as on its acceptances: a token with no `exp`, an
 *     `exp` that is a string, a path that is `/api` under one reading and not another.
 *   * **Live.** A real `next dev` server, started by this file, probed over HTTP. It is the only
 *     evidence that the middleware is wired up at all — every unit test here would still pass
 *     if `apps/web/middleware.ts` did not exist. The route list it probes is **derived from the
 *     tree**, not transcribed: `discoverApiRouteHandlers()` walks `apps/web/app/api`. The probe
 *     set is the union of what exists, the §34 inventory, and paths that route to nothing at all.
 *     The last of those is the point: a gate that ran before routing answers 401 for a path no
 *     handler serves, which is what "protected by default rather than by being remembered" means.
 *
 * ## What the walk counts, and why that is a rule rather than a walk
 *
 * A handler counts if **git tracks it, or this test wrote it** — see {@link visibleRouteFiles}.
 * The walk is still a walk; the filter is what changed, and it is the repair of one direction of
 * the Wave 1a cross-test race. This file writes a route handler into `apps/web/app/api` for the
 * whole of its run, on purpose, and `tests/route-inventory.test.ts` used to plant one there too,
 * in a parallel worker of the same Vitest run. Each then saw the other's: this probe matrix grew
 * by two tests when it caught the sibling's fixture, and the sibling reported this file's fixture
 * as an undeclared route. Both directions are closed now, structurally and on both sides — that
 * gate writes nothing at all, and this walk does not count what it did not write.
 * See docs/adr/0019-repo-wide-gates-belong-to-the-integration-level.md §4.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API_ROUTES } from '@indx-workspace/contracts/routes';

import { pathPattern } from '../apps/web/server/auth/api-key-routes.js';
import { checkRequestOrigin } from '../apps/web/server/auth/origin.js';
import { classifyPath, enforcementFor, type Surface } from '../apps/web/server/auth/paths.js';
import {
  MIN_SESSION_SECRET_LENGTH,
  sessionCookieName,
  SESSION_TTL_SECONDS,
  clearedSessionCookie,
  mintSessionToken,
  newSessionClaims,
  readBootstrapAdmin,
  readSessionSecret,
  sessionCookie,
  signIn,
  verifySessionToken,
} from '../apps/web/server/auth/session.js';
import { WorkspaceScope, workspaceScopeFrom } from '../apps/web/server/auth/workspace.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDir = path.join(repoRoot, 'apps', 'web');

const SECRET = 'a'.repeat(MIN_SESSION_SECRET_LENGTH);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The prefix rule (spec §34)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('classifyPath — the §34 prefix rule', () => {
  it('protects /api and everything under it', () => {
    for (const pathname of ['/api', '/api/', '/api/agents', '/api/agents/1/runs', '/api/a/b/c/d']) {
      expect(classifyPath(pathname).surface, pathname).toBe<Surface>('api');
    }
  });

  it('protects an /api route that does not exist yet — default deny, not a remembered list', () => {
    // The property this task exists to guarantee. Nothing in the classifier knows these names.
    for (const invented of [
      '/api/secrets',
      '/api/v2/agents',
      '/api/a-route-nobody-has-written-yet',
      '/api/runtime-profiles/9/rotate',
      `/api/${Math.random().toString(36).slice(2)}`,
    ]) {
      expect(classifyPath(invented).surface, invented).toBe<Surface>('api');
    }
  });

  it('does not protect a path that merely starts with the letters "api"', () => {
    expect(classifyPath('/apiary').surface).toBe<Surface>('page');
    expect(classifyPath('/apidocs/index').surface).toBe<Surface>('page');
  });

  it('treats /p and everything under it as public (spec §34, §20.6)', () => {
    for (const pathname of ['/p', '/p/', '/p/tok3n', '/p/tok3n/messages']) {
      expect(classifyPath(pathname).surface, pathname).toBe<Surface>('public');
    }
  });

  it('does not let a path escape into the public surface by case', () => {
    expect(classifyPath('/P/tok3n').surface).not.toBe<Surface>('public');
  });

  it('does not let a path escape the protected surface by case or by escaping', () => {
    const evasions = [
      '/API/agents',
      '/Api/Agents',
      '/api/../api/agents',
      '/p/../api/agents',
      '/p/%2e%2e/api/agents',
      '/p/%252e%252e/api/agents',
      '//api/agents',
      '/api//agents',
      '/%61pi/agents',
      '\\api\\agents',
      '/p/..\\api\\agents',
    ];
    for (const pathname of evasions) {
      expect(classifyPath(pathname).surface, pathname).toBe<Surface>('api');
    }
  });

  it('denies rather than falls through when the pathname cannot be read', () => {
    // ADR-0015: absence of a readable input is not absence of risk.
    for (const bad of [undefined, null, 42, {}, [], '', 'api/agents', '/api/%zz', '/%e0%a4%a']) {
      expect(classifyPath(bad).surface, JSON.stringify(bad)).toBe<Surface>('api');
    }
  });

  it('names its reason on every branch', () => {
    for (const pathname of ['/api/agents', '/p/x', '/home', '/api/%zz']) {
      expect(classifyPath(pathname).reason.length, pathname).toBeGreaterThan(0);
    }
  });
});

describe('enforcementFor', () => {
  it('denies the api surface and allows the other two', () => {
    expect(enforcementFor('api')).toBe('deny-401');
    expect(enforcementFor('public')).toBe('allow');
    expect(enforcementFor('page')).toBe('allow');
  });

  it('throws rather than allowing a surface it does not know', () => {
    expect(() => enforcementFor('sockets' as Surface)).toThrow(/unclassified surface/u);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The session token
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('readSessionSecret', () => {
  it('fails closed when the secret is absent, blank or short', () => {
    for (const env of [
      {},
      { SESSION_SECRET: '' },
      { SESSION_SECRET: '   ' },
      { SESSION_SECRET: 'short' },
    ]) {
      const result = readSessionSecret(env);
      expect(result.ok, JSON.stringify(env)).toBe(false);
      if (!result.ok) expect(result.reason).toContain('SESSION_SECRET');
    }
  });

  it('accepts a secret at the minimum length', () => {
    expect(readSessionSecret({ SESSION_SECRET: SECRET })).toEqual({ ok: true, secret: SECRET });
  });
});

describe('verifySessionToken', () => {
  it('round-trips a minted token', async () => {
    const claims = newSessionClaims('admin@example.com', 'default');
    const token = await mintSessionToken(claims, SECRET);
    const result = await verifySessionToken(token, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims).toEqual(claims);
  });

  it('rejects an absent cookie by name', async () => {
    for (const absent of [undefined, null, '']) {
      const result = await verifySessionToken(absent, SECRET);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('no_session_cookie');
    }
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await mintSessionToken(newSessionClaims('admin@example.com', 'default'), SECRET);
    const result = await verifySessionToken(token, 'b'.repeat(MIN_SESSION_SECRET_LENGTH));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_signature');
  });

  it('rejects a tampered payload', async () => {
    const token = await mintSessionToken(newSessionClaims('admin@example.com', 'default'), SECRET);
    const parts = token.split('.');
    const forged = JSON.stringify({
      sub: 'attacker@example.com',
      ws: 'other-workspace',
      role: 'owner',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const swapped = `${parts[0] ?? ''}.${Buffer.from(forged).toString('base64url')}.${parts[2] ?? ''}`;
    const result = await verifySessionToken(swapped, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_signature');
  });

  it('rejects a token whose version tag is not this build’s', async () => {
    const token = await mintSessionToken(newSessionClaims('admin@example.com', 'default'), SECRET);
    const result = await verifySessionToken(token.replace(/^aw1\./u, 'aw2.'), SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('malformed_session');
  });

  it('rejects a structurally wrong token without throwing', async () => {
    for (const bad of ['x', 'a.b', 'a.b.c.d', 'aw1..', 'aw1.$$$.$$$', 42, {}, []]) {
      const result = await verifySessionToken(bad, SECRET);
      expect(result.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('rejects an expired session', async () => {
    const issuedAt = Date.now() - (SESSION_TTL_SECONDS + 60) * 1000;
    const token = await mintSessionToken(
      newSessionClaims('admin@example.com', 'default', issuedAt),
      SECRET,
    );
    const result = await verifySessionToken(token, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('expired_session');
  });

  /**
   * ADR-0015, the exact bug named there: `NaN < Date.now()` is `false`, so a comparison reached
   * with an unparsed expiry reads as "not expired" and the gate fails open. These tokens are
   * correctly signed — the MAC is not what is being tested — so the only thing standing between
   * them and a valid session is that `exp` is parsed and type-checked before it is compared.
   */
  it('rejects a correctly signed token whose exp is missing, non-numeric or NaN', async () => {
    const base = {
      sub: 'admin@example.com',
      ws: 'default',
      role: 'owner',
      iat: Math.floor(Date.now() / 1000),
    };
    const payloads: readonly Record<string, unknown>[] = [
      { ...base },
      { ...base, exp: null },
      { ...base, exp: 'tomorrow' },
      { ...base, exp: Number.NaN },
      { ...base, exp: Number.POSITIVE_INFINITY },
      { ...base, exp: {} },
      { ...base, iat: Number.NaN, exp: base.iat + 60 },
      { ...base, role: 'admin', exp: base.iat + 60 },
      { ...base, sub: '', exp: base.iat + 60 },
      { ...base, ws: 42, exp: base.iat + 60 },
      { ...base, exp: base.iat + SESSION_TTL_SECONDS * 10 },
    ];
    for (const payload of payloads) {
      const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const signed = `aw1.${encoded}`;
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const signature = Buffer.from(
        await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed)),
      ).toString('base64url');
      const result = await verifySessionToken(`${signed}.${signature}`, SECRET);
      expect(result.ok, JSON.stringify(payload)).toBe(false);
      if (!result.ok) expect(result.code).toBe('malformed_session');
    }
  });

  it('rejects a payload that is valid JSON but not an object', async () => {
    for (const scalar of ['"hello"', '42', 'null', '[1,2]']) {
      const encoded = Buffer.from(scalar).toString('base64url');
      const signed = `aw1.${encoded}`;
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const signature = Buffer.from(
        await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed)),
      ).toString('base64url');
      const result = await verifySessionToken(`${signed}.${signature}`, SECRET);
      expect(result.ok, scalar).toBe(false);
    }
  });
});

describe('the session cookie', () => {
  it('is __Host-, HttpOnly, Secure, SameSite=Lax and Path=/', () => {
    const cookie = sessionCookie('token');
    expect(cookie.name).toBe('__Host-aw_session');
    expect(cookie.name).toBe(sessionCookieName());
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.secure).toBe(true);
    expect(cookie.sameSite).toBe('lax');
    expect(cookie.path).toBe('/');
    expect(cookie.maxAge).toBe(SESSION_TTL_SECONDS);
  });

  it('clears with the same attributes and a zero lifetime', () => {
    const cleared = clearedSessionCookie();
    expect(cleared.name).toBe(sessionCookieName());
    expect(cleared.value).toBe('');
    expect(cleared.maxAge).toBe(0);
    expect(cleared.secure).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The bootstrap administrator (spec §21, §37)
// ─────────────────────────────────────────────────────────────────────────────────────────────

const GOOD_ENV = {
  SESSION_SECRET: SECRET,
  BOOTSTRAP_ADMIN: 'Admin@Example.com',
  BOOTSTRAP_ADMIN_PASSWORD: 'correct horse battery staple',
} as const;

describe('readBootstrapAdmin', () => {
  it('lower-cases the email so it matches the row the seed inserted', () => {
    const result = readBootstrapAdmin(GOOD_ENV);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.admin.email).toBe('admin@example.com');
      expect(result.admin.workspaceSlug).toBe('default');
    }
  });

  it('takes the workspace slug from WORKSPACE_SLUG, as the seed does', () => {
    const result = readBootstrapAdmin({ ...GOOD_ENV, WORKSPACE_SLUG: 'acme-eu' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.admin.workspaceSlug).toBe('acme-eu');
  });

  it('fails closed, naming the variable, for every unusable configuration', () => {
    const cases: readonly [Record<string, string>, string][] = [
      [{}, 'BOOTSTRAP_ADMIN'],
      [{ BOOTSTRAP_ADMIN: '   ' }, 'BOOTSTRAP_ADMIN'],
      [{ BOOTSTRAP_ADMIN: 'not-an-email' }, 'BOOTSTRAP_ADMIN'],
      [{ BOOTSTRAP_ADMIN: 'a@b.c' }, 'BOOTSTRAP_ADMIN_PASSWORD'],
      [{ BOOTSTRAP_ADMIN: 'a@b.c', BOOTSTRAP_ADMIN_PASSWORD: '' }, 'BOOTSTRAP_ADMIN_PASSWORD'],
      [{ BOOTSTRAP_ADMIN: 'a@b.c', BOOTSTRAP_ADMIN_PASSWORD: 'short' }, 'BOOTSTRAP_ADMIN_PASSWORD'],
      [{ ...GOOD_ENV, WORKSPACE_SLUG: 'Not A Slug' }, 'WORKSPACE_SLUG'],
    ];
    for (const [env, expected] of cases) {
      const result = readBootstrapAdmin(env);
      expect(result.ok, JSON.stringify(env)).toBe(false);
      if (!result.ok) expect(result.reason, JSON.stringify(env)).toContain(expected);
    }
  });
});

describe('signIn', () => {
  it('mints a verifiable session for the configured administrator', async () => {
    const result = await signIn(
      { email: 'ADMIN@example.com ', password: GOOD_ENV.BOOTSTRAP_ADMIN_PASSWORD },
      GOOD_ENV,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const verified = await verifySessionToken(result.token, SECRET);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims.sub).toBe('admin@example.com');
      expect(verified.claims.ws).toBe('default');
      expect(verified.claims.role).toBe('owner');
    }
    expect(result.cookie.name).toBe(sessionCookieName());
  });

  it('refuses a wrong password and a wrong email with the same code', async () => {
    const wrongPassword = await signIn(
      { email: GOOD_ENV.BOOTSTRAP_ADMIN, password: 'nope nope nope' },
      GOOD_ENV,
    );
    const wrongEmail = await signIn(
      { email: 'someone@else.test', password: GOOD_ENV.BOOTSTRAP_ADMIN_PASSWORD },
      GOOD_ENV,
    );
    expect(wrongPassword.ok).toBe(false);
    expect(wrongEmail.ok).toBe(false);
    if (!wrongPassword.ok) expect(wrongPassword.code).toBe('invalid_credentials');
    if (!wrongEmail.ok) expect(wrongEmail.code).toBe('invalid_credentials');
  });

  it('refuses non-string credentials rather than coercing them', async () => {
    for (const input of [
      { email: undefined, password: GOOD_ENV.BOOTSTRAP_ADMIN_PASSWORD },
      { email: GOOD_ENV.BOOTSTRAP_ADMIN, password: undefined },
      {
        email: { toString: () => GOOD_ENV.BOOTSTRAP_ADMIN },
        password: GOOD_ENV.BOOTSTRAP_ADMIN_PASSWORD,
      },
      { email: GOOD_ENV.BOOTSTRAP_ADMIN, password: ['correct horse battery staple'] },
    ]) {
      const result = await signIn(input, GOOD_ENV);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('malformed_request');
    }
  });

  it('refuses to sign anybody in when the deployment is not configured', async () => {
    const cases: readonly Record<string, string>[] = [
      // No SESSION_SECRET at all.
      {
        BOOTSTRAP_ADMIN: GOOD_ENV.BOOTSTRAP_ADMIN,
        BOOTSTRAP_ADMIN_PASSWORD: GOOD_ENV.BOOTSTRAP_ADMIN_PASSWORD,
      },
      // No administrator at all.
      { SESSION_SECRET: SECRET },
      // An administrator with no credential.
      { SESSION_SECRET: SECRET, BOOTSTRAP_ADMIN: GOOD_ENV.BOOTSTRAP_ADMIN },
      // Everything set, but the secret is too short to sign with.
      { ...GOOD_ENV, SESSION_SECRET: 'too-short' },
    ];
    for (const env of cases) {
      const result = await signIn(
        { email: GOOD_ENV.BOOTSTRAP_ADMIN, password: GOOD_ENV.BOOTSTRAP_ADMIN_PASSWORD },
        env,
      );
      expect(result.ok, JSON.stringify(env)).toBe(false);
      if (!result.ok) expect(result.code).toBe('server_not_configured');
    }
  });

  it('refuses an empty password even if the caller sends an empty password too', async () => {
    const result = await signIn(
      { email: GOOD_ENV.BOOTSTRAP_ADMIN, password: '' },
      {
        SESSION_SECRET: SECRET,
        BOOTSTRAP_ADMIN: GOOD_ENV.BOOTSTRAP_ADMIN,
        BOOTSTRAP_ADMIN_PASSWORD: '',
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('server_not_configured');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Cross-site request forgery (spec §24)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('checkRequestOrigin', () => {
  it('lets safe methods through with no Origin at all', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      expect(checkRequestOrigin({ method, origin: null, requestHost: 'app.test' }).ok, method).toBe(
        true,
      );
    }
  });

  it('accepts an unsafe method whose Origin host is the request host', () => {
    expect(
      checkRequestOrigin({ method: 'POST', origin: 'https://app.test', requestHost: 'app.test' })
        .ok,
    ).toBe(true);
  });

  it('accepts the proxied host a TLS terminator forwarded', () => {
    expect(
      checkRequestOrigin({
        method: 'POST',
        origin: 'https://app.example.com',
        requestHost: 'web:3000',
        forwardedHost: 'app.example.com',
      }).ok,
    ).toBe(true);
  });

  it('rejects a cross-site Origin', () => {
    expect(
      checkRequestOrigin({ method: 'POST', origin: 'https://evil.test', requestHost: 'app.test' })
        .ok,
    ).toBe(false);
  });

  it('rejects an unsafe method with no Origin, rather than treating absence as safe', () => {
    for (const origin of [null, undefined, '', '   ', 'null', 'not a url', 42]) {
      expect(
        checkRequestOrigin({ method: 'POST', origin, requestHost: 'app.test' }).ok,
        JSON.stringify(origin),
      ).toBe(false);
    }
  });

  it('rejects when the method itself cannot be read', () => {
    for (const method of [undefined, null, '', 42]) {
      expect(
        checkRequestOrigin({ method, origin: 'https://app.test', requestHost: 'app.test' }).ok,
      ).toBe(false);
    }
  });

  it('rejects when no host could be determined', () => {
    expect(
      checkRequestOrigin({ method: 'POST', origin: 'https://app.test', requestHost: undefined }).ok,
    ).toBe(false);
  });

  /**
   * `new URL('app.example.com:3000')` does not throw — the host reads as a scheme and `.host`
   * comes back empty — so the first version of `hostOf` returned `''` for every bare `host:port`
   * whose host begins with a letter. This case is the one the module's own comment promises to
   * keep working, and under that rule it returned `false`: the expected set was `['']` and the
   * `Origin` host was not in it. A spurious 403 on every write behind a proxy that forwards a
   * port.
   */
  it('reads the host out of a forwarded `host:port`, which is what a proxy actually sends', () => {
    for (const forwardedHost of [
      'app.example.com:3000',
      'APP.EXAMPLE.COM:3000',
      'app.example.com:3000, internal:8080',
    ]) {
      const verdict = checkRequestOrigin({
        method: 'POST',
        origin: 'https://app.example.com:3000',
        requestHost: 'web:3000',
        forwardedHost,
      });
      // The reason is asserted and not only the verdict, so that a pass has to be a pass for the
      // stated reason — the forwarded host matching — rather than by two empty strings agreeing.
      expect(verdict.ok, forwardedHost).toBe(true);
      expect(verdict.reason, forwardedHost).toContain('app.example.com:3000');
    }
  });

  it('never lets an empty host into the expected set', () => {
    // `new URL('file:///x')` succeeds and its `.host` is empty. An empty string in the expected
    // set would defeat the `expected.size === 0` guard below and match a hand-written Origin.
    const verdict = checkRequestOrigin({
      method: 'POST',
      origin: 'https://app.test',
      requestHost: 'file:///x',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('no host could be determined');
  });

  it('still rejects a cross-site Origin when the request host carries a port', () => {
    expect(
      checkRequestOrigin({
        method: 'POST',
        origin: 'https://evil.test',
        requestHost: 'app.example.com:3000',
      }).ok,
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The acceptance criterion, against a running server
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The route handlers this run is entitled to see: the ones git tracks, plus the ones this file
 * writes for itself.
 *
 * A **positive** membership rule, and the repair of one direction of the Wave 1a race
 * ([ADR-0019](../docs/adr/0019-repo-wide-gates-belong-to-the-integration-level.md) §4). The walk
 * below runs in a parallel Vitest worker beside `tests/route-inventory.test.ts`, which used to
 * plant a `route.jsx` under `apps/web/app/api/agents/` mid-test; when the two overlapped, this
 * walk found that fixture and the probe matrix silently grew by one path — two `it.each` cases —
 * so the suite's own total moved between runs. That gate no longer writes anything, and this rule
 * means no future one can move the total either: a handler counts if the repository ships it, or
 * if this test wrote it, and a sibling's scratch file is neither.
 *
 * `git ls-files` throwing is left to throw: an empty list here would silently shrink the probe
 * matrix, which is the fail-open shape (ADR-0015).
 */
function visibleRouteFiles(root: string): ReadonlySet<string> {
  const apiDir = path.join(root, 'app', 'api');
  const inRepo = path.relative(repoRoot, apiDir);
  // A root outside this repository tracks nothing — said here rather than discovered by letting
  // `git ls-files` fail on a path it cannot take. The negative-control test below uses such a root.
  const tracked =
    inRepo.startsWith('..') || path.isAbsolute(inRepo)
      ? []
      : execFileSync('git', ['ls-files', '-z', '--', inRepo.split(path.sep).join('/')], {
          cwd: repoRoot,
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
        })
          .split('\0')
          .filter((f) => f.length > 0)
          .map((f) => path.resolve(repoRoot, f));
  // Written by this file, at collection time, and removed in `afterAll`. Named rather than
  // pattern-matched: "a fixture" is not a category a walker can recognise, but "the two files
  // this test writes" is a list this test can hold.
  return new Set([...tracked, UNREGISTERED_ROUTE_FILE]);
}

/**
 * Walk `apps/web/app/api` and return the URL path of every route handler this run may see. Derived
 * mechanically (W0-DOC-01's rule: counts and inventories are derived, never transcribed), so the
 * probe set grows on its own as W1-CP-04 and W1-CP-05 land their handlers — and does not grow for
 * anything else, per {@link visibleRouteFiles}.
 */
export function discoverApiRouteHandlers(root: string = webDir): readonly string[] {
  const apiDir = path.join(root, 'app', 'api');
  if (!existsSync(apiDir)) return [];
  const visible = visibleRouteFiles(root);
  const found: string[] = [];
  const walk = (dir: string, urlPath: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // A route group `(group)` contributes no URL segment; a dynamic segment gets a literal.
        const segment = /^\(.*\)$/u.test(entry.name)
          ? ''
          : `/${entry.name.replace(/^\[\.{0,3}(.+)\]$/u, 'probe-$1')}`;
        walk(path.join(dir, entry.name), `${urlPath}${segment}`);
      } else {
        // ADR-0015. This used to ask "is the extension one of ts|tsx|js|jsx|mjs?", which is a
        // list, and a list is the thing somebody forgets to add to: `route.mts`, `route.cjs` and
        // any extension a future `pageExtensions` adds would all have fallen through it to the
        // pass path and left a real handler unprobed. Next.js routes exactly one *name* under
        // `app/api` — `route` — so the question asked is the one that has no list in it: is the
        // stem `route`? Everything else contributes nothing, and the bias of being wrong here is
        // toward probing a path that serves nothing, which must answer 401 anyway.
        const stem = entry.name.split('.')[0] ?? '';
        if (stem === 'route' && visible.has(path.join(dir, entry.name))) {
          found.push(urlPath === '' ? '/api' : urlPath);
        }
      }
    }
  };
  walk(apiDir, '/api');
  return [...new Set(found)].sort();
}

/** The §34 inventory, so the probe set is never empty even before a handler exists. */
const SPEC_34_API_ROUTES: readonly string[] = [
  '/api/agents',
  '/api/agents/probe-id',
  '/api/agents/probe-id/runs',
  '/api/runs/probe-id',
  '/api/runs/probe-id/events',
  '/api/sessions',
  '/api/sessions/probe-id/messages',
  '/api/models',
  '/api/model-connections',
  '/api/skills',
  '/api/connectors',
  '/api/files',
  '/api/users',
  '/api/runtime-profiles',
  '/api/projects',
  '/api/projects/probe-id',
  '/api/shares',
  '/api/shares/probe-id',
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Default protection: a route this repository has never heard of
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The acceptance criterion has two halves, and the second one is the one a route allowlist would
 * fail: *a brand-new route added without touching auth is protected by default.*
 *
 * So this file writes one. Before the suite spawns `next dev`, it creates a handler at a nested
 * path under `apps/web/app/api/` and registers it **nowhere** — not in the middleware matcher,
 * not in `SPEC_34_API_ROUTES`, not in any list in this file. The only thing that then has to be
 * true for the probe matrix below to cover it is that `discoverApiRouteHandlers()` walks the
 * tree, which is asserted directly rather than assumed: the run's own probe count rises by one
 * route (two tests, GET and POST) because the tree grew, and `it('discovers …')` fails if the
 * walker missed the file.
 *
 * The handler also does the one thing no other file on this branch does: it imports
 * `requireWorkspaceScope` from `@/server/auth`, which pulls every module in the directory —
 * `index.ts` and, through its imports and value re-exports, `session.ts`, `workspace.ts`,
 * `paths.ts` and `origin.ts` — into Turbopack's module graph. That is the live proof that the one
 * type-only sibling import in the tree, `import type { VerifiedSessionClaims } from './session.js'`
 * at the top of `workspace.ts`, is erased before any bundler resolver sees it — the concern
 * docs/adr/W1-CP-06-auth-modules-are-standalone-es-modules.md raises about sibling imports. If it
 * were not erased, this route would fail to compile and the authenticated probe below would not
 * return the canary.
 */
const UNREGISTERED_API_ROOT = path.join(webDir, 'app', 'api');
const UNREGISTERED_ROUTE_ROOT = path.join(UNREGISTERED_API_ROOT, 'w1cp06-unregistered');
const UNREGISTERED_ROUTE_DIR = path.join(UNREGISTERED_ROUTE_ROOT, 'deep');
const UNREGISTERED_ROUTE_FILE = path.join(UNREGISTERED_ROUTE_DIR, 'route.ts');
const UNREGISTERED_ROUTE_PATH = '/api/w1cp06-unregistered/deep';

/**
 * A string that appears in exactly one place in the repository. An unauthenticated response that
 * contains it is a leak, and the assertion is written against the body rather than only against
 * the status so that a 200 carrying it could never be mistaken for a pass.
 */
const UNREGISTERED_ROUTE_CANARY = 'w1cp06-canary-never-visible-unauthenticated';

const UNREGISTERED_ROUTE_SOURCE = `import { NextResponse } from 'next/server';

import { requireWorkspaceScope } from '@/server/auth';

export async function GET(): Promise<NextResponse> {
  const scope = await requireWorkspaceScope();
  return NextResponse.json({ canary: '${UNREGISTERED_ROUTE_CANARY}', scope });
}

export const POST = GET;
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
export const HEAD = GET;
export const OPTIONS = GET;
`;

/**
 * The mirror image, and the answer to a question verification round 1 asked: if nothing under
 * `/api/**` can opt out of the gate, where does a sign-in endpoint go? It cannot go under
 * `/api/`, because `POST /api/auth/signin` is 401 before it can mint anything — that is the gate
 * working, not a defect. §34's own answer is the `/p/` prefix, which the classifier already
 * routes to `allow`, and this fixture proves an unauthenticated handler can live there **today**
 * with no change to `middleware.ts`, `paths.ts` or anything else this task owns.
 *
 * The handler deliberately imports nothing from `@/server/auth`, because the point being proved
 * is that reaching it requires no session at all. See
 * docs/adr/W1-CP-06-sign-in-lives-outside-the-api-prefix.md, including the CSRF caveat: the
 * middleware's `Origin` check runs only on the enforced surface, so a real sign-in handler under
 * `/p/` must call the exported `checkRequestOrigin()` itself.
 */
const PUBLIC_APP_ROOT = path.join(webDir, 'app', 'p');
const PUBLIC_ROUTE_DIR = path.join(PUBLIC_APP_ROOT, 'w1cp06-unauthenticated');
const PUBLIC_ROUTE_FILE = path.join(PUBLIC_ROUTE_DIR, 'route.ts');
const PUBLIC_ROUTE_PATH = '/p/w1cp06-unauthenticated';
const PUBLIC_ROUTE_MARKER = 'w1cp06-reached-without-a-session';

const PUBLIC_ROUTE_SOURCE = `import { NextResponse } from 'next/server';

export function GET(): NextResponse {
  return NextResponse.json({ reached: '${PUBLIC_ROUTE_MARKER}' });
}

export const POST = GET;
`;

/**
 * A run killed before `afterAll` (Ctrl-C, crash, timeout) leaves both fixtures behind, including
 * the unauthenticated `/p/` handler. Remove such stale copies before deciding below who owns the
 * parent directories. Both paths are also in `.gitignore`, so a leftover is never committed.
 */
function removeStaleFixtures(): void {
  rmSync(UNREGISTERED_ROUTE_ROOT, { recursive: true, force: true });
  rmSync(PUBLIC_ROUTE_DIR, { recursive: true, force: true });
  if (existsSync(PUBLIC_APP_ROOT) && readdirSync(PUBLIC_APP_ROOT).length === 0) {
    rmSync(PUBLIC_APP_ROOT, { recursive: true, force: true });
  }
}
removeStaleFixtures();

/** True when something other than this fixture already owns these directories. */
const apiDirPreexisted = existsSync(UNREGISTERED_API_ROOT);
const publicDirPreexisted = existsSync(PUBLIC_APP_ROOT);

function writeUnregisteredRoute(): void {
  mkdirSync(UNREGISTERED_ROUTE_DIR, { recursive: true });
  writeFileSync(UNREGISTERED_ROUTE_FILE, UNREGISTERED_ROUTE_SOURCE, 'utf8');
  mkdirSync(PUBLIC_ROUTE_DIR, { recursive: true });
  writeFileSync(PUBLIC_ROUTE_FILE, PUBLIC_ROUTE_SOURCE, 'utf8');
}

function removeUnregisteredRoute(): void {
  rmSync(UNREGISTERED_ROUTE_ROOT, { recursive: true, force: true });
  rmSync(PUBLIC_ROUTE_DIR, { recursive: true, force: true });
  // Only if this run created them. W1-CP-04, W1-CP-05 and W5 land real handlers in both.
  if (!apiDirPreexisted) rmSync(UNREGISTERED_API_ROOT, { recursive: true, force: true });
  if (!publicDirPreexisted) rmSync(PUBLIC_APP_ROOT, { recursive: true, force: true });
}

// Written at collection time, before `probes` is computed and before `next dev` is spawned, so
// that the derived probe set below picks it up without anything in this file naming it.
writeUnregisteredRoute();

/** Paths no handler serves. The gate runs before routing, so these must be 401, not 404. */
const UNROUTED_API_PATHS: readonly string[] = [
  '/api',
  '/api/not-a-route',
  '/api/secrets/export',
  '/api/agents/../users',
];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('could not obtain a free port'));
        return;
      }
      const { port } = address;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/**
 * Next's dev server forks a `next-server` process that is a grandchild of the process we spawn,
 * not a child of it — `child.kill()` alone leaves it running, reparented to init, still holding
 * the port. On POSIX the spawn below (`detached: true`) makes `child.pid` a process group leader,
 * so the negated pid kills the whole group in one signal; on win32 `taskkill /T` already walks the
 * process tree by parent pid, which is what recurses into the grandchild there.
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      child.kill('SIGKILL');
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

/**
 * `killTree` only SENDS the signal; this waits for the child's `exit` and then for the port it
 * listened on to be bindable again, and prints how long that took. It is the teardown asserting
 * that the resource the next file needs is actually back (ADR-0015), not a fix for a race in
 * Next: when the two `next dev` suites in this project were refused each other's lock in CI
 * (runs 35521409361 / 35521944657 / 35522535672) the cause was a VITEST_MAX_WORKERS exported for
 * every Nx task, which overrides this project's `fileParallelism: false` and ran the two files
 * side by side — see nx.json targetDefaults.test `//workers`. Capped, so a teardown that lost the
 * child cannot hang the run.
 */
async function waitForRelease(child: ChildProcess, port: number): Promise<void> {
  const started = Date.now();
  const deadline = started + 15_000;
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 5_000);
      child.once('exit', done);
    });
  }
  while (Date.now() < deadline) {
    const bindable = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (bindable) {
      console.log(`next dev on :${String(port)} released after ${String(Date.now() - started)} ms`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `next dev on :${String(port)} still holds its port ${String(Date.now() - started)} ms after ` +
      'SIGKILL — the next file in this serial project would be refused its own server',
  );
}

const STARTUP_TIMEOUT_MS = 180_000;

/**
 * `next dev` writes agent-guidance files into the app directory on start-up. They are not in
 * `.gitignore` and they belong to no task, so a test run would otherwise leave two untracked
 * files in the working tree of a clone three sessions are writing to. Only files this run
 * created are removed — one that was already there is left alone.
 */
const NEXT_DEV_ARTEFACTS = ['AGENTS.md', 'CLAUDE.md'].map((name) => path.join(webDir, name));

describe('the running server refuses every /api/** request without a session', () => {
  let child: ChildProcess | null = null;
  let base = '';
  let port = 0;
  let token = '';
  let preexistingArtefacts: readonly string[] = [];

  beforeAll(async () => {
    preexistingArtefacts = NEXT_DEV_ARTEFACTS.filter((file) => existsSync(file));
    port = await freePort();
    base = `http://127.0.0.1:${String(port)}`;
    // `next` is a dependency of apps/web, so pnpm installs it under apps/web/node_modules; the
    // repository root has no copy. Both are checked rather than one being assumed, and a miss is
    // an error rather than a spawn of something that is not there.
    const nextBin = [
      path.join(webDir, 'node_modules', 'next', 'dist', 'bin', 'next'),
      path.join(repoRoot, 'node_modules', 'next', 'dist', 'bin', 'next'),
    ].find((candidate) => existsSync(candidate));
    if (nextBin === undefined) {
      throw new Error('next is not installed — run `pnpm install` before `pnpm test`');
    }
    child = spawn(
      process.execPath,
      [nextBin, 'dev', '--port', String(port), '--hostname', '127.0.0.1'],
      {
        cwd: webDir,
        env: {
          ...process.env,
          NEXT_TELEMETRY_DISABLED: '1',
          SESSION_SECRET: SECRET,
          BOOTSTRAP_ADMIN: 'admin@example.com',
          BOOTSTRAP_ADMIN_PASSWORD: 'correct horse battery staple',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // Process-group leader on POSIX so killTree can signal the whole tree, `next-server`
        // grandchild included, in one call; meaningless (and left off) on win32, where
        // `taskkill /T` walks the tree by parent pid instead.
        detached: process.platform !== 'win32',
      },
    );
    // Kept, not discarded: when the server fails to start, its own output is the only thing that
    // says why, and a timeout with no explanation is the least useful failure a gate can produce.
    let serverOutput = '';
    const record = (chunk: Buffer): void => {
      serverOutput += chunk.toString('utf8');
    };
    child.stdout?.on('data', record);
    child.stderr?.on('data', record);

    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(`next dev did not answer on ${base} within the timeout:\n${serverOutput}`);
      }
      try {
        await fetch(`${base}/api/__startup_probe__`, { redirect: 'manual' });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    // `next dev` compiles a route handler on its first request. The proxy answers almost every
    // probe below itself, but it forwards the ADR-0135 endpoint-credential routes (the A2A
    // JSON-RPC and agent-card routes) to their handler, which authenticates its own caller. The
    // first hit on that handler compiles the run API it imports, and in CI that compile alone
    // outran the 5 s probe timeout (#1005). Compiling them here, inside the startup budget, keeps
    // the probes measuring the gate rather than the compiler; nothing is asserted on these hits,
    // and every probe still asserts its own 401.
    // The routes are read from the catalogue as `agent-endpoint-routes.ts` does; that module is not
    // imported because its extensionless sibling import is not a standalone ES module (W1-CP-06).
    for (const route of API_ROUTES.filter((r) => r.security === 'endpoint-credential')) {
      const pattern = pathPattern(route.path);
      for (const pathname of probes.filter((probe) => pattern.test(probe))) {
        const warm = await fetch(`${base}${pathname}`, {
          method: route.method,
          redirect: 'manual',
        });
        await warm.arrayBuffer();
      }
    }

    token = await mintSessionToken(newSessionClaims('admin@example.com', 'default'), SECRET);
  }, STARTUP_TIMEOUT_MS + 30_000);

  afterAll(async () => {
    if (child !== null) {
      killTree(child);
      await waitForRelease(child, port);
    }
    for (const file of NEXT_DEV_ARTEFACTS) {
      if (!preexistingArtefacts.includes(file) && existsSync(file)) rmSync(file, { force: true });
    }
    removeUnregisteredRoute();
  });

  const probes = [
    ...new Set([...discoverApiRouteHandlers(), ...SPEC_34_API_ROUTES, ...UNROUTED_API_PATHS]),
  ].sort();
  // Issue #118's OIDC sign-in exchange (W9-AUTH-118) is the second set of pre-session
  // control-plane endpoints, for the same reason `/api/setup*` is the first: reaching them with
  // no session is the whole point, so `apps/web/proxy.ts` exempts them from this same gate.
  // Issue #242's `aw login` (ADR-0083 §8) is the third: starting the device authorization,
  // polling for the token and opening the approval page all happen before the CLI holds any
  // credential, so the proxy exempts exactly these three by method and path. The approval
  // `POST /api/auth/cli-verify` and `DELETE /api/auth/cli-token` are not exempt.
  const GET_EXEMPT = new Set([
    '/api/setup/runtime-detect',
    '/api/auth/login',
    '/api/auth/workspace',
    '/api/auth/cli-verify',
    // ADR-0120 clause 7: Vercel Cron carries no session; the route checks `CRON_SECRET` itself.
    '/api/cron/retention',
    // ADR-0144 D5: the schedule pass authenticates the same `CRON_SECRET` bearer itself.
    '/api/cron/triggers',
    // Issue #1674: the storage cleanup authenticates the same `CRON_SECRET` bearer itself.
    '/api/cron/storage-cleanup',
    // Issue #1562: the readiness probe a kubelet calls with no credential; it reveals only whether
    // the deployment is ready and, if not, which variable is wrong.
    '/api/readyz',
    // ADR-0135 amendment (#1076): the A2A agent card is public discovery metadata. Only the card is
    // exempt; the JSON-RPC route of the same agent keeps its 401 in the POST probes below.
    '/api/a2a/agents/probe-agentName/.well-known/agent-card.json',
  ]);
  const INVITATION_ACCEPT_PROBE = '/api/invitations/probe-id/accept';
  const POST_EXEMPT = new Set([
    '/api/setup',
    // Issue #1846: the aw-control door verifies a run token itself and refuses anything else.
    '/api/builder/mcp',
    '/api/auth/callback',
    '/api/auth/workspace',
    '/api/auth/cli-device',
    '/api/auth/cli-token',
    INVITATION_ACCEPT_PROBE,
    // ADR-0144: the secret in the path is the authentication; the route answers 404 without it.
    '/api/triggers/probe-id/fire/probe-secret',
  ]);
  const protectedGetProbes = probes.filter((pathname) => !GET_EXEMPT.has(pathname));

  it('probes every /api route that exists, plus the §34 inventory and unrouted paths', () => {
    // The inventory is derived, and the count is derived from the inventory.
    expect(probes.length).toBe(new Set(probes).size);
    expect(probes.length).toBeGreaterThan(0);
  });

  it.each(protectedGetProbes)('GET %s → 401', async (pathname) => {
    const response = await fetch(`${base}${pathname}`, { redirect: 'manual' });
    expect(response.status, pathname).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'unauthenticated' } });
  });

  it('forwards the A2A agent card to its handler instead of answering the session 401', async () => {
    const response = await fetch(
      `${base}/api/a2a/agents/probe-agentName/.well-known/agent-card.json`,
      { redirect: 'manual' },
    );
    expect(response.status).not.toBe(401);
    expect(await response.json()).not.toMatchObject({ error: { code: 'unauthenticated' } });
  });

  it('allows only the read-only runtime detector needed before an administrator exists', async () => {
    const response = await fetch(`${base}/api/setup/runtime-detect`, { redirect: 'manual' });
    expect(response.status, await response.clone().text()).toBe(200);
    const body: unknown = await response.json();
    expect(body).toBeTypeOf('object');
    expect(body).not.toBeNull();
    expect(Array.isArray((body as { drivers?: unknown }).drivers)).toBe(true);
  }, 15_000);

  const protectedPostProbes = probes.filter((pathname) => !POST_EXEMPT.has(pathname));

  it.each(protectedPostProbes)('POST %s → 401', async (pathname) => {
    const response = await fetch(`${base}${pathname}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', origin: base },
      body: '{}',
    });
    expect(response.status, pathname).toBe(401);
  });

  it('allows setup submission before an administrator exists', async () => {
    const response = await fetch(`${base}/api/setup`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', origin: base },
      body: '{}',
    });
    expect(response.status).not.toBe(401);
  });

  it('allows the OIDC sign-in exchange with no session — issue #118', async () => {
    for (const [method, pathname] of [
      ['GET', '/api/auth/login'],
      ['POST', '/api/auth/callback'],
      ['GET', '/api/auth/workspace'],
      ['POST', '/api/auth/workspace'],
    ] as const) {
      const init: RequestInit = {
        method,
        redirect: 'manual',
        headers: { 'content-type': 'application/json', origin: base },
      };
      const response = await fetch(
        `${base}${pathname}`,
        method === 'POST' ? { ...init, body: '{}' } : init,
      );
      // Never the gate's 401 — each of these still answers on its own terms (this server has no
      // OIDC configured, so 503/400 is what "reachable but not usable" looks like here).
      expect(response.status, `${method} ${pathname}`).not.toBe(401);
    }
  });

  it('allows the three pre-credential steps of `aw login` with no session — issue #242', async () => {
    for (const [method, pathname] of [
      ['POST', '/api/auth/cli-device'],
      ['POST', '/api/auth/cli-token'],
      ['GET', '/api/auth/cli-verify'],
    ] as const) {
      const init: RequestInit = {
        method,
        redirect: 'manual',
        headers: { 'content-type': 'application/json', origin: base },
      };
      const response = await fetch(
        `${base}${pathname}`,
        method === 'POST' ? { ...init, body: '{}' } : init,
      );
      // Never the gate's 401. This server has no database, so the CLI sign-in runtime is not
      // installed and its handlers answer `503 cli_auth_not_configured` — "reachable but not
      // usable here", as for OIDC above. `tests/no-route-answers-503.test.ts` drives the same
      // routes against a fully configured deployment, where none of them answers 503.
      expect(response.status, `${method} ${pathname}`).not.toBe(401);
    }
  });

  // ── every redirect on the sign-in path is relative, observed on the wire (issue #201) ───────
  //
  // `request.url`'s origin is the address this server is *bound* to and never the address the
  // client used, so a `Location` built from it can send the browser to a different origin than
  // the one that asked — a reverse proxy, a container port map or a plain `localhost` /
  // `127.0.0.1` alias is enough — and the cookies minted on that same response are then not sent.
  //
  // Both assertions read the header as a **whole string**. Reading it through
  // `new URL(location).pathname` is exactly what hid the original defect, because
  // `new URL('http://localhost:3000/signin').pathname` is also `/signin`.

  it('redirects an unauthenticated page visit to /signin with a relative Location', async () => {
    const response = await fetch(`${base}/`, { redirect: 'manual' });
    // 307, not 303: this is `apps/web/proxy.ts`'s gate, and preserving the method matters for a
    // non-GET request to a page path (a Server Action posts to one).
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('/signin');
    expect(response.headers.get('location')).not.toContain('://');
    expect(response.headers.get('location')).not.toContain(new URL(base).host);
    expect(response.headers.get('location')).not.toContain('localhost');
  }, 20_000);

  it('answers a route handler’s own relative Location unchanged through the whole pipeline', async () => {
    // The control for the test above: `/api/auth/workspace` is exempt from the proxy gate, so
    // this header is the one `app/api/auth/workspace/route.ts` set, carried to the wire by the
    // route pipeline rather than rewritten by the proxy adapter. It is what proves the shape
    // `apps/web/app/api/auth/callback/route.ts` now uses survives end to end.
    const response = await fetch(`${base}/api/auth/workspace`, { redirect: 'manual' });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/signin?error=session_expired');
  }, 20_000);

  it('exempts only the exact invitation acceptance POST for its route-local identity gate', async () => {
    const response = await fetch(`${base}${INVITATION_ACCEPT_PROBE}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', origin: base },
      body: '{}',
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: 'invitation_identity_required' },
    });

    const wider = await fetch(`${base}${INVITATION_ACCEPT_PROBE}/extra`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', origin: base },
      body: '{}',
    });
    expect(wider.status).toBe(401);
    expect(await wider.json()).toMatchObject({
      error: { code: 'unauthenticated', details: ['no_session_cookie'] },
    });
  });

  it('answers 401 for a path that no route handler serves — the gate runs before routing', async () => {
    const invented = `/api/${Math.random().toString(36).slice(2)}/${Math.random().toString(36).slice(2)}`;
    const response = await fetch(`${base}${invented}`, { redirect: 'manual' });
    expect(response.status).toBe(401);
  });

  it('does not authenticate the /p/ surface (spec §34)', async () => {
    for (const pathname of ['/p/some-token', '/p/some-token/messages']) {
      const response = await fetch(`${base}${pathname}`, { redirect: 'manual' });
      expect([401, 403], pathname).not.toContain(response.status);
    }
  }, 15_000);

  // The explicit budget is the one the other first-hit tests above carry, for the same reason:
  // every earlier request to `/api/agents` stopped at the proxy gate, so this is the first one to
  // reach the route, and `next dev` compiles the route's whole module graph on demand inside it.
  // That compile alone takes 2.5–3.7 s on a green CI runner and has crossed Vitest's default 5 s
  // on a slower one, so the default budget measured the runner, not the gate.
  it('lets a valid session through the gate', async () => {
    const response = await fetch(`${base}/api/agents`, {
      redirect: 'manual',
      headers: { cookie: `${sessionCookieName()}=${token}` },
    });
    // No handler exists on this branch, so "through the gate" is any status that is not the
    // gate's own. 404 is the routing layer answering, which is exactly the proof wanted.
    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
  }, 20_000);

  it('refuses a state-changing request that carries no Origin, even with a valid session', async () => {
    const response = await fetch(`${base}/api/agents`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: `${sessionCookieName()}=${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'cross_origin' } });
  });

  it('refuses a state-changing request from another origin', async () => {
    const response = await fetch(`${base}/api/agents`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie: `${sessionCookieName()}=${token}`,
        origin: 'https://evil.example',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(response.status).toBe(403);
  });

  it('rejects an expired session with 401', async () => {
    const stale = await mintSessionToken(
      newSessionClaims(
        'admin@example.com',
        'default',
        Date.now() - (SESSION_TTL_SECONDS + 60) * 1000,
      ),
      SECRET,
    );
    const response = await fetch(`${base}/api/agents`, {
      redirect: 'manual',
      headers: { cookie: `${sessionCookieName()}=${stale}` },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: 'unauthenticated', details: ['expired_session'] },
    });
  });

  // ── the second half of the acceptance criterion ────────────────────────────────────────────

  it('discovers the brand-new route by walking the tree, so the probe matrix covers it', () => {
    expect(existsSync(UNREGISTERED_ROUTE_FILE)).toBe(true);
    expect(discoverApiRouteHandlers()).toContain(UNREGISTERED_ROUTE_PATH);
    // And it reached the matrix above under its own steam. If this fails, the GET/POST 401
    // assertions for this path were never generated and their absence proved nothing.
    expect(probes).toContain(UNREGISTERED_ROUTE_PATH);
    // The tracked handlers reached it too, so the filter admits the repository's own routes and
    // is not simply returning this file's fixture back to it.
    expect(probes).toContain('/api/agents');
    expect(probes).toContain('/api/runs/probe-id/events');
  });

  it('ignores a route handler that neither git tracks nor this test wrote', () => {
    // The negative control for the membership rule, executed. A real `route.ts` on disk, under a
    // root laid out exactly like `apps/web`, is not reported — because nothing tracks it and this
    // file did not write it. That is the property that keeps `probes` stable no matter what a
    // sibling test plants under `apps/web/app/api` in a parallel worker (ADR-0019 §4).
    //
    // Built under the OS temp directory, never inside the repository: a control for a race must
    // not itself be one.
    const foreignRoot = mkdtempSync(path.join(tmpdir(), 'w1cp06-foreign-'));
    try {
      const dir = path.join(foreignRoot, 'app', 'api', 'somebody-elses-fixture');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'route.ts'), 'export function GET() {}\n', 'utf8');
      expect(existsSync(path.join(dir, 'route.ts'))).toBe(true);
      expect(discoverApiRouteHandlers(foreignRoot)).toEqual([]);
    } finally {
      rmSync(foreignRoot, { recursive: true, force: true });
    }
  });

  it.each(['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])(
    '%s on a route registered nowhere → 401, and the body never carries the canary',
    async (method) => {
      const response = await fetch(`${base}${UNREGISTERED_ROUTE_PATH}`, {
        method,
        redirect: 'manual',
      });
      expect(response.status, method).toBe(401);
      expect(await response.text(), method).not.toContain(UNREGISTERED_ROUTE_CANARY);
    },
  );

  it('serves the brand-new route to a valid session, so the 401 above was the gate', async () => {
    const response = await fetch(`${base}${UNREGISTERED_ROUTE_PATH}`, {
      redirect: 'manual',
      headers: { cookie: `${sessionCookieName()}=${token}` },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    // The handler called `requireWorkspaceScope()`, so this body is also the proof that the whole
    // module graph under index.ts compiles and runs under Turbopack with workspace.ts's one
    // type-only sibling import erased.
    expect(await response.json()).toEqual({
      canary: UNREGISTERED_ROUTE_CANARY,
      scope: { workspaceSlug: 'default', actorEmail: 'admin@example.com', role: 'owner' },
    });
  });

  // ── where an unauthenticated endpoint (a sign-in, eventually) can live ─────────────────────

  it.each(['GET', 'POST'])(
    '%s an unauthenticated handler under /p/ reaches it, with no session and no auth import',
    async (method) => {
      const response = await fetch(`${base}${PUBLIC_ROUTE_PATH}`, { method, redirect: 'manual' });
      expect(response.status, `${method}: ${await response.clone().text()}`).toBe(200);
      expect(await response.json(), method).toEqual({ reached: PUBLIC_ROUTE_MARKER });
    },
  );

  it('refuses the same handler moved under /api/, which is why sign-in cannot live there', async () => {
    // Not a hypothetical: these are the paths §34's conventions would put a sign-in at.
    for (const pathname of ['/api/auth/signin', '/api/auth/login', '/api/session', '/api/login']) {
      const response = await fetch(`${base}${pathname}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/json', origin: base },
        body: '{}',
      });
      expect(response.status, pathname).toBe(401);
    }
  });

  it('rejects a session signed with somebody else’s secret with 401', async () => {
    const forged = await mintSessionToken(
      newSessionClaims('attacker@example.com', 'other'),
      'z'.repeat(MIN_SESSION_SECRET_LENGTH),
    );
    const response = await fetch(`${base}/api/agents`, {
      redirect: 'manual',
      headers: { cookie: `${sessionCookieName()}=${forged}` },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: 'unauthenticated', details: ['invalid_signature'] },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A genuine scope's tenant cannot be mutated in place — asserted against the real object
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The half of the acceptance criterion the compiler cannot answer.
 *
 * Verification round 2 refuted the previous version of this file in one line. `readonly` is a
 * compile-time modifier and nothing else, so
 *
 * ```ts
 * Object.assign(realScope, { workspaceSlug: body.workspace });
 * ```
 *
 * compiled with no diagnostic — no cast, no `any`, under this repository's own `tsconfig.json` —
 * and at runtime replaced a genuine scope's tenant with a value out of a request body while
 * `isWorkspaceScope()` went on answering `true`. The fixture below forbade the *spread* form of
 * that on one line and said nothing about its one-token sibling.
 *
 * `Object.assign` cannot be turned into a compile error, so the property is now enforced at
 * runtime — `Object.freeze(this)` in the constructor — and asserted here against the real object
 * that `verifySessionToken` produced, by mutation route, one route per test. Each test asserts
 * two things and not one: that the attempt fails, *and* that the tenant afterwards is still the
 * one the session named. A `TypeError` that had already written the field would satisfy the
 * first alone (ADR-0015).
 */
describe('a genuine WorkspaceScope cannot have its tenant mutated in place (runtime)', () => {
  const VICTIM = 'victim-tenant';

  const realScope = async (): Promise<WorkspaceScope> => {
    const token = await mintSessionToken(newSessionClaims('admin@example.com', 'default'), SECRET);
    const result = await verifySessionToken(token, SECRET);
    if (!result.ok) throw new Error(result.reason);
    return workspaceScopeFrom(result.claims);
  };

  it('is frozen the moment it exists, which is what the routes below all run into', async () => {
    const scope = await realScope();
    expect(Object.isFrozen(scope)).toBe(true);
    expect(WorkspaceScope.isWorkspaceScope(scope)).toBe(true);
    expect(scope.workspaceSlug).toBe('default');
  });

  // One entry per mutation route a handler could plausibly write. The first is the exact line
  // verification round 2 used to refute the previous version of this property.
  type Mutation = [name: string, mutate: (scope: WorkspaceScope) => void];
  const mutations: Mutation[] = [
    [
      'Object.assign of the tenant',
      (scope): void => {
        Object.assign(scope, { workspaceSlug: VICTIM });
      },
    ],
    [
      'Object.assign of every field at once',
      (scope): void => {
        Object.assign(scope, {
          workspaceSlug: VICTIM,
          actorEmail: 'attacker@evil.test',
          role: 'owner',
        });
      },
    ],
    [
      'direct assignment',
      (scope): void => {
        (scope as { workspaceSlug: string }).workspaceSlug = VICTIM;
      },
    ],
    [
      'Object.defineProperty',
      (scope): void => {
        Object.defineProperty(scope, 'workspaceSlug', { value: VICTIM, writable: true });
      },
    ],
    [
      'Object.setPrototypeOf',
      (scope): void => {
        Object.setPrototypeOf(scope, null);
      },
    ],
    [
      'adding a field the class never declared',
      (scope): void => {
        Object.assign(scope, { workspaceId: VICTIM });
      },
    ],
    [
      'delete',
      (scope): void => {
        delete (scope as { workspaceSlug?: string }).workspaceSlug;
      },
    ],
  ];

  it.each(mutations)('refuses %s, and the tenant is unchanged afterwards', async (name, mutate) => {
    const scope = await realScope();
    expect(() => {
      mutate(scope);
    }, name).toThrow(TypeError);
    // The point of the test. A throw that had already landed the write would pass the line above.
    expect(scope.workspaceSlug, name).toBe('default');
    expect(scope.actorEmail, name).toBe('admin@example.com');
    expect(JSON.stringify(scope), name).toBe(
      '{"workspaceSlug":"default","actorEmail":"admin@example.com","role":"owner"}',
    );
    expect(WorkspaceScope.isWorkspaceScope(scope), name).toBe(true);
  });

  /**
   * The guard's other half. It used to ask only whether the private field was present, which is a
   * question about shape: an object that had been mutated still had the field and still answered
   * `true`. It now also requires the object to be frozen and each public field to equal what the
   * constructor took from the verified session.
   */
  it('answers false for every value that is shaped like a scope but is not one', async () => {
    const scope = await realScope();
    const impostors: readonly (readonly [string, unknown])[] = [
      ['Object.create(prototype)', Object.create(WorkspaceScope.prototype) as unknown],
      ['a spread copy of a real scope', { ...scope }],
      ['a JSON round-trip', JSON.parse(JSON.stringify(scope)) as unknown],
      ['a structuredClone', structuredClone(scope)],
      [
        'a hand-written literal',
        { workspaceSlug: VICTIM, actorEmail: 'attacker@evil.test', role: 'owner' },
      ],
      ['a frozen hand-written literal', Object.freeze({ workspaceSlug: VICTIM })],
      ['null', null],
      ['a number', 42],
      ['undefined', undefined],
    ];
    for (const [label, impostor] of impostors) {
      expect(WorkspaceScope.isWorkspaceScope(impostor), label).toBe(false);
    }
    // And the positive half, so this test cannot pass by the guard answering false to everything.
    expect(WorkspaceScope.isWorkspaceScope(scope)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The tenant scope cannot be built out of request data — asserted by compiling the forgeries
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Spec §25's application half rests on one property: a `WorkspaceScope` names a tenant that came
 * from a verified session and from nowhere else. Until `WorkspaceScope` and `VerifiedClaims`
 * became classes carrying `#private` fields, that property was a sentence in five comments and
 * was false — `workspaceScopeFrom({ sub: body.email, ws: body.workspace, role: 'owner', iat: 0,
 * exp: 9e9 })` compiled under `--strict` and yielded a scope for whatever tenant the request
 * body asked for.
 *
 * A property that is a compile error cannot be tested by code that compiles, so this block runs
 * the compiler. It writes a fixture whose every forgery sits on one line tagged `FORBIDDEN`,
 * runs `tsc` over it under the repository's own `tsconfig.json` (extended, not copied, so this
 * gate cannot drift from the settings the build uses), and then decides on positive assertions
 * in both directions:
 *
 *   * every `FORBIDDEN` line must carry at least one diagnostic, matched by line number, so that
 *     one forgery being rejected cannot stand in for another;
 *   * every `PERMITTED` line must carry none, so the fixture cannot pass by being broken;
 *   * every `DECLARED` line must carry none either — see below;
 *   * a diagnostic on any *other* line fails the test rather than being ignored, because an
 *     unexpected error means the fixture is not compiling for the reason claimed.
 *
 * A non-zero exit code alone would satisfy none of that, which is why it is not what is
 * asserted. ADR-0015.
 *
 * `DECLARED` is the third tag and it was added in verification round 2. It marks an escape this
 * task has *not* closed at compile time and says so in the PR's declared gaps — and rather than
 * leaving that as prose, it asserts the thing prose was claiming: that the line compiles clean.
 * Two consequences, both wanted. A gap that is described but has silently been closed fails this
 * test, so the declaration cannot go stale. And a gap that someone believes is closed cannot be
 * believed on the strength of a comment; the compiler is on record either way.
 */
describe('a WorkspaceScope cannot be forged from request data (compile-time)', () => {
  const fixtureDir = path.join(repoRoot, 'node_modules', '.w1cp06-type-negative');
  const fixtureFile = path.join(fixtureDir, 'forgery.ts');
  const posix = (value: string): string => value.split(path.sep).join('/');

  /**
   * `node_modules` because it is the one directory inside the repository that no `tsconfig.json`
   * includes, that ESLint ignores by default and that git ignores — so a fixture that must NOT
   * type-check cannot break `pnpm typecheck`, `npx eslint .` or a working tree three sessions
   * are writing to, and a crashed run leaves nothing tracked behind.
   */
  const fixtureSource = [
    "import { workspaceScopeFrom, WorkspaceScope } from '../../apps/web/server/auth/workspace.js';",
    "import { mintSessionToken, newSessionClaims, verifySessionToken } from '../../apps/web/server/auth/session.js';",
    "import type { VerifiedSessionClaims } from '../../apps/web/server/auth/session.js';",
    '',
    "const body = JSON.parse('{}') as { email: string; workspace: string; role: 'owner' };",
    '',
    '// Every shape a handler author could plausibly reach for, one per line.',
    "export const a = workspaceScopeFrom({ sub: body.email, ws: body.workspace, role: 'owner' }); // FORBIDDEN partial claims from a request body",
    'export const b = workspaceScopeFrom({ sub: body.email, ws: body.workspace, role: body.role, iat: 0, exp: 9e9 }); // FORBIDDEN complete claims from a request body',
    'export const c = workspaceScopeFrom(newSessionClaims(body.email, body.workspace)); // FORBIDDEN unverified claims laundered through newSessionClaims',
    "export const d: WorkspaceScope = { workspaceSlug: body.workspace, actorEmail: body.email, role: 'owner' }; // FORBIDDEN the scope written out as an object literal",
    'export const e = async (): Promise<WorkspaceScope> => ({ ...(await legitimate()), workspaceSlug: body.workspace }); // FORBIDDEN a real scope spread and its tenant overwritten',
    'export const f = async (c: VerifiedSessionClaims): Promise<WorkspaceScope> => workspaceScopeFrom({ ...c, ws: body.workspace }); // FORBIDDEN real claims spread and their tenant overwritten',
    'export const g = async (c: VerifiedSessionClaims): Promise<WorkspaceScope> => new WorkspaceScope(c); // FORBIDDEN the constructor called directly',
    '',
    '// Escapes this task did not close at compile time. Each is a declared gap in the PR body,',
    '// and each is asserted here to compile clean so the declaration cannot quietly go stale.',
    'export const h = async (): Promise<WorkspaceScope> => Object.assign(await legitimate(), { workspaceSlug: body.workspace }); // DECLARED Object.assign onto a real scope: no diagnostic, and a TypeError at runtime because the scope is frozen',
    "export const i = async (): Promise<WorkspaceScope> => { const s = 'x'.repeat(32); const r = await verifySessionToken(await mintSessionToken(newSessionClaims(body.email, body.workspace), s), s); if (!r.ok) throw new Error(r.reason); return workspaceScopeFrom(r.claims); }; // DECLARED a token minted and verified with a secret the caller chose",
    '',
    '// The one way that is meant to work, so a fixture that fails everywhere fails this test.',
    'export async function legitimate(): Promise<WorkspaceScope> {',
    "  const result = await verifySessionToken('token', 'x'.repeat(32));",
    '  if (!result.ok) throw new Error(result.reason);',
    '  return workspaceScopeFrom(result.claims); // PERMITTED the only derivation there is',
    '}',
  ].join('\n');

  const fixtureConfig = (): string =>
    JSON.stringify(
      {
        extends: posix(path.join(repoRoot, 'tsconfig.json')),
        compilerOptions: { noEmit: true, types: ['node'] },
        files: ['./forgery.ts'],
      },
      null,
      2,
    );

  /**
   * Line numbers are read back out of the fixture, never written down here (W0-DOC-01).
   *
   * The tag is matched on a word boundary. This was first written as a substring search for the
   * tag followed by a space, which fails open: a forgery tagged `// FORBIDDEN` with no trailing
   * description would have matched nothing, generated no test, and gone unchecked — a line added
   * to close a hole quietly not closing it. ADR-0015, inside the gate written to enforce
   * ADR-0015. The assertion below refuses any line that mentions a tag it was not matched on.
   */
  const linesTagged = (tag: string): readonly number[] => {
    const marker = new RegExp(`//\\s*${tag}\\b`, 'u');
    return fixtureSource
      .split('\n')
      .map((line, index) => (marker.test(line) ? index + 1 : 0))
      .filter((lineNumber) => lineNumber > 0);
  };

  /** Every line that so much as mentions a tag must have been matched as carrying it. */
  const linesMentioning = (tag: string): readonly number[] =>
    fixtureSource
      .split('\n')
      .map((line, index) => (line.includes(tag) ? index + 1 : 0))
      .filter((lineNumber) => lineNumber > 0);

  let diagnostics: readonly { readonly line: number; readonly text: string }[] = [];
  let rawOutput = '';

  beforeAll(() => {
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(fixtureFile, fixtureSource, 'utf8');
    writeFileSync(path.join(fixtureDir, 'tsconfig.json'), fixtureConfig(), 'utf8');

    const tsc = path.join(repoRoot, 'node_modules', '@typescript', 'native', 'bin', 'tsc');
    if (!existsSync(tsc)) throw new Error('typescript is not installed — run `pnpm install`');
    try {
      rawOutput = execFileSync(process.execPath, [tsc, '-p', fixtureDir, '--pretty', 'false'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      // A non-zero exit is the expected outcome; tsc writes its diagnostics to stdout.
      const failure = error as { stdout?: string; stderr?: string };
      rawOutput = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    }

    const pattern = /^(?<file>.+?)\((?<line>\d+),\d+\): (?<text>error TS\d+: .*)$/u;
    diagnostics = rawOutput
      .split(/\r?\n/u)
      .map((line) => pattern.exec(line))
      .filter((match) => match !== null)
      .filter((match) => posix(match.groups?.['file'] ?? '').endsWith('forgery.ts'))
      .map((match) => ({
        line: Number(match.groups?.['line']),
        text: match.groups?.['text'] ?? '',
      }));
  }, 180_000);

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('has forgeries to reject, a legitimate derivation to admit and declared gaps to record', () => {
    expect(linesTagged('FORBIDDEN').length).toBeGreaterThan(0);
    expect(linesTagged('PERMITTED').length).toBeGreaterThan(0);
    expect(linesTagged('DECLARED').length).toBeGreaterThan(0);
    // And no line mentions a tag without being picked up as carrying it, so a mistagged forgery
    // fails this test instead of quietly generating no assertion.
    expect(linesTagged('FORBIDDEN')).toEqual(linesMentioning('FORBIDDEN'));
    expect(linesTagged('PERMITTED')).toEqual(linesMentioning('PERMITTED'));
    expect(linesTagged('DECLARED')).toEqual(linesMentioning('DECLARED'));
  });

  it.each(linesTagged('FORBIDDEN'))('rejects the forgery on fixture line %i', (line) => {
    const onThisLine = diagnostics.filter((diagnostic) => diagnostic.line === line);
    expect(
      onThisLine.length,
      `no compile error on fixture line ${String(line)}. tsc said:\n${rawOutput}`,
    ).toBeGreaterThan(0);
  });

  it.each(linesTagged('PERMITTED'))('admits the legitimate derivation on line %i', (line) => {
    expect(diagnostics.filter((diagnostic) => diagnostic.line === line)).toEqual([]);
  });

  it.each(linesTagged('DECLARED'))(
    'still compiles the declared escape on line %i, so the declared gap is not stale',
    (line) => {
      expect(
        diagnostics.filter((diagnostic) => diagnostic.line === line),
        `fixture line ${String(line)} is tagged DECLARED but the compiler now rejects it. That is ` +
          'good news: close the gap in the PR body and retag the line FORBIDDEN.',
      ).toEqual([]);
    },
  );

  it('reports nothing on any line that is not tagged FORBIDDEN', () => {
    const expected = new Set(linesTagged('FORBIDDEN'));
    const unexpected = diagnostics.filter((diagnostic) => !expected.has(diagnostic.line));
    // The explicit else. Without it a fixture that failed to parse would satisfy every
    // assertion above and this gate would pass while proving nothing (ADR-0015).
    expect(unexpected, `unexpected diagnostics:\n${rawOutput}`).toEqual([]);
  });
});
