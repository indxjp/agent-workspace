# ADR-0060 — Azure Blob is the native object store for Azure profiles

Status: accepted
Date: 2026-09-23
Decided by: SDK migration unit 16, Azure slice (#248)
Scope: `packages/core/src/storage/`, `apps/web/server/composition/storage.ts`,
`packages/cli/`, `infra/terraform/azure-container-apps/`, Azure deployment documentation

## Context

ADR-0055 deliberately refuses `azblob://` and gives Azure profiles a local-filesystem object
store backed by an Azure Files mount. That makes the preview usable, but it is not the cloud's
native object service and it couples durable application bytes to one web container's mounted
filesystem. Roadmap item D-2 requires a backend behind the existing `ObjectStore` contract and a
live run of that contract against the real service.

The `ObjectStore` contract is already the stable seam. It includes exact-key put/get/delete,
one-level hierarchical listing, recursive prefix listing, copy, tenant scoping, content type and
last-modified metadata. Adding Azure-specific methods would leak a provider into callers and is
unnecessary because Blob Storage provides the same primitives.

## Decision

`azblob://<container>` is the Azure deployment profile's native object-store spelling. It is
accepted only when `cloud: azure`; other clouds continue to reject it. The runtime receives the
container name and an HTTPS Blob service URL, and authenticates with `DefaultAzureCredential`.
Production therefore uses the web Container App's user-assigned managed identity; local live
verification uses the already authenticated Azure CLI identity. No account key, SAS token or
connection string is accepted by this backend.

`packages/core/src/storage/azure-blob-store.ts` implements the existing `ObjectStore` contract:

- block blobs hold bytes, content type and an explicit marker that distinguishes an unknown
  content type from a service default;
- `listBlobsByHierarchy('/')` implements the one-level listing and `listBlobsFlat` implements the
  recursive prefix listing;
- copy preserves bytes and content type through the same get/put seam, and absence remains an
  idempotent outcome;
- `createScopedObjectStore` remains the only tenant boundary, so Blob names retain the existing
  `workspaces/<workspace-id>/...` prefix.

The Azure Terraform module provisions one private container in the existing StorageV2 account,
grants the web identity `Storage Blob Data Contributor` at that container, and passes only the
non-secret service URL and container name. The Azure Files share remains for session transcripts
and runtime-verification state in this slice; removing those mounts would widen D-2 beyond files
and skills.

The storage contract suite has an injected fake client for ordinary CI and a real-service fixture
for the release proof. The live fixture creates only uniquely named temporary containers and
removes them after the suite. On 2026-09-23 the available proof identity could create and delete
those containers but lacked Blob data-plane access, so object operations returned HTTP 403. The
data-plane cell remains partial until that role is granted and the suite passes.

## Alternatives rejected

- **Keep Azure Files as the object store.** It is a mounted local filesystem, not the native
  object backend D-2 names, and it prevents the web service from scaling independently of a share.
- **Use an account key or SAS.** Both create another long-lived credential to distribute. Managed
  identity already exists in the Terraform module and is the narrower production authority.
- **Teach the contract about containers or ETags.** Those are provider details. The callers need
  the existing object operations and no more.

## Consequences

- Azure profiles can state `azblob://<container>` and receive a backend the application actually
  serves.
- The web identity gains data-plane write authority to one container. It gains no management-plane
  role and no account key.
- Blob Storage becomes part of web startup readiness: an absent or inaccessible container leaves
  files and skills uninstalled, preserving their existing `503 *_runtime_not_configured` behavior.
- The Terraform change creates a container and one scoped role assignment. It does not replace the
  storage account, database, Key Vault, Container Apps environment or Azure Files share.
