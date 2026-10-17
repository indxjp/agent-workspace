import { describe, expect, it } from 'vitest';

import { isOAuthRoute } from './oauth-routes';

describe('isOAuthRoute', () => {
  it('admits exactly the OAuth server routes, by method and path', () => {
    for (const [method, path] of [
      ['GET', '/.well-known/oauth-authorization-server'],
      ['GET', '/.well-known/oauth-protected-resource/mcp/projects/docs'],
      ['GET', '/.well-known/oauth-protected-resource/api/a2a/agents/helper'],
      ['GET', '/oauth/authorize'],
      ['POST', '/oauth/authorize'],
      ['POST', '/oauth/token'],
      ['POST', '/oauth/revoke'],
    ] as const) {
      expect(isOAuthRoute(method, path), `${method} ${path}`).toBe(true);
    }
  });

  it('treats HEAD as the GET it shadows', () => {
    expect(isOAuthRoute('HEAD', '/.well-known/oauth-authorization-server')).toBe(true);
    expect(isOAuthRoute('HEAD', '/oauth/token')).toBe(false);
  });

  it('refuses other methods, other depths and look-alike prefixes', () => {
    for (const [method, path] of [
      ['GET', '/oauth/token'],
      ['POST', '/.well-known/oauth-authorization-server'],
      ['DELETE', '/oauth/authorize'],
      ['POST', '/oauth/token/extra'],
      ['POST', '/oauth/tokenx'],
      ['POST', '/oauth'],
      ['GET', '/oauth/'],
      ['GET', '/.well-known/oauth-protected-resource/mcp/projects/a/b'],
      ['GET', '/.well-known/oauth-protected-resource/mcp/projects'],
      ['GET', '/.well-known/oauth-protected-resource/api/runs/x'],
      ['GET', '/.well-known/openid-configuration'],
      ['POST', '/api/oauth/token'],
    ] as const) {
      expect(isOAuthRoute(method, path), `${method} ${path}`).toBe(false);
    }
  });
});
