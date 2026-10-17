# ADR-0061 — Azure Key Vault provides the deployment master key

Status: accepted
Date: 2026-09-23
Decided by: SDK migration unit 16, Azure slice (#248)
Scope: `packages/core/src/secrets/`, `packages/cli/`,
`infra/terraform/azure-container-apps/`, Azure deployment documentation

## Context

Every stored credential is envelope-encrypted under a 32-byte deployment master key. Before this
decision, every deployment injects that key as `MASTER_ENCRYPTION_KEY`; Azure Terraform stores it
in Key Vault but Container Apps copies the plaintext into the process environment. D-3 requires a
native cloud key backend selected by `storage.secrets`, with a documented rotation and proof that
database contents alone cannot recover a credential.

The existing database envelope is deliberately fixed: a per-secret random data key is wrapped by
AES-256-GCM and the row stores its 32-byte ciphertext, 12-byte nonce, 16-byte tag and a non-secret
master-key fingerprint. Replacing those columns with a provider ciphertext would require an
unanticipated migration and would make the persistence shape provider-specific.

## Decision

The envelope and schema stay unchanged. A new `MasterKeyProvider` port loads the deployment's
active 32-byte key before the secrets service opens PostgreSQL. `local-key` wraps the existing
environment parser; `key-vault` uses `DefaultAzureCredential` and `SecretClient` to read a named
Key Vault secret. Selection is explicit through `MASTER_KEY_PROVIDER`; omission remains
backward-compatible `local-key`, while an unknown or incompletely configured provider fails
closed before a database connection.

The Key Vault secret value is the same 64-hex-character AES key the local provider accepts. Its
value is never logged, returned, written to the deployment profile, or copied into a Container App
secret. The stored `master_key_id` remains its SHA-256 fingerprint, so existing envelopes and API
resources do not change.

Azure rotation has two layers:

1. Azure's service-managed encryption keys rotate without changing the Key Vault secret value.
   Restarting the workload reloads the same 32-byte master key, so every existing database
   envelope remains decryptable and its fingerprint remains stable.
2. Rotating the Agent Workspace master-key plaintext is a separate rewrap operation. It must not
   disable the old value until every stored data key has been rewrapped and no row names the old
   fingerprint. This slice does not pretend that changing the secret value alone performs that
   database operation.

Terraform continues to create the master-key secret but stops projecting it into
`MASTER_ENCRYPTION_KEY`. The web and gateway identities keep their existing secret-scoped
`Key Vault Secrets User` grants and receive only the vault URL and secret name as non-secret
environment values. No sandbox or runner identity can read it.

## Alternatives rejected

- **Inject the Key Vault value as `MASTER_ENCRYPTION_KEY`.** That is the current transport, not a
  native provider: the application cannot distinguish Key Vault from a hand-written environment
  value and the plaintext remains in process environment configuration.
- **Wrap each data key directly with an RSA Key Vault key.** It would change the database envelope
  widths and algorithms, requiring a migration the issue did not anticipate.
- **Generate a new master key whenever Key Vault rotates.** Existing rows would immediately become
  unreadable. Provider-service rotation and application-key rewrap are different operations.

## Consequences

- A database dump cannot decrypt credentials without both Key Vault data-plane access and the
  configured secret.
- Startup now includes one bounded Key Vault read before PostgreSQL. Failure is explicit and never
  falls back to `MASTER_ENCRYPTION_KEY` when `key-vault` was selected.
- The master key exists in process memory because local AES-GCM wraps data keys. It no longer exists
  in the process environment for the Azure profile.
- A future plaintext-key rotation needs a repository operation that rewraps every data key. Until
  that operation exists, the runbook rotates Key Vault's service-managed protection, not the
  application key value.

