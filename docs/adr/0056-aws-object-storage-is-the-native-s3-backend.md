# ADR-0056 — AWS object storage is the native S3 backend

Status: accepted
Date: 2026-09-23
Decided by: SDK migration unit 16, AWS slice (#248)
Scope: `packages/core/src/storage/`, `apps/web/server/composition/storage.ts`, the AWS deployment profile and EKS operator documentation

## Context

Roadmap item D-2 requires one native object-store backend per cloud behind the existing
`ObjectStore` contract and a contract-suite proof against the real service. AWS is different from
the other two clouds: the existing production backend already uses the AWS S3 API through
`@aws-sdk/client-s3`. With no configured endpoint the AWS SDK resolves the regional S3 service and
its default credential chain; an endpoint is needed only for S3-compatible stores such as MinIO.

The current startup helper creates a bucket after a `404`. That is useful for the generated Compose
project, which owns its MinIO bucket, but is the wrong authority for an EKS workload. A production
control-plane identity should have object permissions inside a provisioned bucket, not permission
to create arbitrary buckets. Unit 16 also requires a missing bucket to leave the files and skills
runtimes unconfigured rather than silently provisioning a misspelled name.

## Decision

Keep one S3 implementation and select native AWS S3 by an `s3://` deployment-profile value with no
`OBJECT_STORAGE_ENDPOINT`. Do not add an AWS-labelled wrapper around the same SDK calls. Split
bucket readiness from development provisioning: the native AWS path performs `HeadBucket` and
fails closed when the bucket is absent, while an explicitly configured S3-compatible endpoint may
retain the existing create-on-first-start behaviour for the generated MinIO deployment.

The real-service proof runs the shared `ObjectStore` contract suite against a disposable S3 bucket
and separately exercises both `files/` and `skills/` prefixes. It must use the ambient AWS identity;
no long-lived access key is rendered into the deployment profile or committed fixture.

## Alternatives considered

- **Add a second `AwsS3ObjectStore`.** Rejected because it would duplicate the implementation and
  falsely imply that the existing S3 client is an interoperability shim on AWS.
- **Keep creating a missing AWS bucket at application startup.** Rejected because it widens the
  pod's IAM authority and turns a configuration typo into durable infrastructure.
- **Provision AWS infrastructure in a new Terraform module.** Rejected for this slice because the
  repository deliberately has no AWS Terraform module: ADR-0055 targets an already-provisioned EKS
  cluster and renders a Helm overlay. Adding the cluster, bucket and database would be a new
  deployment product rather than the storage backend proof.

## Consequences

- AWS continues to use the established `ObjectStore` contract and key-safety rules; application
  routes and the SDK do not gain an AWS-specific concept.
- The EKS workload needs `s3:GetBucketLocation`, listing, read, write and delete permissions on the
  operator-provisioned bucket and its objects. Bucket creation is not needed by the application.
- A missing or inaccessible AWS bucket makes composition leave the files and skills runtimes
  unconfigured, so their existing routes answer their stable `503 ..._runtime_not_configured`
  problem codes.
- The AWS table cell is complete only when the shared suite has passed against real S3 and that run
  is linked from the unit's pull request. MinIO remains the deterministic CI proof, not a substitute
  for the live AWS proof.
