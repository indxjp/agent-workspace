import { randomBytes, randomUUID } from 'node:crypto';
import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import { describe, expect, it } from 'vitest';

import {
  createAzureKeyVaultMasterKeyProvider,
  type AzureKeyVaultSecretReader,
} from './azure-key-vault-master-key-provider.js';
import { openSecret, sealSecret } from './envelope.js';
import { parseMasterKeyHex } from './master-key.js';

function requiredVaultUrl(): string {
  const value = process.env['AZURE_KEY_VAULT_LIVE_URL']?.trim();
  if (value === undefined || value === '') {
    throw new Error('AZURE_KEY_VAULT_LIVE_URL is required for the live proof.');
  }
  return value;
}

describe('Azure Key Vault live master-key proof', () => {
  it('decrypts an existing envelope after Key Vault creates a new version', async () => {
    const vaultUrl = requiredVaultUrl();
    const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
    const name = `aw-sdk16-${randomUUID().replaceAll('-', '').slice(0, 24)}`;
    const value = randomBytes(32).toString('hex');
    await client.setSecret(name, value, { contentType: 'Agent Workspace SDK-16 live proof' });
    try {
      const provider = createAzureKeyVaultMasterKeyProvider(
        client satisfies AzureKeyVaultSecretReader,
        name,
      );
      const initial = await provider.load();
      const envelope = sealSecret(initial, Buffer.from('credential-proof'));
      expect(JSON.stringify(envelope)).not.toContain(value);
      expect(() =>
        openSecret(
          parseMasterKeyHex(randomBytes(32).toString('hex'), 'unrelated proof key'),
          envelope,
        ),
      ).toThrow();

      await client.setSecret(name, value, { contentType: 'Agent Workspace SDK-16 rotation proof' });
      const afterRotation = await provider.load();
      expect(afterRotation.id).toBe(initial.id);
      expect(openSecret(afterRotation, envelope).toString()).toBe('credential-proof');
    } finally {
      const deletion = await client.beginDeleteSecret(name);
      await deletion.pollUntilDone();
    }
  }, 60_000);
});
