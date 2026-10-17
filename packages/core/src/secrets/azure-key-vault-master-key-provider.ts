import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';

import { azureProviderCall } from '../azure/safe-provider-error.js';
import { parseMasterKeyHex } from './master-key.js';
import type { MasterKeyProvider } from './master-key-provider.js';

const AZURE_KEY_VAULT_URL_ENV_VAR = 'AZURE_KEY_VAULT_URL';
const AZURE_MASTER_KEY_SECRET_NAME_ENV_VAR = 'AZURE_MASTER_KEY_SECRET_NAME';

export interface AzureKeyVaultSecretReader {
  getSecret(name: string): Promise<{ readonly value?: string }>;
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === '') {
    throw new Error(`${name} is required when MASTER_KEY_PROVIDER=key-vault.`);
  }
  return value;
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
  const vaultUrl = required(env, AZURE_KEY_VAULT_URL_ENV_VAR);
  let parsed: URL;
  try {
    parsed = new URL(vaultUrl);
  } catch {
    throw new Error(`${AZURE_KEY_VAULT_URL_ENV_VAR} must be an HTTPS Key Vault URL.`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (parsed.pathname !== '' && parsed.pathname !== '/')
  ) {
    throw new Error(
      `${AZURE_KEY_VAULT_URL_ENV_VAR} must be an HTTPS Key Vault URL without credentials, a query, a path or a fragment.`,
    );
  }
  const secretName = required(env, AZURE_MASTER_KEY_SECRET_NAME_ENV_VAR);
  const managedIdentityClientId = env['AZURE_CLIENT_ID']?.trim();
  const credential = new DefaultAzureCredential(
    managedIdentityClientId === undefined || managedIdentityClientId === ''
      ? {}
      : { managedIdentityClientId },
  );
  return createAzureKeyVaultMasterKeyProvider(
    new SecretClient(parsed.toString().replace(/\/$/u, ''), credential),
    secretName,
  );
}
