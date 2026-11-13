/**
 * How the master-key providers read the environment (refactoring part 03).
 *
 * Every master-key variable is read here, and only here, so `@agent-workspace/core/settings` can
 * list them in the generated settings table without loading a cloud SDK. Each provider file calls
 * these readers, so a provider and the table can never disagree about a name or a rule.
 *
 * No message quotes a value: a key id, a ciphertext or a vault URL never belongs in a log line.
 */

export type MasterKeyEnvironment = Readonly<Record<string, string | undefined>>;

export const MASTER_KEY_PROVIDER_ENV_VAR = 'MASTER_KEY_PROVIDER';

export type MasterKeyBackend = 'local-key' | 'kms' | 'secret-manager' | 'key-vault';

/** The configured backend; unset or blank means `local-key`. Refuses any other name. */
export function configuredMasterKeyBackend(env: MasterKeyEnvironment): MasterKeyBackend {
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

// --- AWS KMS --------------------------------------------------------------------------------

export const AWS_KMS_KEY_ID_ENV_VAR = 'AWS_KMS_KEY_ID';
export const AWS_KMS_ENCRYPTED_MASTER_KEY_ENV_VAR = 'AWS_KMS_ENCRYPTED_MASTER_KEY';

/** A safe startup failure whose message contains no AWS response or configured key material. */
export class AwsKmsMasterKeyError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AwsKmsMasterKeyError';
  }
}

function requiredAwsKmsConfig(env: MasterKeyEnvironment, name: string): string {
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

export interface AwsKmsMasterKeyConfig {
  readonly keyId: string;
  readonly ciphertext: Uint8Array;
}

/** The KMS key id and the decoded encrypted master key. Refuses a missing or non-canonical value. */
export function readAwsKmsMasterKeyConfig(env: MasterKeyEnvironment): AwsKmsMasterKeyConfig {
  const keyId = requiredAwsKmsConfig(env, AWS_KMS_KEY_ID_ENV_VAR);
  const ciphertext = decodeCiphertext(
    requiredAwsKmsConfig(env, AWS_KMS_ENCRYPTED_MASTER_KEY_ENV_VAR),
  );
  return { keyId, ciphertext };
}

// --- Google Secret Manager ------------------------------------------------------------------

const GCP_MASTER_KEY_SECRET_ENV_VAR = 'GCP_MASTER_KEY_SECRET';

const SECRET_VERSION_PATTERN =
  /^projects\/[^/]+\/secrets\/[^/]+\/versions\/(?:latest|[1-9][0-9]*)$/u;

export class GoogleSecretManagerMasterKeyError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'GoogleSecretManagerMasterKeyError';
  }
}

/** Refuses anything but a full `projects/…/secrets/…/versions/…` resource name. */
export function checkGoogleSecretVersion(secretVersion: string): string {
  if (!SECRET_VERSION_PATTERN.test(secretVersion)) {
    throw new GoogleSecretManagerMasterKeyError(
      `${GCP_MASTER_KEY_SECRET_ENV_VAR} must be a full projects/<project>/secrets/<secret>/versions/<version> resource name.`,
    );
  }
  return secretVersion;
}

/** The secret version holding the master key. Refuses a missing value; the shape is checked by the provider. */
export function readGoogleSecretManagerSecretVersion(env: MasterKeyEnvironment): string {
  const secretVersion = env[GCP_MASTER_KEY_SECRET_ENV_VAR]?.trim();
  if (secretVersion === undefined || secretVersion === '') {
    throw new GoogleSecretManagerMasterKeyError(
      `${GCP_MASTER_KEY_SECRET_ENV_VAR} is required when MASTER_KEY_PROVIDER=secret-manager.`,
    );
  }
  return secretVersion;
}

// --- Azure Key Vault ------------------------------------------------------------------------

const AZURE_KEY_VAULT_URL_ENV_VAR = 'AZURE_KEY_VAULT_URL';
const AZURE_MASTER_KEY_SECRET_NAME_ENV_VAR = 'AZURE_MASTER_KEY_SECRET_NAME';
const AZURE_CLIENT_ID_ENV_VAR = 'AZURE_CLIENT_ID';

function requiredAzureConfig(env: MasterKeyEnvironment, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === '') {
    throw new Error(`${name} is required when MASTER_KEY_PROVIDER=key-vault.`);
  }
  return value;
}

export interface AzureKeyVaultMasterKeyConfig {
  /** The vault's origin, with no trailing `/`. */
  readonly vaultUrl: string;
  readonly secretName: string;
  /** The user-assigned managed identity, when one is named. */
  readonly managedIdentityClientId: string | undefined;
}

/** The vault, the secret name and the managed identity. Refuses a URL that is not a bare HTTPS origin. */
export function readAzureKeyVaultMasterKeyConfig(
  env: MasterKeyEnvironment,
): AzureKeyVaultMasterKeyConfig {
  const vaultUrl = requiredAzureConfig(env, AZURE_KEY_VAULT_URL_ENV_VAR);
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
  const secretName = requiredAzureConfig(env, AZURE_MASTER_KEY_SECRET_NAME_ENV_VAR);
  const clientId = env[AZURE_CLIENT_ID_ENV_VAR]?.trim();
  return {
    vaultUrl: parsed.toString().replace(/\/$/u, ''),
    secretName,
    managedIdentityClientId: clientId === undefined || clientId === '' ? undefined : clientId,
  };
}
