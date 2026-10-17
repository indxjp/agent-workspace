import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createGoogleSecretManagerMasterKeyProvider,
  GoogleSecretManagerMasterKeyError,
} from './google-secret-manager-master-key.js';

const SECRET_VERSION = 'projects/example/secrets/agent-workspace-master/versions/latest';
const KEY_HEX = '2a'.repeat(32);

describe('Google Secret Manager master-key provider', () => {
  it('loads a 32-byte hex key and derives the existing non-secret fingerprint', async () => {
    const provider = createGoogleSecretManagerMasterKeyProvider({
      secretVersion: SECRET_VERSION,
      accessSecretVersion: () => Promise.resolve(new TextEncoder().encode(KEY_HEX)),
    });

    const key = await provider.load();
    expect(provider.backend).toBe('secret-manager');
    expect(key.key).toEqual(Buffer.from(KEY_HEX, 'hex'));
    expect(key.id).toBe(createHash('sha256').update(key.key).digest('hex').slice(0, 16));
  });

  it('refuses an imprecise resource name before making a provider call', () => {
    let calls = 0;
    expect(() =>
      createGoogleSecretManagerMasterKeyProvider({
        secretVersion: 'agent-workspace-master',
        accessSecretVersion: () => {
          calls += 1;
          return Promise.resolve(new Uint8Array());
        },
      }),
    ).toThrow(GoogleSecretManagerMasterKeyError);
    expect(calls).toBe(0);
  });

  it('refuses missing, malformed, non-UTF-8 and wrong-length payloads', async () => {
    const payloads = [
      new Uint8Array(),
      new TextEncoder().encode('not-hex'),
      new TextEncoder().encode('aa'),
      Uint8Array.of(0xff),
    ];
    for (const payload of payloads) {
      const provider = createGoogleSecretManagerMasterKeyProvider({
        secretVersion: SECRET_VERSION,
        accessSecretVersion: () => Promise.resolve(payload),
      });
      await expect(provider.load()).rejects.toThrow(GoogleSecretManagerMasterKeyError);
    }
  });

  it('never repeats a provider error or secret-looking payload in its public message', async () => {
    const secret = 'sk-secret-that-must-not-appear';
    const providerFailure = createGoogleSecretManagerMasterKeyProvider({
      secretVersion: SECRET_VERSION,
      accessSecretVersion: () => Promise.reject(new Error(`provider included ${secret}`)),
    });
    const malformedPayload = createGoogleSecretManagerMasterKeyProvider({
      secretVersion: SECRET_VERSION,
      accessSecretVersion: () => Promise.resolve(new TextEncoder().encode(secret)),
    });

    for (const provider of [providerFailure, malformedPayload]) {
      try {
        await provider.load();
        expect.fail('expected the provider to refuse the key');
      } catch (error) {
        expect(error).toBeInstanceOf(GoogleSecretManagerMasterKeyError);
        if (!(error instanceof Error)) throw error;
        expect(error.message).not.toContain(secret);
      }
    }
  });
});
