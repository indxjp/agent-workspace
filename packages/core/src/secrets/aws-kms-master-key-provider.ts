import { DecryptCommand, KMSClient, type DecryptCommandOutput } from '@aws-sdk/client-kms';

import { masterKeyFromBytes } from './master-key.js';
import type { MasterKeyProvider } from './master-key-provider.js';

export const AWS_KMS_KEY_ID_ENV_VAR = 'AWS_KMS_KEY_ID';
export const AWS_KMS_ENCRYPTED_MASTER_KEY_ENV_VAR = 'AWS_KMS_ENCRYPTED_MASTER_KEY';
export const AWS_KMS_ENCRYPTION_CONTEXT = {
  'agent-workspace-purpose': 'master-key',
} as const;

export interface AwsKmsDecryptClient {
  send(command: DecryptCommand): Promise<DecryptCommandOutput>;
}

export interface AwsKmsMasterKeyProviderOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly client?: AwsKmsDecryptClient;
}

/** A safe startup failure whose message contains no AWS response or configured key material. */
export class AwsKmsMasterKeyError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AwsKmsMasterKeyError';
  }
}

function requiredConfig(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AwsKmsMasterKeyError(`${name} is required when MASTER_KEY_PROVIDER=kms.`);
  }
  return value.trim();
}

function decodeCiphertext(value: string): Uint8Array {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw new AwsKmsMasterKeyError(
      `${AWS_KMS_ENCRYPTED_MASTER_KEY_ENV_VAR} must be canonical base64.`,
    );
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== value) {
    throw new AwsKmsMasterKeyError(
      `${AWS_KMS_ENCRYPTED_MASTER_KEY_ENV_VAR} must be non-empty canonical base64.`,
    );
  }
  return decoded;
}

/** Load the deployment master key through AWS KMS without logging provider details. */
export function createAwsKmsMasterKeyProvider(
  options: AwsKmsMasterKeyProviderOptions = {},
): MasterKeyProvider {
  const env = options.env ?? process.env;

  return {
    backend: 'kms',
    async load() {
      const keyId = requiredConfig(env, AWS_KMS_KEY_ID_ENV_VAR);
      const ciphertext = decodeCiphertext(
        requiredConfig(env, AWS_KMS_ENCRYPTED_MASTER_KEY_ENV_VAR),
      );
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
