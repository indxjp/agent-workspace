import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

import { parseMasterKeyHex, type MasterKey } from './master-key.js';
import type { MasterKeyProvider } from './master-key-provider.js';

const GCP_MASTER_KEY_SECRET_ENV_VAR = 'GCP_MASTER_KEY_SECRET';

const SECRET_VERSION_PATTERN =
  /^projects\/[^/]+\/secrets\/[^/]+\/versions\/(?:latest|[1-9][0-9]*)$/u;

export interface GoogleSecretManagerMasterKeyOptions {
  readonly secretVersion: string;
  readonly accessSecretVersion: (name: string) => Promise<Uint8Array>;
}

export class GoogleSecretManagerMasterKeyError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'GoogleSecretManagerMasterKeyError';
  }
}

function decodePayload(payload: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch (error) {
    throw new GoogleSecretManagerMasterKeyError(
      'Google Secret Manager returned a master key that is not UTF-8 text.',
      error,
    );
  }
}

/** Build a provider around an injected Secret Manager read, which keeps its CI suite offline. */
export function createGoogleSecretManagerMasterKeyProvider(
  options: GoogleSecretManagerMasterKeyOptions,
): MasterKeyProvider {
  if (!SECRET_VERSION_PATTERN.test(options.secretVersion)) {
    throw new GoogleSecretManagerMasterKeyError(
      `${GCP_MASTER_KEY_SECRET_ENV_VAR} must be a full projects/<project>/secrets/<secret>/versions/<version> resource name.`,
    );
  }
  return {
    backend: 'secret-manager',
    async load(): Promise<MasterKey> {
      let payload: Uint8Array;
      try {
        payload = await options.accessSecretVersion(options.secretVersion);
      } catch (error) {
        throw new GoogleSecretManagerMasterKeyError(
          'Google Secret Manager could not supply the deployment master key.',
          error,
        );
      }
      try {
        return parseMasterKeyHex(decodePayload(payload), 'the Google Secret Manager master key');
      } catch (error) {
        if (error instanceof GoogleSecretManagerMasterKeyError) throw error;
        throw new GoogleSecretManagerMasterKeyError(
          'Google Secret Manager returned a master key that is not a 32-byte hex value.',
          error,
        );
      }
    },
  };
}

export function createGoogleSecretManagerMasterKeyProviderFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): MasterKeyProvider {
  const secretVersion = env[GCP_MASTER_KEY_SECRET_ENV_VAR]?.trim();
  if (secretVersion === undefined || secretVersion === '') {
    throw new GoogleSecretManagerMasterKeyError(
      `${GCP_MASTER_KEY_SECRET_ENV_VAR} is required when MASTER_KEY_PROVIDER=secret-manager.`,
    );
  }
  return createGoogleSecretManagerMasterKeyProvider({
    secretVersion,
    async accessSecretVersion(name): Promise<Uint8Array> {
      const client = new SecretManagerServiceClient();
      try {
        const [response] = await client.accessSecretVersion({ name });
        const data = response.payload?.data;
        if (data === undefined || data === null) {
          throw new GoogleSecretManagerMasterKeyError(
            'Google Secret Manager returned a version with no payload.',
          );
        }
        return typeof data === 'string' ? Buffer.from(data, 'base64') : data;
      } finally {
        await client.close();
      }
    },
  });
}
