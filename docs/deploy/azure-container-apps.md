# Azure Container Apps preview deployment

This deployment is the Azure counterpart to the GCP Cloud Run stack. It preserves the four-image
topology and application protocols while using Azure-native identity, secrets, database, storage,
logging, and sandbox services. It is intended for preview and development environments, not as a
production availability baseline.

## The deployment profile

Generate the deployment's declaration first; it writes `agent-workspace.yaml` and renders `.env`
and this module's variables from it:

```sh
npx -p @indx-workspace/cli create-agent-workspace acme-ai --cloud azure
cp acme-ai/deploy/terraform/azure-container-apps.auto.tfvars.json \
   infra/terraform/azure-container-apps/
```

The rendered file supplies exactly the variables the profile decides — `bootstrap_admin_email`,
`object_container_name`, and the four digest-pinned `images`. Everything the module already
defaults stays in the module, and the values the profile cannot know (`subscription_id`,
`resource_group_name`, `container_registry_name`) stay in your own `terraform.tfvars`, as
`terraform.tfvars.example` shows. The profile's `storage.objects` is an `azblob://` container and
its `storage.secrets` is `key-vault`; Terraform wires both through the web app's managed identity.
`npx -p @indx-workspace/cli agent-workspace validate acme-ai` re-checks the profile; a
`--cloud` project ships no `package.json`, so the `-p` form is what runs the operator CLI in it.
The field reference is `packages/cli/README.md`.

The rendered `AW_TRUSTED_PROXY_HOPS=1` counts the Container Apps ingress as the one proxy that
appends `X-Forwarded-For`; see
[Client addresses behind a proxy](single-vm.md#client-addresses-behind-a-proxy-aw_trusted_proxy_hops)
before changing it.

> **Existing preview deployments:** this module switches files and skills from the Azure Files
> share to the new Blob container. Terraform does not copy existing bytes. Export the `files/` and
> `skills/` trees from the share and import them under the same prefixes in the Blob container
> before applying this version, or those existing resources remain on the share and are no longer
> reachable through the application. Session transcripts continue to use Azure Files.

## Architecture

| Existing GCP component             | Azure component                       | Important behavior                                                        |
| ---------------------------------- | ------------------------------------- | ------------------------------------------------------------------------- |
| Cloud Run web                      | Azure Container App, external ingress | HTTPS front door, `min_replicas=0`, maximum one replica                   |
| Cloud Run gateway                  | Azure Container App, HTTPS ingress    | External for Dynamic Sessions; run-token authentication, `min_replicas=0` |
| Cloud Run runner manager           | Azure Container App, internal ingress | Session Executor identity, `min_replicas=0`, maximum one replica          |
| Per-session Cloud Run service      | Custom-container Dynamic Session      | One Hyper-V sandbox per session; timed idle cleanup                       |
| Artifact Registry                  | Azure Container Registry Basic        | Four digest-pinned Linux images                                           |
| Secret Manager                     | Azure Key Vault                       | Direct master-key provider through managed identity                       |
| Cloud SQL PostgreSQL               | PostgreSQL Flexible Server 16         | Private VNet endpoint and TLS, burstable preview SKU                      |
| GCS FUSE and S3-compatible objects | Azure Blob Storage                    | Native SDK, private container, container-scoped managed identity          |
| Cloud Logging / Monitoring         | Log Analytics / Azure Monitor         | Container and session logs plus platform metrics                          |
| GCS Terraform backend              | Azure Blob state backend              | Entra authentication, versioning, and soft deletion                       |

The web app is public. When Dynamic Sessions are enabled, the model gateway also has public HTTPS
ingress because session sandboxes cannot reach ingress limited to other apps in the Container Apps
environment. Every model route requires a short-lived, run-scoped bearer token; `/health` is the
only anonymous route. Without Dynamic Sessions, the gateway stays internal. Web-to-runner traffic
uses Container Apps internal ingress. The database has no public endpoint. Key
Vault and ACR use public Azure service endpoints with RBAC in this preview design; adding private
endpoints is a production hardening option with additional networking cost.

Public gateway ingress lets anonymous traffic wake a zero-replica gateway. Startup reads the master
encryption key from Key Vault and opens PostgreSQL pools before the first request. Once started,
model requests without a bearer token are rejected before per-request provider or database lookups.
The preview accepts this startup cost exposure without an IP restriction or rate limit; the gateway
has at most two replicas.

Azure Blob Storage holds files and skills through the native adapter in
`packages/core/src/storage/azure-blob-store.ts`. The web identity receives `Storage Blob Data
Contributor` on that container alone. Azure Files remains mounted at
`/var/lib/agent-workspace` for transcript-related state and runtime-verification approvals, which
are not `ObjectStore` consumers.

The same web identity reads `master-encryption-key` directly from Key Vault at startup. Terraform
does not inject that key into a Container App secret or environment variable. Vault service-key
rotation and secret versioning preserve the plaintext application key; intentionally replacing
the plaintext value requires a future rewrap operation before old credential envelopes can be
read with the new key.

## Sandbox isolation

The sandbox is deliberately separate from the three control-plane Container Apps. Ordinary
Container Apps do not expose a Docker socket and cannot safely run the repository's Docker or
`sandbox-runtime` drivers. Nesting either would weaken or remove the intended isolation boundary.

The optional `Microsoft.App/sessionPools` resource runs the existing runtime image in one Hyper-V
isolation boundary per session. The pool identity can pull only from ACR and its lifecycle is set to
`None`, so untrusted sandbox code cannot use it to mint Azure tokens. Only the runner identity has
the `Azure ContainerApps Session Executor` role. Requests use cryptographically opaque HMAC-derived
identifiers and Entra tokens scoped to `https://dynamicsessions.io/.default`.

The pool uses Azure's minimum of one ready session, a small concurrency ceiling, and a timed idle cooldown. Dynamic
Sessions exposes only `EgressEnabled` or `EgressDisabled`; it has no domain allowlist. The default
pool therefore advertises only the `open` network policy needed to reach the authenticated gateway and
the public transcript mirror. Do not advertise `none` until a live probe proves gateway access with
egress disabled. The deployment never presents HTTP proxy variables as an isolation mechanism,
because raw sockets can bypass them.

Custom-container sessions are billed on dedicated E16 capacity according to Microsoft's
[Container Apps billing documentation](https://learn.microsoft.com/en-us/azure/container-apps/billing).
Azure's control plane rejects `readySessionInstances=0` for a custom-container pool and requires a
value greater than zero and less than `maxConcurrentSessions`. Consequently the isolated sandbox
is the explicit scale-to-zero exception in this preview architecture. Disable or destroy the pool
when sandbox execution is not needed rather than leaving its E16 capacity running.

## Prerequisites and permissions

Install Azure CLI, Terraform 1.9 or newer, Git, and PowerShell 7. The deploying identity needs enough
subscription access to create the bootstrap resource group. The bootstrap then creates a narrower
deployment identity with:

- `Contributor` on the deployment resource group;
- conditioned `Role Based Access Control Administrator`, limited to the roles used by this stack;
- `Storage Blob Data Contributor` on the Terraform state account; and
- `AcrPush` on the deployment registry.

Register `Microsoft.App`, `Microsoft.Authorization`, `Microsoft.ContainerRegistry`,
`Microsoft.DBforPostgreSQL`, `Microsoft.KeyVault`, `Microsoft.ManagedIdentity`,
`Microsoft.Network`, `Microsoft.OperationalInsights`, and `Microsoft.Storage`. Dynamic Sessions
must be available in the selected region.

For GitHub Actions, configure the `azure-preview` environment with `AZURE_CLIENT_ID`,
`AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID` secrets. Set `AZURE_RESOURCE_GROUP`,
`AZURE_ACR_NAME`, `AZURE_ACR_RESOURCE_GROUP`, `AZURE_BOOTSTRAP_ADMIN_EMAIL`,
`AZURE_STATE_RESOURCE_GROUP`, `AZURE_STATE_ACCOUNT`, and `AZURE_STATE_CONTAINER` (normally
`tfstate`) as protected environment variables. The `azure-preview` environment must exist with all
of them before the first dispatch; the `deploy` job declares `environment: azure-preview` and cannot
read the secrets otherwise.

The bootstrap federated credential uses OIDC and is scoped to that environment, not to a branch. Its
subject is exactly `repo:<owner>/<repo>:environment:azure-preview`, because a job that declares an
environment presents `repo:<owner>/<repo>:environment:<name>` as its OIDC `sub` claim. Entra ID
compares the subject byte-for-byte, so the owner and repository segments must use GitHub's canonical
casing, and renaming the GitHub environment (or the bootstrap's `github_environment` variable)
without changing the other breaks login with `AADSTS70021: No matching federated identity record
found for presented assertion`. No client secret is created. Environment-scoped trust is not
ref-scoped: any workflow run in this repository that declares `environment: azure-preview` can
exchange its token for the deployer identity, on any ref. Configure that environment's deployment
branch policy—and, on a shared repository, required reviewers—as the remaining ref control; a newly
created environment defaults to allowing all branches.

Application/provider credentials are not Terraform inputs. Sign in after deployment and store them
through the application's encrypted credential workflow. The runtime receives only a short-lived,
run-scoped gateway token—not the provider master key, database URL, session secret, or Key Vault
identity.

## Deploy

From the isolated feature worktree, validate without changing Azure:

```powershell
pwsh ./scripts/deploy/azure-container-apps.ps1 -Action Validate
```

Apply bootstrap, build all four images in ACR, provision the main stack, and verify public ingress:

```powershell
$env:AZURE_SUBSCRIPTION_ID = '<subscription-id>'
$env:BOOTSTRAP_ADMIN_EMAIL = 'owner@example.com'
pwsh ./scripts/deploy/azure-container-apps.ps1 `
  -Action Apply `
  -Location japaneast `
  -Name agent-workspace `
  -EnableDynamicSessions $true
```

The script uses local bootstrap state to discover the generated resource group, state account, and
ACR. Protect `infra/terraform/azure-container-apps/bootstrap/terraform.tfstate`; it contains resource
metadata and is needed for complete teardown. The main state is stored in the protected Azure Blob
backend. Reuse that local bootstrap state only with the same environment name and subscription. The
script plans bootstrap changes first and refuses any delete or replacement; an intentional
destructive bootstrap change requires a separately reviewed manual apply. All image variables use
immutable `@sha256:` references.

To supply already-built images, set `TF_VAR_images` to the four-reference JSON object and pass
`-SkipBuild`. For lower-cost control-plane-only testing, pass `-EnableDynamicSessions $false`; the
runner then has no Azure sandbox and agent runs are expected to be unavailable.

Retrieve the generated first-login password without dumping other secrets:

```powershell
$vault = terraform -chdir=infra/terraform/azure-container-apps output -raw key_vault_name
az keyvault secret show --vault-name $vault --name bootstrap-admin-password --query value -o tsv
```

### Upgrading to the engine-identity release (single-revision cutover)

The release that carries migrations `0024` and `0025` is not compatible with the previous release
([ADR-0069](../adr/0069-the-engine-identity-migrations-require-a-single-revision-cutover.md)), and
`web` migrates as it starts, so the new revision must never run beside an old one. Back up the
PostgreSQL server, then deactivate the active revision of `web`, `gateway` and the runner manager
(or scale each to zero replicas) and wait for the replicas to stop before applying the new images:

```powershell
az containerapp revision deactivate --resource-group <rg> --name <app> --revision <old-revision>
```

Then run `-Action Apply` above. Rollback means restoring the backup together with the previous
images.

### Upgrading to the engine-scoped session-state release (single-revision cutover)

The release that carries migrations `0026` and `0027` needs the same cutover
([ADR-0071](../adr/0071-one-engine-scoped-session-state-store.md)). Its schema is additive, but
`0027` copies every Claude transcript into the new store **once**, when `web` migrates at start-up;
an old revision still serving would keep writing turns to the legacy tables that nothing copies, and
a later resume would silently lose them. Back up the PostgreSQL server, deactivate the old revisions
of `web`, `gateway` and the runner manager (or scale each to zero) and wait for their replicas to
stop, exactly as above, before `-Action Apply`. Rollback means restoring that backup together with
the previous images.

## Validate the live environment

The deployment script does not grant its caller the pool-wide Session Executor role merely to run a
smoke test. Validate sandbox traffic through the authenticated runner path. If direct data-plane
diagnostics are required, create a temporary pool-scoped Session Executor assignment for a dedicated
test identity and remove it immediately after the probe. Before treating the preview as usable,
verify:

1. Sign-in and an authenticated API call succeed after the web app cold-starts.
2. With Dynamic Sessions enabled, the gateway `/health` endpoint is publicly reachable and model
   routes reject requests without a run token. The runner health endpoint remains internal.
3. A session can upload/download a file, stream `/run`, receive an interrupt, and be stopped.
4. Two identifiers cannot read one another's `/workspace` files.
5. The runtime has no database, Key Vault, or Azure managed-identity credential.
6. Container and session console/lifecycle logs appear in the emitted Log Analytics workspace.
7. Web, gateway, and runner replica counts reach zero after the Container Apps cooldown, and a new
   HTTPS request wakes web successfully.
8. After the session cooldown, executing and pending metrics are zero, the configured one ready
   session remains available, and `nodeCount` is checked explicitly.

The session pool uses the preview `2025-10-02-preview` ARM schema because current stable schemas omit
custom-container probes. Session management calls use `2025-02-02-preview`. Revalidate both API
contracts before upgrading.

## Idle cost expectations

At zero HTTP traffic, the three Consumption apps have no requested replicas and normally incur no
active compute charge. The subscription-level free grant may absorb small request/idle usage. The
remaining preview cost floor is:

- PostgreSQL Flexible Server `B_Standard_B1ms` plus 32 GiB storage and backups;
- ACR Basic;
- Azure Files and Terraform-state storage;
- Key Vault operations and retained soft-deleted data;
- Log Analytics ingestion/retention; and
- the Dynamic Sessions E16 capacity needed to retain the required ready session.

Prices vary by agreement, currency, and region. Use the
[Azure pricing calculator](https://azure.microsoft.com/en-us/pricing/calculator/) with the actual
subscription, and set a budget alert on the resource group. PostgreSQL can be manually stopped for
short idle windows, but Azure restarts a stopped Flexible Server after seven days; it is not native
automatic scale-to-zero.

## Teardown

Destroy the main stack before bootstrap:

```powershell
pwsh ./scripts/deploy/azure-container-apps.ps1 `
  -Action Destroy `
  -Name agent-workspace `
  -BootstrapAdminEmail owner@example.com `
  -DestroyBootstrap
```

Key Vault purge protection and soft-delete are intentional. The deleted vault remains recoverable
for seven days even after the resource group is removed. Without `-DestroyBootstrap`, ACR and the
protected Terraform backend remain so the environment can be rebuilt.

## Known preview limitations

- Runner allocation maps remain process-local. The runner is capped at one replica and deterministic
  identifiers avoid duplicate provider sessions after a restart, but in-flight SSE streams are not
  transparently recovered.
- Azure Container Apps HTTP ingress has a 240-second request timeout. The web-to-runner hop uses
  environment-internal raw TCP ingress and is not subject to that HTTP limit. Dynamic Sessions
  data-plane calls and the gateway HTTP hop still are, so ACA session runs are capped at 225 seconds;
  workloads that need longer uninterrupted execution require a durable asynchronous worker design.
- Web background run execution is tied to its HTTP process. Keep an events stream open during runs;
  a production design should move launch work to a durable queue/worker before relying on min-zero
  web with no connected client.
- Azure Files is appropriate for the remaining transcript and runtime-verification state on a
  one-replica preview web app. A production multi-replica design should move that state to a
  coordinated store; files and skills already use Blob Storage.
- The EgressEnabled pool supports only `open`, not `none` or per-domain `restricted` policy.
- PostgreSQL, storage, registry, Key Vault, and Dynamic Sessions capacity remain billable
  while the HTTP applications are scaled to zero.

## Public URL for external agent platforms (`AW_PUBLIC_URL`)

Set `AW_PUBLIC_URL` on the `web` container app to the https origin external platforms reach it at,
with no path (`https://aw.example.com`). The A2A agent card (ADR-0135) builds its `url` from it;
unset, the card route answers `503 a2a_public_url_not_configured` and JSON-RPC calls still work. It is also the
OAuth 2.1 issuer for endpoint clients (ADR-0134): unset, `/oauth/*` and the `/.well-known/oauth-*`
documents answer `404 oauth_not_configured`.

Set the module's `public_url` variable (an https origin with no path, validated at plan time), or put
`AW_PUBLIC_URL=https://<origin>` in the project's `.env` and run `agent-workspace render`, which
writes `public_url` into the generated `azure-container-apps.auto.tfvars.json` (as the origin: a
trailing slash or path in `.env` is dropped). Then `terraform plan`
shows one in-place update to `azurerm_container_app.web`, and `terraform apply` rolls out one new
revision. Unset, the `web` app gets no `AW_PUBLIC_URL` and the plan is unchanged. To roll back,
remove or blank `public_url` and apply again. Nothing else changes: no identity, role, secret or
network.

## Project tool endpoint (`/mcp/projects/:name`)

The endpoint (ADR-0134 part 2) runs a project's code tools in a tool sandbox opened by the runner
manager, using the workspace's default runtime profile. The Dynamic Sessions sandbox does not place
tool sandboxes (see Sandbox isolation), so on this deployment a tool call answers
`503 tool_endpoint_unavailable`. Revoking the endpoint client, one of its keys or an OAuth grant
closes its sandbox at once, best effort; the idle timeout ends it if the close cannot reach the
runner manager.
