# Google Cloud Run — Terraform

`infra/terraform/gcp-cloudrun` creates the whole stack in one existing GCP project: Cloud SQL,
the objects and state buckets, Secret Manager under Cloud KMS, an Artifact Registry repository,
and the web, gateway and runner-manager Cloud Run services. It generates every secret itself,
the first Owner's password included. This path is for the Owner and design partners: the module
is part of this repository, so `--infra` points at the `infra/` directory of a checkout.

## From a project: `aw deploy production`

A v2 project names the target in its own `agent-workspace.yaml`, and `aw deploy` renders the
module's variables and runs `terraform plan` (and, with `--yes`, `terraform apply` of that plan)
through `agent-workspace deploy` (ADR-0103, #621):

```yaml
environments:
  # local: as npm create wrote it
  production:
    target: gcp-cloudrun
    url: https://agents.example.com
```

```sh
aw deploy production --infra ../claude-agent-workspace/infra --plan
aw deploy production --infra ../claude-agent-workspace/infra --yes
```

Without `--yes` it only plans: it exits 0 when the stack matches and 3 when changes are pending;
`--plan --yes` is refused. The variables it renders are the Owner's email
(`environments.local.identity.bootstrapAdmin`) and the four images; everything account-scoped
stays in the module's `terraform.tfvars`.

**What the Owner provides.** Each is refused by name, before anything is created, when missing:

| Prerequisite                                                             | Refused with                                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Node.js 24 or later, and `@indx-workspace/cli` beside `aw`               | `Node.js 24 or later is required` / `install @indx-workspace/cli` |
| `--infra`: the `infra/` directory of a claude-agent-workspace checkout   | `--infra <dir> is required` / `holds no Terraform module`         |
| `project_id` in `terraform/gcp-cloudrun/terraform.tfvars` (or `TF_VAR_`) | `The gcp-cloudrun module has no project_id`                       |
| Terraform 1.8 or later                                                   | `Terraform is not installed`                                      |
| The module initialised with a GCS backend                                | `The Terraform module gcp-cloudrun is not initialised`            |
| The four images copied into the module's Artifact Registry               | `The <name> image is …, which Cloud Run cannot pull`              |
| A GCP project with billing, and `gcloud auth application-default login`  | not checked; Terraform's own authentication error                 |
| DNS for the `url` host mapped to the web service                         | not checked; `aw deploy --yes` names the `web_url` output to map  |

## Prepare the module (once)

```sh
cd claude-agent-workspace/infra/terraform/gcp-cloudrun
printf 'project_id = "acme-prod"\nregion     = "asia-northeast1"\n' > terraform.tfvars
gcloud auth application-default login
terraform init -backend-config="bucket=acme-prod-tfstate" -backend-config="prefix=agent-workspace"
```

`region` and `name` (the resource prefix, `agent-workspace` by default) are optional. The state
bucket is yours to create; the module does not.

## Copy the images into Artifact Registry, by digest

Cloud Run cannot pull from `ghcr.io`, where the release is published, and the runner manager reads
the runtime image from the module's own repository (`roles/artifactregistry.reader` on it). So the
four images are copied there first. The repository is part of the module, so create it alone with a
targeted apply. Terraform demands every variable even then; any non-placeholder digest satisfies
`images` for this one step:

```sh
export TF_VAR_bootstrap_admin_email=owner@acme.example
export TF_VAR_images='{"web":"x@sha256:1111111111111111111111111111111111111111111111111111111111111111","gateway":"x@sha256:1111111111111111111111111111111111111111111111111111111111111111","runner":"x@sha256:1111111111111111111111111111111111111111111111111111111111111111","runtime":"x@sha256:1111111111111111111111111111111111111111111111111111111111111111"}'
terraform apply -target=google_artifact_registry_repository.images
unset TF_VAR_bootstrap_admin_email TF_VAR_images
```

Then copy each release image, source by digest, and point `aw deploy` at the copies. `node
infra/release/images.mjs --references` lists the release references; `docker buildx imagetools
inspect <reference>` prints each one's digest:

```sh
gcloud auth configure-docker asia-northeast1-docker.pkg.dev
AR=asia-northeast1-docker.pkg.dev/acme-prod/agent-workspace
for name in web gateway runner runtime-claude-agent-sdk; do
  digest=$(docker buildx imagetools inspect "ghcr.io/indxjp/agent-workspace/$name:0.2.1" \
    --format '{{json .Manifest}}' | jq -r .digest)
  docker buildx imagetools create --tag "$AR/$name:0.2.1" \
    "ghcr.io/indxjp/agent-workspace/$name@$digest"
done
export AW_WEB_IMAGE=$AR/web:0.2.1 AW_GATEWAY_IMAGE=$AR/gateway:0.2.1
export AW_RUNNER_IMAGE=$AR/runner:0.2.1 AW_RUNTIME_IMAGE=$AR/runtime-claude-agent-sdk:0.2.1
```

`aw deploy` resolves each `AW_<NAME>_IMAGE` to its digest and pins that digest in its state, so
later runs need the variables only to move to another release.

## After the apply

```sh
terraform -chdir=infra/terraform/gcp-cloudrun output web_url
terraform -chdir=infra/terraform/gcp-cloudrun output -raw bootstrap_admin_password
aw login --url https://agents.example.com
```

Map the `url` host to the web service (a Cloud Run domain mapping, or a load balancer in front
of it), then sign in as the Owner with the generated password. `aw deploy` names both commands and
never prints the password. Changing the Owner's email in `agent-workspace.yaml` re-renders
`bootstrap_admin_email` on the next run.

**Where its state lives.** As for single-vm, `aw deploy` keeps the internal deployment at
`~/.config/agent-workspace/deployments/<project>/production/` (directory `0700`, `.env` `0600`),
holding the rendered variables and the pinned images; the stack's own secrets live in Secret
Manager and the Terraform state. On Windows the modes are not enforced; see
[the single-VM note](single-vm.md#from-a-project-aw-deploy-production).

## Public URL for external agent platforms (`AW_PUBLIC_URL`)

Set `AW_PUBLIC_URL` on the `web` service to the https origin external platforms reach it at, with no
path (`https://aw.example.com`). The A2A agent card (ADR-0135) builds its `url` from it; unset, the
card route answers `503 a2a_public_url_not_configured` and JSON-RPC calls still work. It is also the
OAuth 2.1 issuer for endpoint clients (ADR-0134): unset, `/oauth/*` and the `/.well-known/oauth-*`
documents answer `404 oauth_not_configured`. `aw deploy`
writes it into the generated `gcp-cloudrun.auto.tfvars.json` as `public_url` when the project's
`.env` carries it; set the `public_url` variable by hand otherwise. Unset, the `web` service gets no
`AW_PUBLIC_URL` and the plan is unchanged.

## Project tool endpoint (`/mcp/projects/:name`)

The endpoint (ADR-0134 part 2) runs a project's code tools in a tool sandbox opened by the runner
manager, using the workspace's default runtime profile. The `cloud-run-service` driver does not
place tool sandboxes, so on this deployment a tool call answers `503 tool_endpoint_unavailable`;
the endpoint needs a runner manager on the Docker driver or E2B with
`AGENT_WORKSPACE_TOOL_HOST_IMAGE` set. Revoking the endpoint client, one of its keys or an OAuth
grant closes its sandbox at once, best effort; the idle timeout ends it if the close cannot reach
the runner manager.
