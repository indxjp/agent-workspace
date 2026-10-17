# ADR-0059 — Google Secret Manager holds the master key under Cloud KMS

Status: accepted
Date: 2026-09-23
Decided by: SDK migration unit 16, Google Cloud slice (#248)
Scope: `packages/core/src/secrets/`, `packages/cli/`, `infra/terraform/gcp-cloudrun/`, and the
Google Cloud deployment documentation

## Context

Every stored credential is already envelope-encrypted: a fresh AES-256 data key encrypts the
credential, and `MASTER_ENCRYPTION_KEY` wraps that data key. The database records only ciphertext,
nonces, authentication tags, and a non-secret fingerprint. In the GCP module Terraform generates
the 32-byte master key, stores it in Secret Manager, then asks Cloud Run to copy its plaintext into
the `MASTER_ENCRYPTION_KEY` environment variable. The key is cloud-hosted at rest but the running
application still selects the environment-key implementation and receives a long-lived secret in
its process environment.

The schema deliberately fixes a wrapped data key to 32 bytes plus an AES-GCM nonce and tag. Sending
each data key directly to Cloud KMS would produce a different ciphertext shape and require a
database migration that issue #248 neither anticipates nor authorises. Roadmap item D-3 instead
allows the deployment master key to live in, or be wrapped by, the cloud key service.

## Decision

1. Secrets composition selects a `MasterKeyProvider`:

   ```ts
   interface MasterKeyProvider {
     readonly backend: string;
     load(): Promise<MasterKey>;
   }
   ```

   `createSecretsService` awaits `load()` before opening PostgreSQL. `MASTER_KEY_PROVIDER` selects
   `local-key`, `kms`, `secret-manager`, or `key-vault`; an absent value retains `local-key` for
   existing deployments. Cloud modules are lazy imports, so selecting one backend does not load
   another cloud's SDK. Unknown or incompletely configured providers fail startup, never fall back.

2. The GCP provider is `secret-manager`. `GCP_MASTER_KEY_SECRET` must be a full Secret Manager
   version resource name (normally `projects/<project>/secrets/<name>/versions/latest`). The
   provider accesses it with Application Default Credentials, validates the same 64-hex/32-byte
   contract as `MASTER_ENCRYPTION_KEY`, and returns the same `MasterKey` shape. Errors never quote
   the payload or the provider's raw cause in an operator-facing message.
3. Terraform provisions a regional Cloud KMS key ring and symmetric CryptoKey beside the secret, enables automatic
   rotation, grants only the Secret Manager service agent the CryptoKey encrypter/decrypter role,
   and protects the master-key Secret Manager secret with that CMEK. The web and gateway service
   accounts retain only Secret Manager accessor rights. The web receives the resource name and
   provider selector, not `MASTER_ENCRYPTION_KEY`. `GATEWAY_TOKEN_SECRET` has separate generated
   key material and a separate Secret Manager secret; it is never an alias for the master key.
4. The database envelope and API resource do not change. A Secret Manager or Cloud KMS outage is a
   startup failure for the secrets subsystem, and the existing API remains uninstalled with its
   typed `503 secrets_runtime_not_configured` behavior.

## Rotation

Rotate the Cloud KMS CryptoKey by creating or scheduling a new primary version. Secret Manager uses
the primary version for new encryption while retaining the versions needed to decrypt existing
secret versions. The 32-byte Agent Workspace master-key plaintext and therefore its fingerprint do
not change, so every database envelope remains decryptable after the rotation. Verify application
startup and a create/resolve round trip, then keep the prior KMS version enabled until Google Cloud
reports the protected Secret Manager version no longer depends on it. Disabling or destroying a
still-required KMS version makes the master key unavailable and is deliberately not automated.

Changing the 32-byte master-key plaintext is a distinct database rewrap operation. This unit does
not claim or implement that operation; replacing the Secret Manager payload without rewrapping rows
would fail closed with `MasterKeyMismatchError`.

## Consequences

- Database theft alone is insufficient to recover a credential. The attacker also needs Secret
  Manager access and an available Cloud KMS key version.
- The raw master key no longer appears in the GCP Cloud Run environment or Terraform-rendered
  service configuration. Terraform state still contains the generated Secret Manager version
  payload, as it did before; moving secret generation outside Terraform is a separate state and
  bootstrap decision, not hidden by this change.
- `terraform destroy` schedules the Cloud KMS key versions for destruction according to Google
  Cloud's retention policy rather than being blocked by a Terraform `prevent_destroy` rule. A key
  ring is not deletable in Google Cloud, but an empty ring has no active key version to bill or use.
- Gateway currently constructs the same secrets service for provider credentials. It selects the
  same provider and receives the same Secret Manager resource name as web, so the two processes do
  not drift onto different master keys; its bearer token remains separate key material.

## Alternatives considered

- **Call Cloud KMS for every database data key.** Stronger key isolation, but incompatible with the
  existing fixed envelope columns without an unplanned migration.
- **Keep injecting the Secret Manager value into `MASTER_ENCRYPTION_KEY`.** Cloud Run can do this,
  but the application cannot distinguish the cloud provider, exercise its startup contract, or
  prove the profile's `secret-manager` selection is honored.
- **Rotate the raw master-key secret in place.** Existing rows would become undecryptable. KMS
  CryptoKey rotation gives the required cloud-key rotation without changing the envelope identity.
