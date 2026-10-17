import { describe, expect, it, vi } from 'vitest';

import {
  createAzureKeyVaultMasterKeyProvider,
  createAzureKeyVaultMasterKeyProviderFromConfig,
} from './azure-key-vault-master-key-provider.js';

const validKey = 'a'.repeat(64);

describe('Azure Key Vault master-key provider', () => {
  it('loads and validates a key without exposing its value', async () => {
    const getSecret = vi.fn(() => Promise.resolve({ value: validKey }));
    const key = await createAzureKeyVaultMasterKeyProvider({ getSecret }, 'master-key').load();
    expect(getSecret).toHaveBeenCalledWith('master-key');
    expect(key.key).toHaveLength(32);
    expect(key.id).toMatch(/^[0-9a-f]{16}$/u);
    expect(JSON.stringify(key)).not.toContain(validKey);
  });

  it('rejects a missing or malformed secret without echoing it', async () => {
    const secretLooking = `wrong-${'s'.repeat(48)}`;
    await expect(
      createAzureKeyVaultMasterKeyProvider(
        { getSecret: () => Promise.resolve({ value: secretLooking }) },
        'master-key',
      ).load(),
    ).rejects.not.toThrow(secretLooking);
  });

  it('retains the provider cause without putting it in the public message', async () => {
    const providerMessage = 'https://vault.example/secrets/master?credential=do-not-log';
    try {
      await createAzureKeyVaultMasterKeyProvider(
        {
          getSecret: () => Promise.reject(new Error(providerMessage)),
        },
        'master-key',
      ).load();
      expect.fail('expected the provider to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw error;
      expect(error.message).not.toContain(providerMessage);
      expect(error.cause).toBeInstanceOf(Error);
    }
  });

  it('fails closed on incomplete configuration before contacting Azure', () => {
    expect(() =>
      createAzureKeyVaultMasterKeyProviderFromConfig({
        MASTER_KEY_PROVIDER: 'key-vault',
      }),
    ).toThrow(/AZURE_KEY_VAULT_URL/u);
    expect(() =>
      createAzureKeyVaultMasterKeyProviderFromConfig({
        AZURE_KEY_VAULT_URL: 'https://vault.example',
      }),
    ).toThrow(/AZURE_MASTER_KEY_SECRET_NAME/u);
  });

  it('refuses a credential-bearing vault URL before constructing the provider', () => {
    expect(() =>
      createAzureKeyVaultMasterKeyProviderFromConfig({
        AZURE_KEY_VAULT_URL: 'https://vault.example/?sig=secret',
        AZURE_MASTER_KEY_SECRET_NAME: 'master-encryption-key',
      }),
    ).toThrow(/without credentials, a query, a path or a fragment/u);
  });
});
