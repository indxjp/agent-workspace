import { describe, expect, it } from 'vitest';

import {
  API_KEY_DISPLAY_PREFIX_PATTERN,
  API_KEY_ID_LENGTH,
  API_KEY_NAME_MAX_LENGTH,
  API_KEY_PATTERN,
  API_KEY_PREFIX,
  API_KEY_SECRET_LENGTH,
  ApiKeyListResponseSchema,
  ApiKeyResourceSchema,
  ApiKeyResponseSchema,
  MintedApiKeyResponseSchema,
} from './api-keys.js';

const KEY_ID = 'AbCdEfGhIjKlMnOpQrStUv';
const SECRET = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';
const PRESENTED = `${API_KEY_PREFIX}${KEY_ID}_${SECRET}`;

const apiKey = {
  id: '88888888-8888-4888-8888-888888888888',
  name: 'ci-deploy',
  role: 'builder',
  keyPrefix: `${API_KEY_PREFIX}${KEY_ID}`,
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  createdAt: '2026-09-21T10:00:00.000Z',
};

/** A copy of `source` with one key absent — the "missing field" case. */
function without(source: object, field: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...source };
  delete copy[field];
  return copy;
}

describe('API key shape constants', () => {
  it('spell §22’s prefix and the two base64url lengths of a presented key', () => {
    expect(API_KEY_PREFIX).toBe('ak_live_');
    expect(API_KEY_ID_LENGTH).toBe(22);
    expect(API_KEY_SECRET_LENGTH).toBe(43);
    expect(API_KEY_NAME_MAX_LENGTH).toBe(120);
    expect(API_KEY_PATTERN.test(PRESENTED)).toBe(true);
    expect(API_KEY_PATTERN.test(`${API_KEY_PREFIX}${KEY_ID}`)).toBe(false);
    expect(API_KEY_DISPLAY_PREFIX_PATTERN.test(`${API_KEY_PREFIX}${KEY_ID}`)).toBe(true);
    expect(API_KEY_DISPLAY_PREFIX_PATTERN.test(PRESENTED)).toBe(false);
  });
});

describe('ApiKeyResourceSchema', () => {
  it('accepts a live key, an expiring one, a used one and a revoked one', () => {
    expect(ApiKeyResourceSchema.safeParse(apiKey).success).toBe(true);
    expect(
      ApiKeyResourceSchema.safeParse({
        ...apiKey,
        lastUsedAt: '2026-09-21T11:00:00.000Z',
        expiresAt: '2027-01-01T00:00:00.000Z',
        revokedAt: '2026-09-21T12:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('rejects a secret under any name, the hash, and any unknown key', () => {
    expect(ApiKeyResourceSchema.safeParse({ ...apiKey, key: PRESENTED }).success).toBe(false);
    expect(ApiKeyResourceSchema.safeParse({ ...apiKey, secret: SECRET }).success).toBe(false);
    expect(ApiKeyResourceSchema.safeParse({ ...apiKey, keyHash: 'deadbeef' }).success).toBe(false);
    expect(ApiKeyResourceSchema.safeParse({ ...apiKey, workspaceId: 'w' }).success).toBe(false);
  });

  it('rejects a whole key where the display prefix belongs, a wrong type and a missing field', () => {
    expect(ApiKeyResourceSchema.safeParse({ ...apiKey, keyPrefix: PRESENTED }).success).toBe(false);
    expect(ApiKeyResourceSchema.safeParse({ ...apiKey, keyPrefix: 'sk-ant-x' }).success).toBe(
      false,
    );
    expect(ApiKeyResourceSchema.safeParse({ ...apiKey, role: 'root' }).success).toBe(false);
    expect(ApiKeyResourceSchema.safeParse({ ...apiKey, expiresAt: 1_757_000_000 }).success).toBe(
      false,
    );
    expect(ApiKeyResourceSchema.safeParse(without(apiKey, 'revokedAt')).success).toBe(false);
    expect(ApiKeyResourceSchema.safeParse({ ...apiKey, name: '' }).success).toBe(false);
  });
});

describe('API key envelopes', () => {
  it('reads the list and the wrapped revoke answer, refusing a bare item', () => {
    expect(ApiKeyListResponseSchema.safeParse({ apiKeys: [apiKey] }).success).toBe(true);
    expect(ApiKeyListResponseSchema.safeParse({ apiKeys: [apiKey], key: PRESENTED }).success).toBe(
      false,
    );
    expect(ApiKeyResponseSchema.safeParse({ apiKey }).success).toBe(true);
    expect(ApiKeyResponseSchema.safeParse(apiKey).success).toBe(false);
  });

  it('reads the mint response and only there accepts the whole key, once', () => {
    const minted = { apiKey, key: PRESENTED, warning: 'This is the only time this key is shown.' };
    expect(MintedApiKeyResponseSchema.safeParse(minted).success).toBe(true);
    expect(MintedApiKeyResponseSchema.safeParse(without(minted, 'key')).success).toBe(false);
    expect(MintedApiKeyResponseSchema.safeParse(without(minted, 'warning')).success).toBe(false);
    expect(MintedApiKeyResponseSchema.safeParse({ ...minted, key: 'not-a-key' }).success).toBe(
      false,
    );
    expect(
      MintedApiKeyResponseSchema.safeParse({ ...minted, apiKey: { ...apiKey, key: PRESENTED } })
        .success,
    ).toBe(false);
    expect(MintedApiKeyResponseSchema.safeParse({ ...minted, secret: SECRET }).success).toBe(false);
  });
});
