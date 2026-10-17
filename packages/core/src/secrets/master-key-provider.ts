import { loadMasterKey, type MasterKey } from './master-key.js';

export const MASTER_KEY_PROVIDER_ENV_VAR = 'MASTER_KEY_PROVIDER';

export type MasterKeyBackend = 'local-key' | 'kms' | 'secret-manager' | 'key-vault';

export interface MasterKeyProvider {
  /** Public backend name used in diagnostics. Never key material or a credential-bearing URL. */
  readonly backend: MasterKeyBackend;
  /** Load and validate the active deployment key, or reject without a degraded fallback. */
  load(): Promise<MasterKey>;
}

/** The existing development provider, retained as the backward-compatible default. */
export function createLocalMasterKeyProvider(
  env: Readonly<Record<string, string | undefined>> = process.env,
): MasterKeyProvider {
  return {
    backend: 'local-key',
    load: () => Promise.resolve(loadMasterKey(env)),
  };
}

function configuredBackend(env: Readonly<Record<string, string | undefined>>): MasterKeyBackend {
  const backend = env[MASTER_KEY_PROVIDER_ENV_VAR]?.trim() || 'local-key';
  if (
    backend === 'local-key' ||
    backend === 'kms' ||
    backend === 'secret-manager' ||
    backend === 'key-vault'
  ) {
    return backend;
  }
  throw new Error(
    `${MASTER_KEY_PROVIDER_ENV_VAR} must be one of local-key, kms, secret-manager, or key-vault.`,
  );
}

/** Select the deployment's master-key boundary without loading an unused cloud SDK. */
export async function createMasterKeyProvider(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<MasterKeyProvider> {
  switch (configuredBackend(env)) {
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
