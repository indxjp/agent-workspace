# Google Cloud Run

`aw deploy production` puts the whole workspace into your Google Cloud project: Cloud SQL, the
objects and state buckets, Secret Manager under Cloud KMS, an Artifact Registry repository, and the
web, gateway and runner-manager Cloud Run services. It creates every secret itself, the first
Owner's password included. You need a Google Cloud project with billing and two commands; there is
no Terraform file to write.

Day-two tasks (upgrade, rollback, restore, rotation, budgets, alerts) are in the
[operations runbook](../operations/gcp-cloudrun-runbook.md).

## How the network is laid out

The deployment is private by default. Every deploy creates its own network (or uses yours, see
[Use an existing network](#use-an-existing-network)):

- `web` is the only public service. Its `run.app` address, or your own domain, is the way in.
- The runner manager is internal: it has no public address and no public access. `web` calls it with
  its own Google identity (it holds `roles/run.invoker` on the runner manager and sends a Google ID
  token beside the bearer token it already sends).
- The gateway is internal too, behind its per-run token: sandboxes cannot present a Google identity,
  so the run token is its gate. `web` and the sandboxes reach it at a regional internal Application
  Load Balancer, a private address on your network (plain HTTP inside the network).
- Each sandbox is an internal Cloud Run service on the sandbox subnet. Its firewall allows one
  destination, the gateway's internal load balancer; everything else is denied, Google's private
  ranges (`199.36.153.8/30` and `199.36.153.4/30`) included. There is no NAT.
- `web`, the gateway and the runner manager reach the database and each other over the private
  network (Direct VPC egress for private ranges only; Private Google Access and a private `run.app`
  DNS zone).
- Cloud SQL has a private IP address only and accepts encrypted connections only. It has no public
  address.
- The runner manager creates and deletes the sandbox services with two custom roles the module
  creates, `<name>_runner_manager_<suffix>` and `<name>_runner_manager_invoker_<suffix>`, where the
  suffix is a random value kept in the Terraform state. GCP reserves the id of a deleted custom
  role for weeks (and undeletes it for 7 days only), so a fixed id would make a destroy followed by a
  new deploy under the same name fail; the suffix avoids that. The first holds only
  `run.services.create`, `run.services.delete`, `run.services.get`, `run.services.list`,
  `run.operations.get`, `run.operations.list` and `run.locations.list`; the second holds only
  `run.routes.invoke`. Neither holds a `run.jobs.*` permission, so the runner manager cannot run a
  Cloud Run job, including the job that holds the app database role credentials
  (the Terraform test `the_runner_manager_holds_no_permission_on_jobs` checks this). An IAM
  condition limits what it can create to services named `rt-`. The invoke role is conditioned on
  the request's host instead, `request.host.startsWith("rt-") && request.host.endsWith(".run.app")`,
  because Cloud Run gives the invoke check the host and not the service's name: the runner manager
  calls each sandbox at its own URL (`https://rt-<id>-<hash>-<region>.a.run.app`), refuses any other,
  and no host of the install's own services matches, since the module's `name` may not start with
  `rt-`. Cloud Run does not evaluate the name condition on delete, so the runner manager can also delete the install's other Cloud Run services
  (web, gateway). It cannot reach the data in Cloud SQL or the buckets through these roles. If a
  service is deleted, `aw deploy production --yes` creates it again (see the
  [runbook](../operations/gcp-cloudrun-runbook.md#recreate-a-deleted-service)).

## Prerequisites

`aw deploy` checks each of these before it creates anything, prints one report with every result,
and gives one command to fix each failure:

| What you need                                                  | What the check says when it is missing                                  |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Node.js 24 or later, and `@indx-workspace/cli` beside `aw`     | `Node.js 24 or later is required`                                       |
| The Google Cloud command line (`gcloud`)                       | `The Google Cloud command line (gcloud) is installed`                   |
| Sign-in for Terraform: `gcloud auth application-default login` | `You are not signed in to Google Cloud`                                 |
| Sign-in for gcloud: `gcloud auth login`                        | `The gcloud command line has no active account`                         |
| Your Google Cloud project exists                               | `Your Google Cloud project <id> exists`                                 |
| Your sign-in may create what the deploy creates                | `Could not check what you may do ...` / permissions                     |
| Billing is enabled on your Google Cloud project                | `Billing is enabled on your Google Cloud project`                       |
| Claude is enabled in Model Garden for your project             | `Claude claude-sonnet-5-5 is not enabled for your Google Cloud project` |
| The Google Cloud APIs the deploy needs                         | warning that lists them; `--yes` enables them for you                   |
| Your organisation lets the web app be reached publicly         | `Your organisation restricts who may be granted access`                 |
| Terraform 1.8 or later                                         | `Terraform 1.8.0 or newer is not installed`                             |
| Docker buildx, to copy the release images                      | `Docker buildx is not available ...`                                    |

When the permission check fails it prints one command that grants the roles you lack. The deploy
always needs `roles/logging.configWriter` (log-based metrics) and `roles/monitoring.dashboardEditor`
(dashboard), beside the Cloud Run, Cloud SQL, Storage, Secret Manager, KMS, Artifact Registry,
service account and IAM administration roles, and `roles/iam.roleAdmin` to create the two runner
manager custom roles (`iam.roles.create`). It needs `roles/monitoring.alertPolicyEditor`,
`roles/monitoring.notificationChannelEditor` and `roles/monitoring.uptimeCheckConfigEditor` (alerts
and uptime check) only when `gcp.alertsEmail` is set. The check names whichever roles are missing.

### Enable Claude in Model Garden

The first deploy connects Claude on Vertex AI for you, so enable the Claude model in Model Garden
before you deploy. The check sends one one-token request to the model. When it fails it only warns; it says
`Claude claude-sonnet-5-5 is not enabled for your Google Cloud project` and prints the fix link,
`https://console.cloud.google.com/vertex-ai/publishers/anthropic/model-garden/claude-sonnet-5-5?project=<project>`:
open it and choose Enable. The deploy goes on, so you can still connect an Anthropic key instead. If the quota for Claude in
your location is exhausted, the check warns and links to the quota page.

Two things are not checked: DNS for the `url` host when you do not set `domain` (point it at the web
service after the first deploy) and an organisation policy that forbids a Direct VPC or internal
setup the deployment needs. The check prints what each organisation policy means for the deployment
(`run.allowedIngress`, `run.allowedVPCEgress`, `sql.restrictPublicIp`; managed:
`sql.managed.restrictPublicIp`) instead of failing on it.

If your organisation restricts who may be granted access (`iam.allowedPolicyMemberDomains`), the
check fails and offers no command: the web app and the gateway are reachable by anyone who holds a
valid token, so ask your organisation administrator for an exception for your project. Never
delete the policy to get past the check.

## Describe the deployment

Add the `gcp` block to `environments.production` in `agent-workspace.yaml`:

```yaml
environments:
  # local: as npm create wrote it
  production:
    target: gcp-cloudrun
    url: https://agents.example.com
    gcp:
      project: acme-prod # your Google Cloud project id
      region: asia-northeast1
```

`gcp.modelLocation` chooses where Claude on Vertex AI runs: `global` (the default and
recommended), `us` or `eu`:

```yaml
gcp:
  project: acme-prod
  region: asia-northeast1
  modelLocation: eu
```

Three more optional keys set how the deployment is sized, protected and watched:

- `gcp.size`: `small` (the default) or `standard`. `small` is a shared-core Cloud SQL instance
  (`db-f1-micro`) with one web instance always warm and the gateway and runner manager scaling to
  zero; `standard` is `db-custom-2-7680` with regional high availability and at least one instance
  of every service. Both keep 14 backups with point-in-time recovery.
- `gcp.dataProtection`: `true` by default. It protects Cloud SQL, both buckets and the three Cloud
  Run services from deletion; see [Remove a deployment](#remove-a-deployment).
- `gcp.alertsEmail`: an address that receives alerts. It adds alert policies and an uptime check;
  the dashboard and its metrics exist without it. See the
  [runbook](../operations/gcp-cloudrun-runbook.md#alerts-and-dashboard).

The deployment's resources are named after the project's `name` (cut to 19 characters), so two
projects in one Google Cloud project do not share a Cloud SQL instance or an image repository. Its
Terraform state is kept per project name too.

### Serve the web app at your own domain

Add `domain`, and optionally `armor` and `iap`, to the `gcp` block:

```yaml
gcp:
  project: acme-prod
  region: asia-northeast1
  domain: agents.example.com
  armor: true # Cloud Armor in front of the load balancer; needs domain
  iap: true # Identity-Aware Proxy; needs domain
```

With a `domain` the deployment adds a global external load balancer with a managed certificate, and
`web` accepts traffic from the load balancer only. The steps:

1. Run `aw deploy production --yes`. The summary prints the load balancer's IP address.
2. Create a DNS `A` record for the domain that points at that IP address.
3. Wait for the certificate. Google Cloud issues it only after DNS points at the address, which can
   take from several minutes to an hour. Until then the deploy reports that DNS does not point there
   yet; run `aw deploy production --yes` again afterwards.

`armor: true` adds a Cloud Armor security policy to the load balancer. `iap: true` puts Identity-Aware
Proxy in front of the web app: Google signs people in before they reach it, and each person needs
`roles/iap.httpsResourceAccessor`. For users outside your Google Cloud organisation, IAP needs a
custom OAuth client that you create in the console; the deployment cannot create one for you.

IAP sits on the load balancer only. The web app's `run.app` address is closed to the internet when
you set a `domain`, and the model gateway keeps calling the web app there, so the `aw-control` tool
(a running agent managing its own workspace) keeps working behind IAP.

### Single sign-on

To sign people in with your identity provider, add `oidc` to the `gcp` block:

```yaml
gcp:
  project: acme-prod
  region: asia-northeast1
  oidc:
    issuer: https://login.example.com
    clientId: aw-production
```

Register this redirect URI with the provider: `<web origin>/api/auth/callback`. The web origin is
`https://<gcp.domain>` with a custom domain, for example `https://agents.example.com/api/auth/callback`;
without one it is the deterministic Cloud Run URL `https://<name>-web-<project number>.<region>.run.app`,
not the service's other `…-<hash>-<region code>.a.run.app` address. It is the `web:` line and the
`web_url` output, and `aw deploy` prints the exact redirect URI on a `next: register` line. On the first `aw deploy production --yes` the CLI
asks for the client secret once, at the terminal with the input hidden. Without a terminal it reads
`AW_OIDC_CLIENT_SECRET`. The secret is stored in Secret Manager; a later run asks for nothing unless the issuer or client id changed, and
the summary says which sign-in is active.

To rotate the secret, add a new version and start a new web revision; the
[runbook](../operations/gcp-cloudrun-runbook.md#rotate-the-single-sign-on-client-secret) has the commands.

### Use an existing network

By default the deployment creates a network of its own. To use a Shared VPC instead, set the
Terraform variables `network` and `subnetwork` (the network to adopt and the subnetwork the services
use; both or neither) in the module's `terraform.tfvars`, as in the maintainer procedure below. The network must already have Private Services Access
configured for Cloud SQL, a private `run.app` DNS zone that resolves `*.run.app` to
`199.36.153.8/30`, and an active proxy-only subnet (purpose `REGIONAL_MANAGED_PROXY`) in the region
for the gateway's internal load balancer; the deployment then does not create them.

## Deploy from Cloud Shell

Cloud Shell already has `gcloud`, Docker and Node, and you are signed in. It does not come with
Terraform ([Google's install guide](https://docs.cloud.google.com/docs/terraform/install-configure-terraform)),
so install it into `~/bin` first (once per Cloud Shell home directory):

```sh
tmp="$(mktemp -d)" && mkdir -p ~/bin && curl -fsSLo "$tmp/terraform_1.9.8_linux_amd64.zip" https://releases.hashicorp.com/terraform/1.9.8/terraform_1.9.8_linux_amd64.zip && curl -fsSLo "$tmp/SHA256SUMS" https://releases.hashicorp.com/terraform/1.9.8/terraform_1.9.8_SHA256SUMS && (cd "$tmp" && grep " terraform_1.9.8_linux_amd64.zip$" SHA256SUMS | (sha256sum -c - 2>/dev/null || shasum -a 256 -c -)) && unzip -oq "$tmp/terraform_1.9.8_linux_amd64.zip" -d ~/bin && export PATH="$HOME/bin:$PATH"
```

Then, in the project directory:

```sh
aw deploy production
aw deploy production --yes
```

The first command only looks. It prints the preflight, one line per check:

```text
Checking your Google Cloud project acme-prod (asia-northeast1)

[ ok  ] The Google Cloud command line (gcloud) is installed
[FAIL ] You are not signed in to Google Cloud
         fix: gcloud auth application-default login
...
Some checks failed. Nothing was created. Run the fix commands above and try again.
```

If every check passes it goes on to the plan. On a new project, where the state bucket
`gs://<project>-aw-tfstate` does not exist yet, it says so and stops without creating anything
or printing a plan: the first plan you see is the one `--yes` applies, so read the preflight and
the plan summary of a second `aw deploy production` once the bucket exists if you want a look
first. Once the stack exists it prints the plan summary and exits 3 while changes are pending:

```text
Plan summary
  9 to create, 1 to update, 0 to delete, 0 to replace
  By resource kind:
    google_cloud_run_v2_service: 2 create
    google_sql_database_instance: 1 create
    ...
  Protected resources: none would be deleted or replaced
  Idle cost: small: Cloud SQL shared-core, one warm web instance and the gateway internal load balancer are the idle costs
```

The gateway's internal load balancer is billed while the stack exists, whether or not it carries
traffic. An internal Application Load Balancer is billed per proxy instance, with at least three
per forwarding rule even with no traffic. At US list price that is 3 x US$0.025 an hour, US$0.075
an hour (about US$55 a month), plus US$0.008 per GiB processed (US list price; check your region
in [Google's network pricing](https://cloud.google.com/vpc/network-pricing)).

If you turn on `gcp.sandboxInternet`, a proxy VM (e2-small, about US$0.017 an hour) and a Cloud NAT
gateway (US$0.0014 an hour per VM, US$0.045 per GiB and US$0.005 an hour per NAT IP) are added. Cloud
SQL `db-f1-micro` is about US$0.0105 an hour. These are US list prices; check your region on the
[Compute Engine](https://cloud.google.com/products/compute/pricing/general-purpose),
[Cloud NAT](https://cloud.google.com/nat/pricing) and [Cloud SQL](https://cloud.google.com/sql/pricing)
pricing pages.

The second command does the work, one step at a time, each with its elapsed time: check the state
bucket (created if absent: versioned, uniform access, public access prevention), initialise
Terraform, enable the APIs and create the image repository, copy the release images by digest,
then plan and apply. On the first deploy, while the images copy, a targeted apply creates Cloud SQL
and its private network, which take most of the deploy's time, and the Secret Manager key's grant
to its service agent, with the one-minute wait that agent needs; both finish before the full plan. When a step fails it names the step, the first useful error line and the
command that repeats it; every step is safe to repeat. It ends with:

```text
web: https://aw-web-123456789012.asia-northeast1.run.app
sign-in: Owner password (set gcp.oidc for single sign-on)
model: Claude on Vertex AI (global), using this install's Google Cloud identity
owner: admin@localhost.test
owner password: aw deploy production --show-owner-password
```

The `model:` line shows that the first deploy connected Claude on Vertex AI (here in the `global`
location), using this install's Google Cloud identity, and chose it as the default model. No model key is
created or stored. If seeding fails, the deploy still succeeds, prints a warning with the reason
and asks you to open the web URL and finish setup in the browser, choosing Claude on Google Cloud
(Vertex AI) there.

The password is never printed by default. Print it once, then sign in:

```sh
aw deploy production --show-owner-password
aw login --url https://agents.example.com
```

Map the `url` host to the web service (a Cloud Run domain mapping, or a load balancer in front of
it), then sign in as the Owner. Running `aw deploy production --yes` again on an unchanged
project is a plan with no changes. Changing the Owner's email in `agent-workspace.yaml` takes
effect on the next run.

## From a laptop

Install Node.js 24 or later, `@indx-workspace/cli`, the Google Cloud command line, Docker and
[Terraform 1.8 or later](https://developer.hashicorp.com/terraform/install). Sign in twice, once for
Terraform and once for gcloud itself (the checks and the state bucket use the second), then run the
same two commands:

```sh
gcloud auth application-default login
gcloud auth login
aw deploy production
aw deploy production --yes
```

## Check a deployment

```sh
aw deploy status production
```

It changes nothing. It prints the versions in the state (the CLI, the three images and the runtime
image), whether each service's latest revision is ready, whether data protection is on, and whether
Terraform would change anything (drift). It exits 0 when every service is ready and nothing has
drifted, 3 when the plan has changes, and with an error when a service is not ready. Day-two tasks (upgrade, rollback,
restore, rotation) are in the [runbook](../operations/gcp-cloudrun-runbook.md).

## Verify what you install

From the first `packages-v*` release built with the digest-pin step, the release pins every
platform image (web, gateway, runner, runtime and the other images the release lists) by digest;
earlier published CLI versions carry no digests. `aw deploy` copies only those digests into your Artifact Registry. The
platform images are signed keyless, with an SBOM and SLSA provenance, by the `images.yml` workflow.
This covers the platform images only: the Cloud SQL Auth Proxy sidecar and the proxy VM's operating
system image are Google images and are not pinned or signed by this project.

When `cosign` v3 or newer is on your `PATH` (the images are signed with cosign v3; with an older
cosign `aw deploy` says the signatures were not verified and continues), `aw deploy` verifies each image's signature before it copies
anything, and stops if one does not verify. Without `cosign` it says the signatures were not
verified and continues. To check an image yourself:

```sh
cosign verify \
  --certificate-identity-regexp '^https://github\.com/indxjp/agent-workspace/\.github/workflows/images\.yml@refs/tags/images-v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/indxjp/agent-workspace/web@sha256:<digest>
```

The signing identity is `https://github.com/indxjp/agent-workspace/.github/workflows/images.yml@refs/tags/images-v*`
and the issuer is `https://token.actions.githubusercontent.com`. If you set `AW_WEB_IMAGE`,
`AW_GATEWAY_IMAGE`, `AW_RUNNER_IMAGE`, `AW_RUNTIME_IMAGE`, `AW_TOOL_HOST_IMAGE` or
`AW_EGRESS_PROXY_IMAGE`, `aw deploy` warns that the image is not one this release pinned; overrides
are never signature-verified.

## Enterprise options

These go beyond what the module sets up. Evaluate them with Google before you rely on them.

- **VPC Service Controls.** You can put the project in a service perimeter that restricts
  `aiplatform.googleapis.com` and the storage and Secret Manager APIs. Google documents no specifics
  for Claude partner models under VPC Service Controls, and the perimeter needs
  `restricted.googleapis.com` routing, which the default module does not set up. This is an option,
  not a shipped feature.
- **Secure Web Proxy.** A Google-managed allow-list proxy is an enterprise alternative to the proxy
  VM the module ships. It is billed at US$1.25 an hour plus US$0.0193 per GiB (US list price; check
  your region at [Secure Web Proxy pricing](https://cloud.google.com/secure-web-proxy/pricing)). The
  module does not deploy it.

Where prompts go: with the `global` Vertex AI endpoint, Google routes a request to any region with
capacity, so prompts stay in Google Cloud but not in one region. For residency in one location set
`gcp.modelLocation: us` or `eu`, at about 10% more.

## Remove a deployment

```sh
aw deploy destroy production
```

It checks your tools, sign-in and project as the deploy does, prints a plan of what would be deleted, and deletes nothing until you
type your Google Cloud project id (at the prompt, or as one line on standard input). A different
id stops it with nothing destroyed.

Destroy can need one to two hours for the network. Google Cloud releases the subnetwork only that
long after the services that used it are deleted, so the first destroy deletes everything else and
then says the network is still held. Run `aw deploy destroy production` again after that.

Data protection is on by default (`gcp.dataProtection`), and destroy refuses while any of it is on:
Cloud SQL and the web, gateway and runner-manager services have deletion protection, and the
buckets cannot be emptied by a destroy. It stops before deleting anything and says how to go on.
To remove a stack and its data:

1. Set `dataProtection: false` in the `gcp` block of `agent-workspace.yaml`.
2. Run `aw deploy production --yes`, which turns the protection off.
3. Run `aw deploy destroy production`.

Both buckets are versioned with a 7-day soft delete, so a deleted bucket stays restorable, and
billed, for 7 days. A stack that holds data you want to keep should not be destroyed. The state
bucket `gs://<project>-aw-tfstate` and the project's KMS key rings are kept (Google Cloud cannot
delete key rings).

The same project name cannot be deployed again in the same Google Cloud project right away: the module
names the KMS key ring `<name>-secrets` and the Cloud SQL instance `<name>-pg` after the project,
Google Cloud keeps the key ring for good and reserves a deleted instance name for about a week, so
the next `aw deploy production --yes` fails with `already exists`. Rename the project in
`agent-workspace.yaml` (or use another Google Cloud project) to deploy again sooner.

## Maintainers: `--infra`

The steps below drive the Terraform module of a claude-agent-workspace checkout instead of the one
shipped with the CLI, and are the procedure for a project that has no `gcp` block. The checkout's
module is never written to.

### From a project, with `--infra`

A v2 project names the target in its own `agent-workspace.yaml`, and `aw deploy` renders the
module's variables and runs `terraform plan` (and, with `--yes`, `terraform apply` of that plan)
through `agent-workspace deploy` (ADR-0103, #621):

```yaml
environments:
  # local: as npm create wrote it
  production:
    target: gcp-cloudrun
    url: https://agents.example.com
    gcp: # optional here; without it, project_id comes from terraform.tfvars
      project: acme-prod
      region: asia-northeast1
```

```sh
aw deploy production --infra ../claude-agent-workspace/infra --plan
aw deploy production --infra ../claude-agent-workspace/infra --yes
```

Without `--yes` it only plans: it exits 0 when the stack matches and 3 when changes are pending;
`--plan --yes` is refused. The variables it renders are the Owner's email
(`environments.local.identity.bootstrapAdmin`) and the four images; everything account-scoped
stays in the module's `terraform.tfvars`; a `gcp` block supplies `project_id` and `region` instead.

**What the Owner provides.** Each is refused by name, before anything is created, when missing:

| Prerequisite                                                             | Refused with                                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Node.js 24 or later, and `@indx-workspace/cli` beside `aw`               | `Node.js 24 or later is required` / `install @indx-workspace/cli` |
| `--infra`: the `infra/` directory of a claude-agent-workspace checkout   | `--infra <dir> is required` / `holds no Terraform module`         |
| `project_id`: the `gcp` block, `terraform.tfvars` or `TF_VAR_project_id` | `The gcp-cloudrun module has no project_id`                       |
| Terraform 1.8 or later                                                   | `Terraform is not installed`                                      |
| The module initialised with a GCS backend                                | `The Terraform module gcp-cloudrun is not initialised`            |
| The four images copied into the module's Artifact Registry               | `The <name> image is …, which Cloud Run cannot pull`              |
| A GCP project with billing, and `gcloud auth application-default login`  | not checked; Terraform's own authentication error                 |
| DNS for the `url` host mapped to the web service                         | not checked; `aw deploy --yes` names the `web_url` output to map  |

### Prepare the module (once)

```sh
cd claude-agent-workspace/infra/terraform/gcp-cloudrun
printf 'project_id = "acme-prod"\nregion     = "asia-northeast1"\n' > terraform.tfvars
gcloud auth application-default login
terraform init -backend-config="bucket=acme-prod-tfstate" -backend-config="prefix=agent-workspace"
```

`region` and `name` (the resource prefix, `agent-workspace` by default) are optional. The state
bucket is yours to create; the module does not.

### Copy the images into Artifact Registry, by digest

Cloud Run cannot pull from `ghcr.io`, where the release is published, and the runner manager must
be able to read the runtime image it creates every runtime service from. The module grants it
`roles/artifactregistry.reader` on its own repository and, when `images.runtime` is in another
repository of the same project, on that repository too; a runtime image anywhere else is refused at
plan. So the four images are copied into the module's repository first. The repository is part of the module, so create it alone with a
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

### After the apply

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

## Apps

An entry under `environments.production.apps` in `agent-workspace.yaml` deploys a portal app next
to the platform (the project file reference shows how to declare one). Each app becomes its
own Cloud Run service, `<name>-app-<app>`:

- **Its own service account.** It is a Cloud SQL client on the install's instance and can read its
  own two secrets (its database password and its connection string). It holds nothing else.
- **Its own database role.** The app runs as the PostgreSQL role `app_<name>`, which owns only the
  schema `app_<name>`. A one-off Cloud Run job creates the role and schema at deploy. The app never
  receives the platform's `DATABASE_URL`.
- **Migrate on start, always on.** The app applies its migrations as it starts, so it never serves
  an older schema. It keeps one instance running with CPU always allocated, because recipes run in
  the app's own process.
- **Pinned image.** The app image is copied into the install's Artifact Registry by digest, beside
  the platform images. The tool-host image is copied the same way.
- **Internal ingress.** Without `gcp.domain`, the app is reachable only from inside the network:
  its `run.app` URL answers 404 from the internet, and sandboxes cannot reach it. With `gcp.domain`,
  the load balancer serves the app's `url` host with its own managed certificate. Point that host
  at the `load_balancer_ip` output. The Terraform module tests cover this routing; the live workflow
  does not exercise it.

Limits today:

- **Agents cannot call an app's MCP endpoint on Cloud Run yet.** Sandboxes reach only the gateway,
  and MCP connectors are dialled from the sandbox.
- **The app's workspace id, API key and connector id have no place in a Cloud Run deployment yet.**
  Until a later release the app answers only `/api/health` and its routing.

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
manager, using the workspace's default runtime profile. On Cloud Run the manager places each tool
sandbox as an internal Cloud Run service `rt-tool-<id>` on the sandbox subnet, under the same
no-egress firewall as an agent sandbox. Only the gateway reaches it, with a Google ID token it
mints for that service. The gateway's service account holds `roles/run.servicesInvoker` (invoke
only, never a Job) under the condition
`request.host.startsWith("rt-tool-") && request.host.endsWith(".run.app")`, which matches a tool
sandbox's URL (`https://rt-tool-<id>-<hash>-<region>.a.run.app`) and no agent sandbox (`rt-<uuid>`)
or other service of the stack; the module's `name` may not start with `rt-` for that reason. The
condition is on the request's host because Cloud Run gives the invoke check `request.host` and
`request.path` but no service name, so a `resource.name` condition grants nothing there, and
setting a per-service policy or disabling the invoker check would need `run.services.setIamPolicy`
([IAM attribute reference](https://docs.cloud.google.com/iam/docs/conditions-attribute-reference),
[Cloud Run access control](https://docs.cloud.google.com/run/docs/securing/managing-access)). The
runner manager refuses to open a tool sandbox whose URL is not an `https://rt-tool-….run.app`
origin, since the gateway could not call it. A Cloud Run refusal of the gateway is a bare 403 at
the tool sandbox. Revoking the endpoint client, one of its keys or an OAuth grant closes its
sandbox at once, best effort; a sandbox the close could not reach is deleted by the next tool
sandbox start once its lifetime (the run deadline plus a margin) has passed.
