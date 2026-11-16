import { describe, expect, it } from 'vitest';
import { checkRequestOrigin } from '../apps/web/server/auth/origin.js';
import { classifyPath, enforcementFor, type Surface } from '../apps/web/server/auth/paths.js';

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
