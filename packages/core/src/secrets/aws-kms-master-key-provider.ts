import { DecryptCommand, KMSClient, type DecryptCommandOutput } from '@aws-sdk/client-kms';

import { AwsKmsMasterKeyError, readAwsKmsMasterKeyConfig } from './master-key-config.js';
import { masterKeyFromBytes } from './master-key.js';
import type { MasterKeyProvider } from './master-key-provider.js';

export {
  AWS_KMS_ENCRYPTED_MASTER_KEY_ENV_VAR,
  AWS_KMS_KEY_ID_ENV_VAR,
  AwsKmsMasterKeyError,
} from './master-key-config.js';

export const AWS_KMS_ENCRYPTION_CONTEXT = {
  'agent-workspace-purpose': 'master-key',
} as const;

export interface AwsKmsDecryptClient {
  send(command: DecryptCommand): Promise<DecryptCommandOutput>;
}

export interface AwsKmsMasterKeyProviderOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly client?: AwsKmsDecryptClient;
}

/** Load the deployment master key through AWS KMS without logging provider details. */
export function createAwsKmsMasterKeyProvider(
  options: AwsKmsMasterKeyProviderOptions,
): MasterKeyProvider {
  const { env } = options;

  return {
    backend: 'kms',
    async load() {
      const { keyId, ciphertext } = readAwsKmsMasterKeyConfig(env);
      const client = options.client ?? new KMSClient({});
      let output: DecryptCommandOutput;
      try {
        output = await client.send(
          new DecryptCommand({
            KeyId: keyId,
            CiphertextBlob: ciphertext,
            EncryptionContext: AWS_KMS_ENCRYPTION_CONTEXT,
            EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
          }),
        );
      } catch (cause) {
        throw new AwsKmsMasterKeyError(
          'AWS KMS could not decrypt the deployment master key. Verify the key id, encryption ' +
            'context, region and workload identity.',
          { cause },
        );
      }
      if (output.Plaintext === undefined) {
        throw new AwsKmsMasterKeyError('AWS KMS returned no plaintext master key.');
      }
      try {
        return masterKeyFromBytes(output.Plaintext);
      } catch (cause) {
        throw new AwsKmsMasterKeyError('AWS KMS returned a master key that is not 32 bytes.', {
          cause,
        });
      }
    },
  };
}
