import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';

import { azureProviderCall } from '../azure/safe-provider-error.js';
import { readAzureKeyVaultMasterKeyConfig } from './master-key-config.js';
import { parseMasterKeyHex } from './master-key.js';
import type { MasterKeyProvider } from './master-key-provider.js';

export interface AzureKeyVaultSecretReader {
  getSecret(name: string): Promise<{ readonly value?: string }>;
}

export function createAzureKeyVaultMasterKeyProvider(
  client: AzureKeyVaultSecretReader,
  secretName: string,
): MasterKeyProvider {
  const name = secretName.trim();
  if (name === '') throw new Error('The Azure Key Vault master-key secret name must not be blank.');
  return {
    backend: 'key-vault',
    async load() {
      const secret = await azureProviderCall('key-vault', 'master-key read', () =>
        client.getSecret(name),
      );
      return parseMasterKeyHex(secret.value, 'the Azure Key Vault master-key secret');
    },
  };
}

export function createAzureKeyVaultMasterKeyProviderFromConfig(
  env: Readonly<Record<string, string | undefined>>,
): MasterKeyProvider {
  const { vaultUrl, secretName, managedIdentityClientId } = readAzureKeyVaultMasterKeyConfig(env);
  const credential = new DefaultAzureCredential(
    managedIdentityClientId === undefined ? {} : { managedIdentityClientId },
  );
  return createAzureKeyVaultMasterKeyProvider(new SecretClient(vaultUrl, credential), secretName);
}
