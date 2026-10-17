# Azure Container Apps preview environment

This stack is the Azure counterpart to `infra/terraform/gcp-cloudrun`. It keeps the existing web,
gateway, runner-manager, runtime image, application authentication, PostgreSQL, and durable file
contracts while replacing provider-specific infrastructure with Azure services.

| GCP Cloud Run stack | Azure implementation |
| --- | --- |
| Cloud Run web service | Public Azure Container App, HTTP scale-to-zero, maximum one replica |
| Cloud Run gateway and runner-manager | Gateway uses public HTTPS ingress with Dynamic Sessions and internal ingress otherwise; runner stays internal on raw TCP, both scale-to-zero |
| Per-session Cloud Run runtime service | Optional custom-container Dynamic Sessions pool |
| Artifact Registry | Bootstrap-owned Azure Container Registry (Basic) |
| Cloud SQL PostgreSQL 16 | Private PostgreSQL Flexible Server 16, burstable SKU |
| Secret Manager | Key Vault RBAC references resolved by per-workload managed identities |
| GCS FUSE state mount | Azure Files mounted only at `/var/lib/agent-workspace` in the web app |
| Cloud Logging and Monitoring | Log Analytics plus resource diagnostic settings |
| GCS Terraform backend | Versioned, soft-deleted Azure Blob backend using Entra authentication |

The web, gateway, and runner-manager all have minimum capacity zero. Azure currently rejects zero
ready instances for custom-container Dynamic Sessions, so the pool uses the platform minimum of one
warm sandbox and is the explicit scale-to-zero exception. PostgreSQL, Azure Files, Key Vault, ACR,
the Container Apps environment, and Dynamic Sessions capacity still incur baseline charges.

The runner-manager is intentionally capped at one replica because its allocation registry is
process-local. Scale-to-zero and replica replacement save preview cost but can invalidate routes to
an in-flight allocation. Deterministic session identifiers permit a later re-allocation; they do not
make the manager durable. Set its minimum to one in a production derivative until allocation state
is externalised.

## Why the sandbox is separate

The runtime is untrusted, short-lived code execution. It must not share a filesystem, process
namespace, workload identity, or lifecycle with the control plane. The runner-manager therefore
allocates one custom-container Dynamic Session through the pool data plane rather than launching
the runtime inside its own Container App. The pool identity has only `AcrPull`, and
`managedIdentitySettings.lifecycle = None` keeps that identity out of the running sandbox. The
runner identity alone has `Azure ContainerApps Session Executor` on this pool.

Dynamic Sessions currently offers only `EgressEnabled` or `EgressDisabled`. The honest default is
enabled because a runtime must reach the model gateway. Terraform reports that limitation through
`RUNTIME_VERIFICATION_NETWORK_POLICY=open`; it does not claim hostname allow-list enforcement.

The session pool uses `Microsoft.App/sessionPools@2025-10-02-preview`. Microsoft removed custom
container probes from stable `2025-07-01` and `2026-01-01`, while the runtime contract needs both
startup and liveness checks on `/healthz`. Upgrade only after a newer stable schema restores an
equivalent health mechanism. Management calls use the separately versioned
`2025-02-02-preview` session data-plane API.

### Immutable runtime rollout and recovery

Changing only `images.runtime` asks Azure to update the existing pool in place. If that rollout is
stuck or Azure retains the old custom-container template, set `session_pool_generation` to a new
1-8 character lowercase alphanumeric token such as `blue2` and apply again. The token is appended
only to the pool name; web, gateway, runner, database, storage, and secrets keep their names.

Terraform creates the new pool and its Session Executor assignment before switching the runner to
the new management endpoint and destroying the old pool. Existing sessions on the old generation
are interrupted when it is retired, so bump the generation only after draining active preview runs.
Never reuse a generation token for a different runtime digest. Leave the variable empty for the
original unsuffixed name and normal default behaviour.

```powershell
./scripts/deploy/azure-container-apps.ps1 -Action Apply -SessionPoolGeneration blue2
```

The GitHub workflow exposes the same value as the optional `session_pool_generation` dispatch
input. A later recovery uses another monotonic token (`blue3`, a date fragment, or a short build
number); it does not toggle back to an earlier pool name.

## Prerequisites

- Terraform 1.9 or newer, Azure CLI, Docker Buildx, and an Azure subscription.
- `Microsoft.App`, `Microsoft.OperationalInsights`, `Microsoft.DBforPostgreSQL`,
  `Microsoft.KeyVault`, `Microsoft.Storage`, `Microsoft.ContainerRegistry`, and
`Microsoft.ManagedIdentity`, `Microsoft.Network`, and `Microsoft.Authorization` resource
providers registered in the subscription.
- Dynamic Sessions enabled in the selected region when `enable_dynamic_sessions=true`.
- The bootstrap stack in [`bootstrap/`](bootstrap/README.md) applied first.

Use one local bootstrap state per environment name and subscription. The deployment script plans
bootstrap changes first and refuses any delete or replacement action; intentional bootstrap
destruction requires a separately reviewed manual apply.

## Build immutable images

Log in to the bootstrap ACR and publish all four image contracts. The runtime image should include
both `linux/amd64` and `linux/arm64`; the three long-lived apps currently run on `linux/amd64`.

```powershell
az acr login --name <acr-name>
docker buildx build --platform linux/amd64 --target web -t <acr>.azurecr.io/agent-workspace/web:<commit> --push .
docker buildx build --platform linux/amd64 --target runner -t <acr>.azurecr.io/agent-workspace/runner:<commit> --push .
docker buildx build --platform linux/amd64 -f gateway.Dockerfile -t <acr>.azurecr.io/agent-workspace/gateway:<commit> --push .
docker buildx build --platform linux/amd64,linux/arm64 --provenance=false -f runtime.Dockerfile -t <acr>.azurecr.io/agent-workspace/runtime:<commit> --push .
```

Resolve each pushed tag to its digest and place only `<repository>@sha256:<64 hex>` references in
`terraform.tfvars`. Terraform rejects tags and the all-zero placeholder digest.

## Initialise, plan, and apply

Copy `terraform.tfvars.example`, replace every placeholder, then initialise the backend with the
bootstrap `backend_config` output:

```powershell
terraform init `
  -backend-config="resource_group_name=<resource-group>" `
  -backend-config="storage_account_name=<state-account>" `
  -backend-config="container_name=tfstate" `
  -backend-config="key=azure-container-apps.tfstate" `
  -backend-config="use_azuread_auth=true"
terraform plan -out azure-preview.tfplan
terraform apply azure-preview.tfplan
terraform output -raw web_url
```

The first apply deliberately waits after RBAC grants so Key Vault references and ACR pulls are not
raced against eventual role propagation. Secrets are generated into protected Terraform state,
written to Key Vault, and referenced by Container Apps through managed identities. Provider master
credentials are not infrastructure variables and must be added through the application's encrypted
credential workflow after sign-in.

Retrieve the generated bootstrap password without printing every secret:

```powershell
az keyvault secret show --vault-name (terraform output -raw key_vault_name) --name bootstrap-admin-password --query value -o tsv
```

## Networking and persistence

The Container Apps environment uses a delegated `/23` subnet. PostgreSQL uses a distinct delegated
`/24` subnet and private DNS; public database access is disabled and clients require TLS. The web
ingress is external. The gateway also uses external HTTPS ingress when Dynamic Sessions
are enabled, because session sandboxes cannot reach environment-internal ingress. Every model route
requires a short-lived run token; only `/health` is anonymous. The runner-manager stays internal.

ACA HTTP ingress has a fixed 240-second request timeout. Long runner streams therefore use internal
TCP ingress on port 8090; web calls `http://ca-<name>-runner:8090`, an app-name endpoint reachable
only by apps in the same Container Apps environment. A TCP scale rule wakes the zero-replica runner
on connection. The runner is not made publicly reachable. The gateway uses HTTPS ingress and
therefore retains the 240-second platform ceiling; a live long-stream check is a deployment gate
before claiming sessions longer than that through the gateway.

The browser-to-web `/run` response is itself one non-resumable SSE request through ACA HTTP
ingress. The ACA launcher therefore caps a run at 225 seconds, preserving 15 seconds to interrupt
and emit a terminal frame before the platform's 240-second cutoff. The cap applies even though the
internal web-to-runner hop uses raw TCP.

Azure Files preserves files, skills, transcript mirrors, and runtime-verification state across web
revisions. The main storage account keeps public network reachability because a Consumption
environment mount cannot use a private endpoint without additional DNS and routing design. Shared
key access is enabled only because the ACA environment storage API requires it; the key is stored in
Terraform state and never injected into an application container.

The session template receives the deterministic public web URL as `AW_SESSION_MIRROR_URL`; each run
still supplies its own scoped mirror token. This keeps transcript durability enabled without making
the pool depend on a particular web revision.

ACR lives in the protected bootstrap group. The workload deployer has registry Reader, AcrPush, and
a conditioned RBAC grant that can assign only AcrPull; it cannot create registry diagnostic settings.
Registry diagnostics are therefore a bootstrap-operator responsibility if required by policy.

## Verification and teardown

Before deployment, run:

```powershell
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
```

After apply, check `web_url`, sign in, verify `/`, `/api/health` where available, create one run,
confirm the Dynamic Session is destroyed after its cooldown, and inspect Container Apps and
PostgreSQL logs in the emitted Log Analytics workspace. A real session network probe is required
before changing egress to disabled.

Destroy the main stack before bootstrap. Key Vault purge protection intentionally prevents an
immediate permanent purge; the soft-deleted vault remains recoverable for seven days.
