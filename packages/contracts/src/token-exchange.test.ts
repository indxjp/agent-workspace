import { describe, expect, it } from 'vitest';

import {
  ACCESS_TOKEN_TYPE,
  ID_TOKEN_TYPE,
  OAUTH_ACCESS_TOKEN_PATTERN,
  SUBJECT_TOKEN_MAX_LENGTH,
  TOKEN_EXCHANGE_GRANT_TYPE,
  TOKEN_EXCHANGE_PROBLEM_CODES,
  TOKEN_EXCHANGE_TTL_SECONDS,
  TokenExchangeRequestSchema,
  TokenExchangeResponseSchema,
} from './token-exchange.js';

const ACCESS_TOKEN = `awo_live_${'a'.repeat(22)}_${'b'.repeat(43)}`;

const request = {
  grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
  subject_token: 'header.payload.signature',
  subject_token_type: ID_TOKEN_TYPE,
};

const response = {
  access_token: ACCESS_TOKEN,
  issued_token_type: ACCESS_TOKEN_TYPE,
  token_type: 'Bearer',
  expires_in: TOKEN_EXCHANGE_TTL_SECONDS,
};

describe('the token-exchange limits (ADR-0161 D2, D3)', () => {
  it('pins the lifetime at 300 seconds and the ID token at 16 KiB', () => {
    expect(TOKEN_EXCHANGE_TTL_SECONDS).toBe(300);
    expect(SUBJECT_TOKEN_MAX_LENGTH).toBe(16 * 1024);
  });

  it('spells the RFC 8693 identifiers exactly', () => {
    expect(TOKEN_EXCHANGE_GRANT_TYPE).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    expect(ID_TOKEN_TYPE).toBe('urn:ietf:params:oauth:token-type:id_token');
    expect(ACCESS_TOKEN_TYPE).toBe('urn:ietf:params:oauth:token-type:access_token');
  });
});

describe('TokenExchangeRequestSchema', () => {
  it('accepts an ID token, with or without requested_token_type', () => {
    expect(TokenExchangeRequestSchema.safeParse(request).success).toBe(true);
    expect(
      TokenExchangeRequestSchema.safeParse({ ...request, requested_token_type: ACCESS_TOKEN_TYPE })
        .success,
    ).toBe(true);
  });

  it('is strict: audience, resource, scope, actor_token and a body secret are refused', () => {
    for (const extra of ['audience', 'resource', 'scope', 'actor_token', 'client_secret']) {
      expect(TokenExchangeRequestSchema.safeParse({ ...request, [extra]: 'x' }).success).toBe(
        false,
      );
    }
  });

  it('refuses another grant, token type or requested type', () => {
    expect(
      TokenExchangeRequestSchema.safeParse({ ...request, grant_type: 'client_credentials' })
        .success,
    ).toBe(false);
    expect(
      TokenExchangeRequestSchema.safeParse({ ...request, subject_token_type: ACCESS_TOKEN_TYPE })
        .success,
    ).toBe(false);
    expect(
      TokenExchangeRequestSchema.safeParse({ ...request, requested_token_type: ID_TOKEN_TYPE })
        .success,
    ).toBe(false);
  });

  it('refuses an empty subject token and one over 16 KiB', () => {
    expect(TokenExchangeRequestSchema.safeParse({ ...request, subject_token: '' }).success).toBe(
      false,
    );
    const atLimit = 'a'.repeat(SUBJECT_TOKEN_MAX_LENGTH);
    expect(
      TokenExchangeRequestSchema.safeParse({ ...request, subject_token: atLimit }).success,
    ).toBe(true);
    expect(
      TokenExchangeRequestSchema.safeParse({ ...request, subject_token: `${atLimit}a` }).success,
    ).toBe(false);
  });
});

describe('TokenExchangeResponseSchema', () => {
  it('accepts the documented answer', () => {
    expect(TokenExchangeResponseSchema.safeParse(response).success).toBe(true);
  });

  it('is strict: no refresh_token and no scope', () => {
    expect(TokenExchangeResponseSchema.safeParse({ ...response, refresh_token: 'x' }).success).toBe(
      false,
    );
    expect(TokenExchangeResponseSchema.safeParse({ ...response, scope: 'endpoint' }).success).toBe(
      false,
    );
  });

  it('requires an awo_live_ access token and a lifetime of at most 300 s', () => {
    expect(
      TokenExchangeResponseSchema.safeParse({ ...response, access_token: 'awu_live_x' }).success,
    ).toBe(false);
    expect(TokenExchangeResponseSchema.safeParse({ ...response, expires_in: 301 }).success).toBe(
      false,
    );
  });
});

describe('OAUTH_ACCESS_TOKEN_PATTERN', () => {
  it('matches the fixed-length halves and captures the secret', () => {
    expect(OAUTH_ACCESS_TOKEN_PATTERN.exec(ACCESS_TOKEN)?.[2]).toBe('b'.repeat(43));
    expect(OAUTH_ACCESS_TOKEN_PATTERN.test(`${ACCESS_TOKEN}x`)).toBe(false);
    expect(OAUTH_ACCESS_TOKEN_PATTERN.test(ACCESS_TOKEN.replace('awo_', 'awr_'))).toBe(false);
  });
});

describe('TOKEN_EXCHANGE_PROBLEM_CODES', () => {
  it('equals ADR-0161 D7 table', () => {
    expect(TOKEN_EXCHANGE_PROBLEM_CODES).toEqual({
      token_exchange_not_configured: 503,
      invalid_client: 401,
      subject_token_invalid: 401,
      subject_token_wrong_issuer: 401,
      subject_token_wrong_audience: 401,
      subject_not_member: 403,
      rate_limited: 429,
    });
  });
});
