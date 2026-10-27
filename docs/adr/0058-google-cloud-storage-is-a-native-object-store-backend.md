# ADR-0058 — Google Cloud Storage is a native object-store backend

Status: accepted
Date: 2026-09-23
Decided by: SDK migration unit 16, Google Cloud slice (#248)
Scope: `packages/core/src/storage/`, `apps/web/server/composition/storage.ts`,
`packages/cli/`, `infra/terraform/gcp-cloudrun/`, and the Google Cloud deployment documentation

## Context

The Google Cloud deployment provisions a Cloud Storage bucket but reaches it through Cloud
Storage's S3-compatible endpoint. Terraform creates a service-account HMAC key, writes the secret
half to Secret Manager, and injects both halves as `AWS_*` variables. The application then uses its
S3 adapter. That works, but it creates a long-lived interoperable credential and makes a native GCP
deployment depend on an AWS-shaped protocol even though Cloud Run already supplies an Application
Default Credentials identity.

Roadmap item D-2 requires one native object-store backend per cloud behind the existing
`ObjectStore` contract, selected by the deployment profile, and proven by that contract suite.
Unit 16 is one pull request per cloud; this record decides only the Google Cloud slice.

## Decision

1. `gcs://<bucket>` selects a native Google Cloud Storage backend. The backend implements the
   existing `ObjectStore` contract without changing it and uses `@google-cloud/storage` with
   Application Default Credentials. It validates every key through the shared key-safety boundary,
   preserves the distinction between an unknown content type and a known one, paginates listings,
   and keeps missing reads, deletes, and copy sources idempotent as the contract requires.
2. The web composition layer selects GCS through `OBJECT_STORAGE_BACKEND=gcs` and reuses
   `OBJECT_STORAGE_BUCKET`. `OBJECT_STORAGE_BACKEND=s3` selects S3-compatible storage; an unset
   discriminator preserves the existing S3-when-bucket/local fallback for old deployments. The
   filesystem roots continue to select local storage. Files use the `files/` prefix and skills use
   the `skills/` prefix, exactly as they do on S3.
3. The GCP deployment profile defaults to `gcs://…`; rendering records that native choice without
   inventing a credential. Terraform supplies `OBJECT_STORAGE_BUCKET` and the web service account's workload
   identity. The old storage service account, HMAC key, HMAC Secret Manager entry, and `AWS_*`
   object-store variables are removed from the GCP Cloud Run module.
4. Terraform grants only the web service account `roles/storage.objectAdmin` for object operations
   and bucket-scoped `roles/storage.legacyBucketReader` for the startup readiness probe (a one-object list, `storage.objects.list`, which objectAdmin also holds).
   Composition bounds that probe to ten seconds. The separate state bucket and its Cloud Storage
   FUSE mount are unchanged.
5. The fake-backed contract suite runs in normal CI. A real-service run must use a throwaway bucket
   and is recorded in the pull request; it is not replaced by a mock claim when credentials or a
   project are unavailable.

## Consequences

- A GCP deployment carries no HMAC object-store credential. Revoking the Cloud Run service account
  or its bucket IAM membership removes access without rotating an application secret.
- Listings omit bucket objects whose names are outside Agent Workspace's key grammar (for example
  console-created trailing-slash placeholders) rather than letting one foreign name fail the whole
  workspace listing. Caller-supplied read and write keys remain strictly rejected.
- The application gains two direct Apache-2.0 runtime dependencies in `packages/core`:
  `@google-cloud/storage` and, for ADR-0059, `@google-cloud/secret-manager`. They are imported only
  by their backend modules, so non-GCP processes do not construct either client.
- The bucket's lifecycle and `force_destroy` posture remain Terraform decisions. This change does
  not alter state, import existing buckets, or modify any `*.tfvars` file.
- Presigned transfer URLs remain unit 19 (#251), not part of the `ObjectStore` contract or this
  backend.

## Alternatives considered

- **Keep the HMAC/S3 path.** It is the gap D-2 explicitly closes and retains a long-lived secret
  where workload identity already exists.
- **Mount the objects bucket with Cloud Storage FUSE.** That would turn object semantics into
  filesystem semantics, couple the backend to Cloud Run, and leave every non-mounted GCP runtime
  without the advertised native store.
- **Call the JSON API by hand.** Authentication, retries, pagination, checksums, and stream handling
  are protocol work; the maintained Google client is the narrower and safer implementation.
