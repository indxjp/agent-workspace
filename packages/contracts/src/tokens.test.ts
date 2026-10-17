import { describe, expect, it } from 'vitest';

import {
  BROWSER_TOKEN_PATTERN,
  BROWSER_TOKEN_PREFIX,
  MintTokenRequestSchema,
  MintTokenResponseSchema,
  TokenScopeSchema,
} from './tokens.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const RUN_SCOPE = { kind: 'run', id: RUN_ID } as const;
const VALID_TOKEN = `${BROWSER_TOKEN_PREFIX}${'a'.repeat(22)}_${'b'.repeat(43)}`;

describe('TokenScopeSchema', () => {
  it('accepts a run or a session scope and rejects an unknown kind or an unknown key', () => {
    expect(TokenScopeSchema.safeParse({ kind: 'run', id: RUN_ID }).success).toBe(true);
    expect(TokenScopeSchema.safeParse({ kind: 'session', id: SESSION_ID }).success).toBe(true);
    expect(TokenScopeSchema.safeParse({ kind: 'workspace', id: RUN_ID }).success).toBe(false);
    expect(TokenScopeSchema.safeParse({ kind: 'run', id: RUN_ID, extra: 1 }).success).toBe(false);
    expect(TokenScopeSchema.safeParse({ kind: 'run' }).success).toBe(false);
  });

  it('rejects an id that is not a UUID, so no malformed id is ever sent to a uuid column', () => {
    for (const id of ['', 'abc', 'run_1', `${RUN_ID} `, `${RUN_ID}x`]) {
      expect(TokenScopeSchema.safeParse({ kind: 'run', id }).success, id).toBe(false);
    }
  });
});

describe('BROWSER_TOKEN_PATTERN', () => {
  it('matches only the anchored fixed-length shape', () => {
    expect(BROWSER_TOKEN_PATTERN.test(VALID_TOKEN)).toBe(true);
    expect(BROWSER_TOKEN_PATTERN.test('ak_live_x')).toBe(false);
    expect(BROWSER_TOKEN_PATTERN.test(`${VALID_TOKEN}\n`)).toBe(false);
  });
});

describe('MintTokenRequestSchema', () => {
  it('accepts a bare scope and a scope with a bounded ttlSeconds', () => {
    expect(MintTokenRequestSchema.safeParse({ scope: RUN_SCOPE }).success).toBe(true);
    expect(MintTokenRequestSchema.safeParse({ scope: RUN_SCOPE, ttlSeconds: 300 }).success).toBe(
      true,
    );
  });

  it('rejects an unknown key and a missing scope', () => {
    expect(MintTokenRequestSchema.safeParse({}).success).toBe(false);
    expect(MintTokenRequestSchema.safeParse({ scope: RUN_SCOPE, extra: 1 }).success).toBe(false);
  });

  it('bounds ttlSeconds at 59/60/3600/3601', () => {
    expect(MintTokenRequestSchema.safeParse({ scope: RUN_SCOPE, ttlSeconds: 59 }).success).toBe(
      false,
    );
    expect(MintTokenRequestSchema.safeParse({ scope: RUN_SCOPE, ttlSeconds: 60 }).success).toBe(
      true,
    );
    expect(MintTokenRequestSchema.safeParse({ scope: RUN_SCOPE, ttlSeconds: 3600 }).success).toBe(
      true,
    );
    expect(MintTokenRequestSchema.safeParse({ scope: RUN_SCOPE, ttlSeconds: 3601 }).success).toBe(
      false,
    );
  });
});

describe('MintTokenResponseSchema', () => {
  const valid = {
    token: VALID_TOKEN,
    scope: RUN_SCOPE,
    expiresAt: '2026-01-01T00:00:00.000Z',
    warning: 'shown once',
  };

  it('accepts the mint response and rejects a malformed token or an unknown key', () => {
    expect(MintTokenResponseSchema.safeParse(valid).success).toBe(true);
    expect(MintTokenResponseSchema.safeParse({ ...valid, token: 'not-a-token' }).success).toBe(
      false,
    );
    expect(MintTokenResponseSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(
      MintTokenResponseSchema.safeParse({
        token: valid.token,
        scope: valid.scope,
        expiresAt: valid.expiresAt,
      }).success,
    ).toBe(false);
  });
});
