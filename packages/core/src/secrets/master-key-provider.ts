import { configuredMasterKeyBackend, type MasterKeyBackend } from './master-key-config.js';
import { loadMasterKey, type MasterKey } from './master-key.js';

export { MASTER_KEY_PROVIDER_ENV_VAR, type MasterKeyBackend } from './master-key-config.js';

export interface MasterKeyProvider {
  /** Public backend name used in diagnostics. Never key material or a credential-bearing URL. */
  readonly backend: MasterKeyBackend;
  /** Load and validate the active deployment key, or reject without a degraded fallback. */
  load(): Promise<MasterKey>;
}

/** The existing development provider, retained as the backward-compatible default. */
export function createLocalMasterKeyProvider(
  env: Readonly<Record<string, string | undefined>>,
): MasterKeyProvider {
  return {
    backend: 'local-key',
    load: () => Promise.resolve(loadMasterKey(env)),
  };
}

/** Select the deployment's master-key boundary without loading an unused cloud SDK. */
export async function createMasterKeyProvider(
  env: Readonly<Record<string, string | undefined>>,
): Promise<MasterKeyProvider> {
  switch (configuredMasterKeyBackend(env)) {
    case 'local-key':
      return createLocalMasterKeyProvider(env);
    case 'kms': {
      const aws = await import('./aws-kms-master-key-provider.js');
      return aws.createAwsKmsMasterKeyProvider({ env });
    }
    case 'secret-manager': {
      const google = await import('./google-secret-manager-master-key.js');
      return google.createGoogleSecretManagerMasterKeyProviderFromEnvironment(env);
    }
    case 'key-vault': {
      const azure = await import('./azure-key-vault-master-key-provider.js');
      return azure.createAzureKeyVaultMasterKeyProviderFromConfig(env);
    }
  }
}
