import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

import {
  checkGoogleSecretVersion,
  GoogleSecretManagerMasterKeyError,
  readGoogleSecretManagerSecretVersion,
} from './master-key-config.js';
import { parseMasterKeyHex, type MasterKey } from './master-key.js';
import type { MasterKeyProvider } from './master-key-provider.js';

export { GoogleSecretManagerMasterKeyError } from './master-key-config.js';

export interface GoogleSecretManagerMasterKeyOptions {
  readonly secretVersion: string;
  readonly accessSecretVersion: (name: string) => Promise<Uint8Array>;
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
  checkGoogleSecretVersion(options.secretVersion);
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
  const secretVersion = readGoogleSecretManagerSecretVersion(env);
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
