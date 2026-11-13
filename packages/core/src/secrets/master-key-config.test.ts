import { describe, expect, it } from 'vitest';

import {
  AwsKmsMasterKeyError,
  configuredMasterKeyBackend,
  readAwsKmsMasterKeyConfig,
  readAzureKeyVaultMasterKeyConfig,
} from './master-key-config.js';

describe('configuredMasterKeyBackend', () => {
  it('defaults to local-key when unset or blank, and trims a name', () => {
    expect(configuredMasterKeyBackend({})).toBe('local-key');
    expect(configuredMasterKeyBackend({ MASTER_KEY_PROVIDER: '  ' })).toBe('local-key');
    expect(configuredMasterKeyBackend({ MASTER_KEY_PROVIDER: ' kms ' })).toBe('kms');
  });
});

describe('readAwsKmsMasterKeyConfig', () => {
  const env = { AWS_KMS_KEY_ID: ' key ', AWS_KMS_ENCRYPTED_MASTER_KEY: 'AAAA' };

  it('reads the trimmed key id and the decoded ciphertext', () => {
    const config = readAwsKmsMasterKeyConfig(env);
    expect(config.keyId).toBe('key');
    expect([...config.ciphertext]).toEqual([0, 0, 0]);
  });

  it('refuses base64 that does not round-trip, without quoting it', () => {
    // `AB==` matches the base64 alphabet but decodes to one byte that encodes as `AA==`.
    const read = () => readAwsKmsMasterKeyConfig({ ...env, AWS_KMS_ENCRYPTED_MASTER_KEY: 'AB==' });
    expect(read).toThrow(AwsKmsMasterKeyError);
    expect(read).toThrow(/AWS_KMS_ENCRYPTED_MASTER_KEY must be non-empty canonical base64/u);
    expect(read).not.toThrow(/AB==/u);
  });
});

describe('readAzureKeyVaultMasterKeyConfig', () => {
  const env = {
    AZURE_KEY_VAULT_URL: 'https://vault.example.net/',
    AZURE_MASTER_KEY_SECRET_NAME: 'master-key',
  };

  it('reads the vault origin without its trailing slash', () => {
    expect(readAzureKeyVaultMasterKeyConfig(env)).toEqual({
      vaultUrl: 'https://vault.example.net',
      secretName: 'master-key',
      managedIdentityClientId: undefined,
    });
  });

  it('refuses a vault URL with a path', () => {
    expect(() =>
      readAzureKeyVaultMasterKeyConfig({
        ...env,
        AZURE_KEY_VAULT_URL: 'https://vault.example.net/x',
      }),
    ).toThrow(/AZURE_KEY_VAULT_URL must be an HTTPS Key Vault URL without/u);
  });

  it('passes a trimmed managed identity, and treats a blank one as unset', () => {
    expect(
      readAzureKeyVaultMasterKeyConfig({ ...env, AZURE_CLIENT_ID: ' id ' }).managedIdentityClientId,
    ).toBe('id');
    expect(
      readAzureKeyVaultMasterKeyConfig({ ...env, AZURE_CLIENT_ID: ' ' }).managedIdentityClientId,
    ).toBeUndefined();
  });
});
