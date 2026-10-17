# ADR-0057 — AWS KMS wraps the deployment master key

Status: accepted
Date: 2026-09-23
Decided by: SDK migration unit 16, AWS slice (#248)
Scope: `packages/core/src/secrets/`, the deployment profile and AWS/EKS operator documentation

## Context

Roadmap item D-3 requires the master key to live in, or be wrapped by, each cloud's key service,
selected by `storage.secrets`, with a documented rotation procedure. Today every secret row holds a
per-secret data key wrapped by a 32-byte deployment master key loaded directly from
`MASTER_ENCRYPTION_KEY`. The row schema also records AES-GCM nonces and tags for that wrapping.

AWS KMS can either wrap that existing deployment key once or replace the inner wrapping operation
for every row. Replacing it per row would make secret create and resolve network-dependent, require
a database migration because KMS ciphertext blobs do not use the row's AES-GCM nonce/tag fields,
and couple every credential read to KMS availability. Wrapping the deployment key keeps the
existing envelope and schema while removing plaintext master-key material from deployment config.

## Decision

Introduce a common asynchronous provider seam:

```ts
interface MasterKeyProvider {
  readonly backend: string;
  load(): Promise<MasterKey>;
}
```

`MASTER_KEY_PROVIDER` selects the profile vocabulary directly. Omitted or `local-key` preserves the
development provider and reads `MASTER_ENCRYPTION_KEY`; `kms` selects the AWS implementation. The
secrets service awaits the selected provider before opening PostgreSQL, preserving the existing
fail-closed startup order. Cloud implementations live in separate modules so later GCP and Azure
slices can add `secret-manager` and `key-vault` without importing their SDKs on another backend.

The AWS provider reads `AWS_KMS_KEY_ID` and a base64 `AWS_KMS_ENCRYPTED_MASTER_KEY`, then calls KMS
`Decrypt` with that key id and the fixed encryption context
`agent-workspace-purpose=master-key`. It accepts exactly 32 plaintext bytes, derives the existing
non-secret fingerprint, and returns the same `MasterKey` shape the envelope code already consumes.
Provider errors identify the failed configuration or operation but never include the ciphertext,
plaintext, connection data or an AWS cause message.

KMS automatic rotation needs no application action: old ciphertext remains decryptable through the
same logical key. Moving to a different KMS key uses `aws kms re-encrypt` with the same encryption
context, atomically replaces the configured ciphertext and key id, and preserves the 32-byte
plaintext. Its fingerprint therefore remains stable and existing database rows require no rewrap.

## Alternatives considered

- **Call KMS for every secret data key.** Rejected because it requires a schema migration and makes
  every secret operation depend on a network service when the target explicitly permits a wrapped
  master key.
- **Store the plaintext master key in AWS Secrets Manager.** Rejected for the AWS slice because KMS
  already supplies authenticated key wrapping and IAM authorization without adding a second
  service. A Secrets Manager value would still need a KMS policy and would expose plaintext through
  the secret retrieval API.
- **Reuse `MASTER_ENCRYPTION_KEY` for the ciphertext blob.** Rejected because one variable with two
  incompatible encodings makes an incorrect provider selection ambiguous. Backend-specific names
  let validation fail before any AWS or database call.
- **Generate a new deployment key whenever configuration is absent.** Rejected because the next
  process would be unable to decrypt existing rows. Absence remains a startup failure.

## Consequences

- No database migration or secret-row rewrite is needed, and the existing AES-256-GCM envelope
  remains the data format.
- The plaintext deployment master key exists only in web-process memory after an authorized KMS
  decrypt. PostgreSQL plus committed deployment files is insufficient to recover credentials.
- The web workload needs only `kms:Decrypt` for ordinary startup. Rotation to another KMS key is an
  explicit operator procedure requiring `kms:ReEncryptFrom` and `kms:ReEncryptTo`; the application
  itself never receives that authority.
- A KMS outage prevents the secrets subsystem from installing at startup rather than falling back
  to a local key or plaintext. Other independently composed APIs retain their existing behaviour.
- The AWS backend is complete only when a real KMS proof has encrypted, decrypted and re-encrypted
  the same master key and a stored credential remains readable afterward; injected fake-client
  tests are the deterministic CI proof, not a replacement for that live run.
