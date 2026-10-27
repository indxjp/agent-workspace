/**
 * `@agent-workspace/core/secrets` — envelope-encrypted secrets under a deployment master key,
 * spec §23 and §26. See `service.ts` for the composition root and its ordering guarantee, and
 * `resolve.ts` for why decrypting a value is not exported next to the write-facing methods.
 *
 * `apps/web/server/secrets/**` is the only intended importer of this subpath in this wave; a
 * future task (W2-CP-05) is expected to reach `SecretsService.resolveByName` the same way.
 */
export { ENVELOPE_ALGORITHM, KEY_BYTES, NONCE_BYTES, TAG_BYTES } from './crypto.js';
export {
  MASTER_KEY_ENV_VAR,
  MASTER_KEY_EXPECTED_FORMAT,
  MalformedMasterKeyError,
  loadMasterKey,
  parseMasterKeyHex,
  type MasterKey,
} from './master-key.js';
export {
  createLocalMasterKeyProvider,
  createMasterKeyProvider,
  MASTER_KEY_PROVIDER_ENV_VAR,
  type MasterKeyBackend,
  type MasterKeyProvider,
} from './master-key-provider.js';
export { MasterKeyMismatchError, type SecretEnvelope } from './envelope.js';
export {
  createDatabaseSecretsRepositoryProvider,
  createInMemorySecretsRepositoryProvider,
  type CreateSecretInput,
  type CreateSecretOutcome,
  type DeleteSecretOutcome,
  type SecretReferrers,
  type ReplaceSecretOutcome,
  type SecretMetadata,
  type SecretsRepository,
  type SecretsRepositoryProvider,
} from './repository.js';
export type { ResolvedSecret } from './resolve.js';
export {
  createInMemorySecretsService,
  createSecretsService,
  type CreateSecretsServiceOptions,
  type CreateSecretRequest,
  type SecretsService,
} from './service.js';
