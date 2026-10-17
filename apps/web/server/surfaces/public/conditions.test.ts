import { describe, expect, it } from 'vitest';

import type { SurfaceDefinition } from '@indx-workspace/contracts/surfaces';

import {
  frameAncestorsFor,
  hostWithoutPort,
  mayOpenSession,
  type SurfaceConditionEnvironment,
} from './conditions';

const LOCAL_ENV = { AW_LOCAL_SURFACE_SESSIONS: '1', HOST: '127.0.0.1' } as const;
const SAME_ORIGIN = {
  host: '127.0.0.1:4310',
  origin: 'http://127.0.0.1:4310',
  'sec-fetch-site': 'same-origin',
} as const;

function headers(values: Readonly<Record<string, string>>): Headers {
  return new Headers(values);
}

const LOOPBACK = { ok: true, branch: 'loopback', corsOrigin: null } as const;

/** The loopback branch alone: a surface that lists no origins. */
const session = (env: SurfaceConditionEnvironment, values: Headers) =>
  mayOpenSession(null, values, env, 'session');
const page = (env: SurfaceConditionEnvironment, values: Headers) =>
  mayOpenSession(null, values, env, 'page');

describe('mayOpenSession, the loopback branch: ADR-0105 slice 1 (S1-17, #455)', () => {
  it('passes a same-origin loopback request to a local runtime', () => {
    expect(session(LOCAL_ENV, headers(SAME_ORIGIN))).toEqual(LOOPBACK);
    expect(page(LOCAL_ENV, headers({ host: 'localhost:4310' }))).toEqual(LOOPBACK);
  });

  it.each([
    ['unset', {}],
    ['0', { AW_LOCAL_SURFACE_SESSIONS: '0' }],
    ['true', { AW_LOCAL_SURFACE_SESSIONS: 'true' }],
    ['" 1"', { AW_LOCAL_SURFACE_SESSIONS: ' 1' }],
  ])('fails the flag when it is %s', (_label, flag) => {
    const env = { HOST: '127.0.0.1', ...flag };
    expect(session(env, headers(SAME_ORIGIN))).toEqual({
      ok: false,
      failed: 'flag',
    });
  });

  it.each([
    ['unset', { AW_LOCAL_SURFACE_SESSIONS: '1' }],
    ['blank', { AW_LOCAL_SURFACE_SESSIONS: '1', HOST: '  ' }],
    ['every interface', { AW_LOCAL_SURFACE_SESSIONS: '1', HOST: '0.0.0.0' }],
    ['a LAN address', { AW_LOCAL_SURFACE_SESSIONS: '1', HOST: '192.168.1.10' }],
  ])('fails the listen host when HOST is %s', (_label, env) => {
    expect(session(env, headers(SAME_ORIGIN))).toEqual({
      ok: false,
      failed: 'listen-host',
    });
  });

  it('accepts an IPv6 loopback listen host', () => {
    const env = { AW_LOCAL_SURFACE_SESSIONS: '1', HOST: '::1' };
    expect(page(env, headers({ host: '[::1]:4310' }))).toEqual(LOOPBACK);
  });

  it.each([
    ['a container id', '3f2a9c1b7d4e'],
    ['a machine name', 'fedora-laptop'],
    ['every interface', '0.0.0.0'],
  ])('ignores an inherited HOSTNAME (%s), which the local runtime never binds', (_label, name) => {
    const env = { ...LOCAL_ENV, AW_DEPLOYMENT_POSTURE: 'local', HOSTNAME: name };
    expect(session(env, headers(SAME_ORIGIN))).toEqual(LOOPBACK);
  });

  it.each([
    ['equal to Host, as Next.js sets it on every request', '127.0.0.1:4310', '127.0.0.1:4310'],
    ['equal to Host in another case, padded', 'localhost:4310', ' LOCALHOST:4310 '],
  ])('accepts a forwarded host %s', (_label, host, forwarded) => {
    const values = {
      ...SAME_ORIGIN,
      host,
      origin: `http://${host}`,
      'x-forwarded-host': forwarded,
    };
    expect(session(LOCAL_ENV, headers(values))).toEqual(LOOPBACK);
    expect(page(LOCAL_ENV, headers(values))).toEqual(LOOPBACK);
  });

  it.each([
    ['a public host', { ...SAME_ORIGIN, host: 'example.com' }],
    ['a LAN host with a port', { ...SAME_ORIGIN, host: '10.0.0.5:4310' }],
    ['a forwarded public host', { ...SAME_ORIGIN, 'x-forwarded-host': 'example.com' }],
    ['a forwarded host on another port', { ...SAME_ORIGIN, 'x-forwarded-host': '127.0.0.1:80' }],
    ['a forwarded list', { ...SAME_ORIGIN, 'x-forwarded-host': '127.0.0.1:4310, example.com' }],
    ['an empty forwarded host', { ...SAME_ORIGIN, 'x-forwarded-host': '' }],
    ['a list', { ...SAME_ORIGIN, host: '127.0.0.1, example.com' }],
    ['an unclosed IPv6 bracket', { ...SAME_ORIGIN, host: '[::1:4310' }],
  ])('fails the request host for %s', (_label, values) => {
    expect(session(LOCAL_ENV, headers(values))).toEqual({
      ok: false,
      failed: 'request-host',
    });
  });

  it('fails the request host when the Host header is missing', () => {
    expect(page(LOCAL_ENV, headers({}))).toEqual({
      ok: false,
      failed: 'request-host',
    });
  });

  it.each([
    ['no Origin', { host: SAME_ORIGIN.host }],
    ['Origin: null', { ...SAME_ORIGIN, origin: 'null' }],
    ['another origin', { ...SAME_ORIGIN, origin: 'http://evil.example' }],
    ['another loopback port', { ...SAME_ORIGIN, origin: 'http://127.0.0.1:9999' }],
    ['Sec-Fetch-Site: cross-site', { ...SAME_ORIGIN, 'sec-fetch-site': 'cross-site' }],
    ['Sec-Fetch-Site: same-site', { ...SAME_ORIGIN, 'sec-fetch-site': 'same-site' }],
  ])('fails same origin with %s', (_label, values) => {
    expect(session(LOCAL_ENV, headers(values))).toEqual({
      ok: false,
      failed: 'same-origin',
    });
  });

  it('accepts a same-origin request without Sec-Fetch-Site', () => {
    const { host, origin } = SAME_ORIGIN;
    expect(session(LOCAL_ENV, headers({ host, origin }))).toEqual(LOOPBACK);
  });

  it('does not check the origin for the page', () => {
    expect(page(LOCAL_ENV, headers({ host: SAME_ORIGIN.host, origin: 'null' }))).toEqual(LOOPBACK);
  });

  it('reports the first failing condition', () => {
    expect(session({ HOST: '0.0.0.0' }, headers({}))).toEqual({
      ok: false,
      failed: 'flag',
    });
    expect(session({ AW_LOCAL_SURFACE_SESSIONS: '1' }, headers({ host: 'x' }))).toEqual({
      ok: false,
      failed: 'listen-host',
    });
  });

  it.each([
    ['localhost:3000', 'localhost'],
    ['127.0.0.1', '127.0.0.1'],
    ['[::1]:3000', '[::1]'],
    ['[::1]', '[::1]'],
    ['::1', '::1'],
    ['[::1]x', null],
    ['host:port', null],
    ['', null],
  ])('reads the host of %j as %j', (value, expected) => {
    expect(hostWithoutPort(value)).toBe(expected);
  });
});

describe('mayOpenSession, the allowed-origin branch (#622)', () => {
  const SHOP = 'https://shop.example.com';
  const LISTED: SurfaceDefinition = { name: 'main', agent: 'support', allowedOrigins: [SHOP] };
  const DEPLOYED = { host: 'aw.example.com' } as const;

  it('admits a cross-origin request from a listed origin, with that origin for CORS', () => {
    const values = headers({ ...DEPLOYED, origin: SHOP, 'sec-fetch-site': 'cross-site' });
    expect(mayOpenSession(LISTED, values, {}, 'session')).toEqual({
      ok: true,
      branch: 'allowed-origin',
      corsOrigin: SHOP,
    });
  });

  it('admits the hosted page framed by a listed origin: same origin as this control plane', () => {
    const values = headers({
      ...DEPLOYED,
      origin: 'https://aw.example.com',
      'sec-fetch-site': 'same-origin',
    });
    expect(mayOpenSession(LISTED, values, {}, 'session')).toEqual({
      ok: true,
      branch: 'allowed-origin',
      corsOrigin: null,
    });
  });

  it('admits the hosted page behind an ingress that rewrites Host, by X-Forwarded-Host', () => {
    const values = headers({
      host: 'web:3000',
      'x-forwarded-host': 'aw.example.com',
      origin: 'https://aw.example.com',
      'sec-fetch-site': 'same-origin',
    });
    expect(mayOpenSession(LISTED, values, {}, 'session')).toEqual({
      ok: true,
      branch: 'allowed-origin',
      corsOrigin: null,
    });
  });

  it('refuses a rewritten Host whose X-Forwarded-Host names another host', () => {
    const values = headers({
      host: 'web:3000',
      'x-forwarded-host': 'other.example.com',
      origin: 'https://aw.example.com',
      'sec-fetch-site': 'same-origin',
    });
    expect(mayOpenSession(LISTED, values, {}, 'session')).toEqual({
      ok: false,
      failed: 'origin-not-allowed',
    });
  });

  it.each([
    ['another origin', { origin: 'https://evil.example' }],
    ['a listed origin with a path', { origin: `${SHOP}/` }],
    ['no Origin', {}],
    ['Origin: null', { origin: 'null' }],
    [
      'a same-host Origin sent cross-site',
      { origin: 'https://aw.example.com', 'sec-fetch-site': 'cross-site' },
    ],
  ])('refuses %s with origin-not-allowed', (_label, extra) => {
    expect(mayOpenSession(LISTED, headers({ ...DEPLOYED, ...extra }), {}, 'session')).toEqual({
      ok: false,
      failed: 'origin-not-allowed',
    });
  });

  it('refuses a surface with no list off loopback with the failed loopback condition', () => {
    const values = headers({ ...DEPLOYED, origin: SHOP });
    const unlisted: SurfaceDefinition = { name: 'main', agent: 'support' };
    expect(mayOpenSession(unlisted, values, {}, 'session')).toEqual({ ok: false, failed: 'flag' });
  });

  it('serves the page of a listed surface off loopback without reading Origin', () => {
    expect(mayOpenSession(LISTED, headers(DEPLOYED), {}, 'page')).toEqual({
      ok: true,
      branch: 'allowed-origin',
      corsOrigin: null,
    });
  });

  it('keeps the loopback branch first for a listed surface on a local runtime', () => {
    expect(mayOpenSession(LISTED, headers(SAME_ORIGIN), LOCAL_ENV, 'session')).toEqual(LOOPBACK);
  });

  it.each([
    [null, "frame-ancestors 'self'"],
    [{ name: 'main', agent: 'support' }, "frame-ancestors 'self'"],
    [LISTED, `frame-ancestors 'self' ${SHOP}`],
    [
      { ...LISTED, allowedOrigins: [SHOP, 'http://127.0.0.1:4000'] },
      `frame-ancestors 'self' ${SHOP} http://127.0.0.1:4000`,
    ],
  ] as const)('derives frame-ancestors from %j', (surface, expected) => {
    expect(frameAncestorsFor(surface)).toBe(expected);
  });
});

describe('mayOpenSession, the local default origins (#699)', () => {
  const UNLISTED: SurfaceDefinition = { name: 'main', agent: 'support' };
  const cross = (origin: string): Headers =>
    headers({ host: '127.0.0.1:3000', origin, 'sec-fetch-site': 'same-site' });

  it.each([
    'http://localhost:5173',
    'http://localhost',
    'http://127.0.0.1:4000',
    'http://127.0.0.1:65535',
  ])('lets the local environment allow %s on any port, as CORS', (origin) => {
    expect(mayOpenSession(UNLISTED, cross(origin), LOCAL_ENV, 'session', 'local')).toEqual({
      ok: true,
      branch: 'allowed-origin',
      corsOrigin: origin,
    });
  });

  it.each([
    'https://localhost:5173',
    'http://localhost.evil.example',
    'http://localhost:5173/',
    'http://localhost:99999x',
    'http://[::1]:5173',
    'https://shop.example.com',
    'null',
  ])('refuses %s even in the local environment', (origin) => {
    expect(mayOpenSession(UNLISTED, cross(origin), LOCAL_ENV, 'session', 'local').ok).toBe(false);
  });

  it.each([
    ['no local flag', { HOST: '127.0.0.1' }],
    ['a listener that is not loopback', { AW_LOCAL_SURFACE_SESSIONS: '1', HOST: '0.0.0.0' }],
    ['no environment', {}],
  ])('allows no local origin with %s', (_label, env) => {
    expect(
      mayOpenSession(UNLISTED, cross('http://localhost:5173'), env, 'session', 'local').ok,
    ).toBe(false);
  });

  it('refuses a local origin on a request addressed to another host', () => {
    const values = headers({ host: 'example.com', origin: 'http://localhost:5173' });
    expect(mayOpenSession(UNLISTED, values, LOCAL_ENV, 'session', 'local')).toEqual({
      ok: false,
      failed: 'request-host',
    });
  });

  it.each([
    ['the production version', 'production'],
    ['a version of unknown environment', null],
  ] as const)('gives no default to %s, even in the local environment (#733)', (_label, from) => {
    expect(
      mayOpenSession(UNLISTED, cross('http://localhost:5173'), LOCAL_ENV, 'session', from),
    ).toEqual({
      ok: false,
      failed: 'same-origin',
    });
  });

  it('grants nothing for a surface that is not served', () => {
    expect(
      mayOpenSession(null, cross('http://localhost:5173'), LOCAL_ENV, 'session', 'local').ok,
    ).toBe(false);
  });

  it('lets an explicit allowedOrigins list win: it does not gain the local origins', () => {
    const listed: SurfaceDefinition = { ...UNLISTED, allowedOrigins: ['https://shop.example.com'] };
    expect(
      mayOpenSession(listed, cross('http://localhost:5173'), LOCAL_ENV, 'session', 'local'),
    ).toEqual({
      ok: false,
      failed: 'origin-not-allowed',
    });
    expect(
      mayOpenSession(listed, cross('https://shop.example.com'), LOCAL_ENV, 'session', 'local'),
    ).toMatchObject({ ok: true, corsOrigin: 'https://shop.example.com' });
  });
});
