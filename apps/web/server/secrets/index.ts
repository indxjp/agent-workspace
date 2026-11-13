/**
 * The secrets context's public entry (refactoring plan part 04, step 7).
 *
 * Code in another context imports secrets from here, not from the modules underneath.
 * `pnpm architecture:check` enforces it: the `context-secrets-entered-through-its-entry` rule in
 * dependency-cruiser.config.mjs refuses a new deep import. Tests, `composition/` and the secrets
 * modules themselves keep importing the modules directly.
 *
 * Other contexts use the naming rules for platform-owned secrets (storage connection and webhook
 * signing secrets), which live in `contract.ts`. Importing this file loads `contract.ts`, the
 * storage-connection prefix it re-exports and `zod`; nothing with start-up work. No deep import was
 * left when the entry landed.
 *
 * No secrets module imports this file: that would be a cycle, and `no-circular-dependencies`
 * refuses it.
 */
export {
  isPlatformOwnedSecretName,
  isUuid,
  STORAGE_CONNECTION_SECRET_PREFIX,
  storageConnectionIdOf,
  webhookSigningSecretName,
} from './contract';
