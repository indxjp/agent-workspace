import { describe, expect, it } from 'vitest';

import { runCallerOf } from './caller';
import type { RunPrincipal } from './environment';

const base: RunPrincipal = {
  principalId: 'principal-1',
  ownerPrincipalId: 'principal-1',
  userId: 'user-1',
  workspaceId: 'workspace-1',
  scope: null,
};

describe('runCallerOf (ADR-0142 D2)', () => {
  it('is the member itself for a signed-in user, a user token and a browser token', () => {
    for (const via of ['session', 'user-token', 'browser-token', 'oauth-token'] as const) {
      expect(runCallerOf({ ...base, via, kind: 'membership' }, undefined)).toEqual({
        sub: 'principal-1',
        principalKind: 'membership',
      });
    }
  });

  it('is the subject an API key names, and nothing without one', () => {
    const key = { ...base, via: 'api-key' as const, kind: 'api_key' as const };
    expect(runCallerOf(key, 'customer-42')).toEqual({
      sub: 'customer-42',
      principalKind: 'api-key',
    });
    expect(runCallerOf(key, undefined)).toBeNull();
  });

  it('fails closed for a browser token minted by a key and for a principal without via/kind', () => {
    expect(runCallerOf({ ...base, via: 'browser-token', kind: 'api_key' }, undefined)).toBeNull();
    expect(runCallerOf(base, undefined)).toBeNull();
  });

  it("asserts a membership-owned trigger's subject as an api-key caller (ADR-0156)", () => {
    expect(runCallerOf({ ...base, via: 'session', kind: 'membership' }, 'alice')).toEqual({
      sub: 'alice',
      principalKind: 'api-key',
    });
  });
});
