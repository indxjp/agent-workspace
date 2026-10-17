import { describe, expect, it } from 'vitest';

import { MASTER_KEY_ENV_VAR } from './master-key.js';
import { createMasterKeyProvider, MASTER_KEY_PROVIDER_ENV_VAR } from './master-key-provider.js';

describe('master-key provider selection', () => {
  it('preserves local-key as the compatibility default', async () => {
    const provider = await createMasterKeyProvider({ [MASTER_KEY_ENV_VAR]: 'ab'.repeat(32) });
    expect(provider.backend).toBe('local-key');
    await expect(provider.load()).resolves.toMatchObject({
      key: Buffer.from('ab'.repeat(32), 'hex'),
    });
  });

  it('selects Key Vault explicitly without requiring a local key', async () => {
    const provider = await createMasterKeyProvider({
      [MASTER_KEY_PROVIDER_ENV_VAR]: 'key-vault',
      AZURE_KEY_VAULT_URL: 'https://example.vault.azure.net',
      AZURE_MASTER_KEY_SECRET_NAME: 'master-encryption-key',
    });
    expect(provider.backend).toBe('key-vault');
  });

  it('selects AWS KMS without loading local key material', async () => {
    const provider = await createMasterKeyProvider({
      [MASTER_KEY_PROVIDER_ENV_VAR]: 'kms',
    });
    expect(provider.backend).toBe('kms');
  });

  it('refuses an unknown provider without echoing its value', async () => {
    const secretLooking = 'unexpected-secret-do-not-print';
    await expect(
      createMasterKeyProvider({ [MASTER_KEY_PROVIDER_ENV_VAR]: secretLooking }),
    ).rejects.toThrow(/must be one of/u);
    await expect(
      createMasterKeyProvider({ [MASTER_KEY_PROVIDER_ENV_VAR]: secretLooking }),
    ).rejects.not.toThrow(secretLooking);
  });
});
