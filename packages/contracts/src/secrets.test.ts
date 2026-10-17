import { describe, expect, it } from 'vitest';

import {
  SECRET_NAME_MAX_LENGTH,
  SECRET_NAME_PATTERN,
  SECRET_VALUE_MAX_LENGTH,
  SecretListResponseSchema,
  SecretResourceSchema,
} from './secrets.js';

const secret = {
  id: '88888888-8888-4888-8888-888888888888',
  name: 'ANTHROPIC_API_KEY',
  algorithm: 'aes-256-gcm',
  masterKeyId: 'local-dev-key-1',
  createdAt: '2026-09-21T10:00:00.000Z',
  updatedAt: '2026-09-21T10:05:00.000Z',
};

describe('SecretResourceSchema', () => {
  it('accepts the metadata the routes render', () => {
    expect(SecretResourceSchema.safeParse(secret).success).toBe(true);
  });

  it('refuses a body that carries the value under any spelling', () => {
    expect(SecretResourceSchema.safeParse({ ...secret, value: 'sk-ant-…' }).success).toBe(false);
    expect(SecretResourceSchema.safeParse({ ...secret, plaintext: 'sk-ant-…' }).success).toBe(
      false,
    );
    expect(SecretResourceSchema.safeParse({ ...secret, ciphertext: 'AAAA' }).success).toBe(false);
  });

  it('rejects an unknown key, a wrong type, and a missing field', () => {
    expect(SecretResourceSchema.safeParse({ ...secret, workspaceId: 'w' }).success).toBe(false);
    expect(SecretResourceSchema.safeParse({ ...secret, createdAt: 1_700_000_000 }).success).toBe(
      false,
    );
    expect(SecretResourceSchema.safeParse({ ...secret, algorithm: null }).success).toBe(false);
    const withoutMasterKey = Object.fromEntries(
      Object.entries(secret).filter(([key]) => key !== 'masterKeyId'),
    );
    expect(SecretResourceSchema.safeParse(withoutMasterKey).success).toBe(false);
  });

  it('holds the name to the database shape and its length bound', () => {
    expect(SecretResourceSchema.safeParse({ ...secret, name: 'github_token' }).success).toBe(false);
    expect(SecretResourceSchema.safeParse({ ...secret, name: '1ST' }).success).toBe(false);
    expect(SecretResourceSchema.safeParse({ ...secret, name: '' }).success).toBe(false);
    const longest = `A${'B'.repeat(SECRET_NAME_MAX_LENGTH - 1)}`;
    expect(SecretResourceSchema.safeParse({ ...secret, name: longest }).success).toBe(true);
    expect(SecretResourceSchema.safeParse({ ...secret, name: `${longest}C` }).success).toBe(false);
  });
});

describe('SecretListResponseSchema', () => {
  it('reads an empty list and a populated one, and refuses a value inside an item', () => {
    expect(SecretListResponseSchema.safeParse({ secrets: [] }).success).toBe(true);
    expect(SecretListResponseSchema.safeParse({ secrets: [secret] }).success).toBe(true);
    expect(
      SecretListResponseSchema.safeParse({ secrets: [{ ...secret, value: 'x' }] }).success,
    ).toBe(false);
    expect(SecretListResponseSchema.safeParse([secret]).success).toBe(false);
    expect(SecretListResponseSchema.safeParse({ secrets: [secret], total: 1 }).success).toBe(false);
  });
});

describe('bounds', () => {
  it('publishes the name shape and the value bound the route enforces', () => {
    expect(SECRET_NAME_PATTERN.test('A'.repeat(SECRET_NAME_MAX_LENGTH))).toBe(true);
    expect(SECRET_NAME_PATTERN.test('A'.repeat(SECRET_NAME_MAX_LENGTH + 1))).toBe(false);
    expect(SECRET_VALUE_MAX_LENGTH).toBe(65_536);
  });
});
