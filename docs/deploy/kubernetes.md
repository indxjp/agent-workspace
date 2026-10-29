# Kubernetes — Helm

The portable chart is under `infra/helm/agent-workspace`. It deploys the web control plane, private
gateway, and runner manager, each from its own digest-pinned image; cloud value files change
configuration, not application code.

## The deployment profile

The digests and the bootstrap identity below come from one `agent-workspace.yaml` rather than
being typed twice. Generate it, then layer the rendered overlay on the flavour file:

```sh
npx -p @indx-workspace/cli create-agent-workspace acme-ai --cloud aws   # or gcp
helm upgrade --install agent-workspace infra/helm/agent-workspace \
  --namespace agent-workspace \
  -f infra/helm/agent-workspace/values-eks.yaml \
  -f acme-ai/deploy/helm/values.yaml \
  --wait
```

`--cloud azure` is not on that list: the chart does not carry Azure Blob's endpoint and identity
contract, while the
Azure profile defaults to an `azblob://` container whose managed-identity wiring lives in the
Container Apps module (`docs/deploy/azure-container-apps.md`). The generator withholds the overlay
and says so rather than offering an install without a usable object store. Name an `s3://` bucket
in `agent-workspace.yaml` to deploy an Azure profile with this chart.

The overlay carries only `images`, because the chart defaults everything else and each flavour file
already sets its cloud's storage class and load-balancer annotation. The three Secrets the chart
reads are created from the rendered `acme-ai/.env`; no credential is written into a values file.
Split that file across them as follows, and put each variable in exactly one:

| Secret                       | Variables from the rendered `.env`                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `external.databaseUrlSecret` | `DATABASE_URL`                                                                                                                                                                                                                                                                                                                                                                                     |
| `external.objectStoreSecret` | `AW_STORAGE_URL` (unless you set the chart value `storage.url`, below), `AW_STORAGE_SIGNED_UPLOAD_MAX_BYTES`, `OBJECT_STORAGE_ACCESS_KEY_ID`, `OBJECT_STORAGE_SECRET_ACCESS_KEY`, `AWS_REGION`. An older `.env`'s storage location variables are ignored: leave them out                                                                                                                           |
| `secrets.applicationSecret`  | everything else the file sets — `MASTER_KEY_PROVIDER`, `GCP_MASTER_KEY_SECRET`, `MASTER_ENCRYPTION_KEY`, `SESSION_SECRET`, `GATEWAY_TOKEN_SECRET`, `RUNNER_MANAGER_TOKEN`, `BOOTSTRAP_ADMIN`, `BOOTSTRAP_ADMIN_PASSWORD`, `GATEWAY_PRICING_JSON`, the other `AW_*` values and the `WORKSPACE_*` values, the three service addresses, and the four `OIDC_*` values when the profile names an issuer |

Do not put a key in two of them. Each Deployment lists all three under `envFrom`, and `envFrom`
resolves a duplicate key by source order — the last one wins. The rendered `.env` sets
`DATABASE_URL` for every cloud, empty where the cloud's own module supplies it, so copying the
whole file into the application Secret leaves a blank `DATABASE_URL` there that shadows the real
one in `external.databaseUrlSecret`, and the pod starts against no database.

`npx -p @indx-workspace/cli agent-workspace validate acme-ai` re-checks the profile and probes the
stores it names. A `--cloud` project deploys through the chart rather than through a package
manager, so it ships no `package.json`; the `-p` form runs the operator CLI without one. The field
reference is `packages/cli/README.md`.

The rendered `.env` fills in the addresses the chart publishes — `MODEL_GATEWAY_URL`,
`AW_SESSION_MIRROR_URL` and `RUNNER_MANAGER_URL` are the `agent-workspace-gateway`,
`agent-workspace-web` and `agent-workspace-runner-manager` Services. These are the values left for
the operator, each under a comment in the file saying so:

| Variable                                                           | Who supplies it                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                     | on `--cloud gcp` and `--cloud azure`, the managed PostgreSQL that cloud's module provisions; on `--cloud aws` there is no module, so you provision the store and put its URL in the Secret the chart names in `external.databaseUrlSecret`                     |
| `OBJECT_STORAGE_ACCESS_KEY_ID`, `OBJECT_STORAGE_SECRET_ACCESS_KEY` | an S3 endpoint's explicit credential when workload identity is unavailable. Leave both empty for native GCS: the Google client uses ADC. Each Deployment still maps these optional keys onto `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` for the S3 backend. |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`        | the client registration at the issuer. These three and `OIDC_ISSUER_URL` are rendered only when the profile names an issuer — a profile without one renders none of the four, and there is nothing to fill in                                                  |

`RUNNER_URL` is rendered empty on purpose and is not one of them: the chart runs no fixed runner.
The runner manager creates a Pod per session (`runtime.driver: kubernetes`, below) and returns its
address per run.

`AW_TRUSTED_PROXY_HOPS` is rendered `1`: one ingress or cloud load balancer appends
`X-Forwarded-For`. Change it if your chain differs, as
[Client addresses behind a proxy](single-vm.md#client-addresses-behind-a-proxy-aw_trusted_proxy_hops)
explains.

## Object storage

Put `AW_STORAGE_URL` in the Secret named by `external.objectStoreSecret`, which reaches the pods
through `envFrom`, or set it as the chart value `storage.url`:

```yaml
storage:
  url: s3://acme-ai-files?region=eu-west-1
```

`storage.url` takes any form the server accepts (`s3://`, `gcs://`, `azblob://` or `file://`; see
[Configuration](../sdk/site/getting-started/configuration.mdx#tell-the-server-where-files-live)).
When it is set, web, the gateway and the runner manager read it in place of the Secret's copy; left
empty, the default, the Secret still supplies the URL, so an existing install keeps working. The
URL never holds a key, so it can live in a values file. The chart still reads the legacy
Secret keys `OBJECT_STORAGE_ACCESS_KEY_ID` and `OBJECT_STORAGE_SECRET_ACCESS_KEY` and maps them onto
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, so keep those keys there when the S3 endpoint needs
an explicit credential. The old location keys are ignored: each one still set logs one
`storage_setting_ignored` warning that names it, and with `AW_STORAGE_URL` unset nothing is read
from the old location, so files, skills and session state are off. Remove them; the
[migration table](../sdk/site/concepts/data-plane.mdx#migrating-from-the-old-variables) maps each
one to the URL. The URL never carries a key. To limit the pods to their bucket and prefix, use the IAM policy
in [Protect stored files](../sdk/site/features/self-host-securely.mdx#protect-stored-files) on the
IRSA role below.

## AWS workload identity and KMS

The chart gives web and gateway a dedicated `serviceAccount`. On EKS, annotate it with the IAM role
that may use the configured S3 bucket and decrypt the deployment key:

```yaml title="aws-workload-identity.yaml"
serviceAccount:
  name: agent-workspace
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::<account-id>:role/agent-workspace-control-plane
```

Layer this operator-owned file after `values-eks.yaml`. The role needs bucket listing plus
get/put/delete on that bucket's objects, and `kms:Decrypt` on the symmetric KMS key. The running
application deliberately has neither `s3:CreateBucket` nor KMS encrypt/re-encrypt authority. A
missing bucket therefore leaves `/api/files*` and `/api/skills*` on their existing `503
..._runtime_not_configured` paths instead of creating infrastructure from a typo.

Create one random 32-byte key locally under a restrictive umask, encrypt it with KMS using the
required context `agent-workspace-purpose=master-key`, and put only the command's base64
`CiphertextBlob` in `AWS_KMS_ENCRYPTED_MASTER_KEY`. Do not print or commit the plaintext; remove the
temporary plaintext immediately after KMS accepts it. `AWS_KMS_KEY_ID` is the symmetric key ARN or
alias used by that encrypt call.

### Rotate the KMS key

AWS-managed automatic rotation is transparent: the ciphertext continues to decrypt through the
same logical KMS key and no Agent Workspace value changes. To move to a different KMS key:

1. Temporarily grant the operator `kms:ReEncryptFrom` on the old key and `kms:ReEncryptTo` on the
   new key; the workload itself still needs only `kms:Decrypt`.
2. Pass the decoded ciphertext blob to `aws kms re-encrypt`, with
   `--source-encryption-context agent-workspace-purpose=master-key` and
   `--destination-encryption-context agent-workspace-purpose=master-key`. Capture its base64
   `CiphertextBlob` without printing it.
3. Version `secrets.applicationSecret` atomically with the new `AWS_KMS_KEY_ID` and
   `AWS_KMS_ENCRYPTED_MASTER_KEY`, then roll web and gateway together. The underlying 32-byte key
   and its fingerprint do not change, so no database row is rewritten.
4. Exercise a connector or model connection that was stored before the rotation. Only after that
   succeeds, remove the old key grant and the operator's temporary re-encrypt grants.

If startup cannot decrypt the blob, the encrypted-secrets subsystem stays uninstalled. It never
falls back to `MASTER_ENCRYPTION_KEY`, a generated key or plaintext storage.

A `MASTER_ENCRYPTION_KEY` that is set but malformed (with `MASTER_KEY_PROVIDER=local-key`) also
leaves that subsystem uninstalled, and in addition fails web's readiness probe, `GET /api/readyz`,
so the rollout stops. The probe answer and the boot log both name the variable and the expected
format (64 hex characters) and never its value. See the
[runbook](../operations/runbook.md#service-health-and-rollout).

## Render before touching a cluster

Supply an immutable digest for each of the four images:

```sh
helm lint infra/helm/agent-workspace
helm template agent-workspace infra/helm/agent-workspace \
  --set-string images.web=registry.example/agent-workspace/web@sha256:WEB_DIGEST \
  --set-string images.gateway=registry.example/agent-workspace/gateway@sha256:GATEWAY_DIGEST \
  --set-string images.runnerManager=registry.example/agent-workspace/runner@sha256:RUNNER_DIGEST \
  --set-string images.runtime.claude-agent-sdk=registry.example/agent-workspace/runtime-claude-agent-sdk@sha256:RUNTIME_DIGEST
```

`images.runnerManager` takes the `runner` image: the runner manager is the root `Dockerfile`'s
`runner` target, which `infra/release/build-and-push.sh` publishes under that name.

Select one of `values-eks.yaml`, `values-gke.yaml`, `values-aks.yaml`, or
`values-openshift.yaml` with `-f` when targeting that distribution. Review the rendered service
accounts and network policies before installation.

## Network policy

The chart denies all ingress and egress for every pod in the namespace and then allows what the
release needs, selected by each pod's `app.kubernetes.io/name` label: DNS for every pod of the
release (`dns.namespace`, `dns.podSelector`; `values-openshift.yaml` sets the OpenShift DNS
operator's), the database port for web, the migrate Job, the gateway and the runner manager, runner
manager to gateway, web to runner manager, and gateway to web on 3000 (the Builder's `aw-control`
tools). The database rule opens only `database.port` (5432)
until you narrow it with `database.cidr` (an external PostgreSQL's address range) or
`database.podSelector` (an in-cluster one's labels). The default deny also covers a PostgreSQL pod
in the same namespace, so it needs its own ingress policy from the chart's pods; running it in
another namespace avoids that, and `database.namespace` names that namespace for
`database.podSelector`.

Three more rules take the same `cidr` / `podSelector` / `namespace` shape: web and the gateway to
the model providers (`providers`, port 443, the public internet minus the private ranges by
default), web to the object store (`objectStore`, port 443, open on that port until you narrow it),
and the runner manager to the Kubernetes API (`kubernetesApi.ports`, narrowed by
`kubernetesApi.cidr`, the address from `kubectl get endpoints kubernetes`; set it in production, or
the runner manager may reach any host on those ports). Narrow `providers` to
your provider or egress proxy when you know where it is.

## Agent sessions

`runtime.driver: kubernetes` (the default) makes the runner manager run each agent session in a Pod
in the release namespace, created with the manager's own ServiceAccount token
([ADR-0124](../adr/0124-kubernetes-sandboxes-run-in-the-release-namespace.md)). Nothing is created
cluster-wide: the manager's Role grants `pods`, `networkpolicies` and `services` in the
namespace. Each sandbox runs as the `agent-runtime` ServiceAccount, which has
no Role and no token, behind its own default-deny NetworkPolicy that opens only the gateway (and the
egress proxy when `runtime.egressProxyImage` is set to a digest-pinned image of
`egress-proxy.Dockerfile`). Set `runtimeClassName` to run sandboxes under gVisor or Kata.

The runner manager keeps its sandbox allocations in memory, so the chart runs one replica of it and
keeps it out of the autoscaler; do not raise `replicas.runnerManager`. A sandbox is deleted when its
session ends; if the manager crashes mid-allocation, delete leftovers by the
`app.kubernetes.io/name=agent-runtime` label. Tool sandboxes are not placed on the kubernetes driver
yet.

`aw deploy production` installs this from a `kind: Project` file with `target: kubernetes`. The
values it does not own go in an operator values file named by `AW_HELM_VALUES`, which Helm reads
between the chart's `values.yaml` and the `aw deploy` overlay:

```yaml title="operator-values.yaml"
providers:
  cidr: 203.0.113.0/24 # your egress proxy or provider range
  except: []
runtime:
  egressProxyImage: registry.example/agent-workspace/egress-proxy@sha256:PROXY_DIGEST
```

```sh
AW_HELM_VALUES=operator-values.yaml aw deploy production --yes --infra ./infra
```

`.github/workflows/isolation.yml`'s `kind-deploy` job runs exactly this on kind with Calico: install,
one agent turn against a fake provider, an assertion that the session ran in a Pod the runner manager
created, and the isolation cases against those Pods (`infra/tests/isolation/README.md`). A managed
cluster has not been proven yet.

`ingress.enabled` renders one Ingress for `ingress.host` (`ingress.className`, and
`ingress.tls.clusterIssuer` for a cert-manager certificate in `agent-workspace-tls`) and admits web
from `ingress.controllerNamespace`. `deploymentPolicy` sets `AW_DEPLOYMENT_POLICY` on web.
`aw deploy production` with `target: kubernetes` sets these from the project file.

## Install

Create the namespace and secrets through the cluster's secret manager, then install:

```sh
kubectl create namespace agent-workspace
helm upgrade --install agent-workspace infra/helm/agent-workspace \
  --namespace agent-workspace \
  --set-string images.web=registry.example/agent-workspace/web@sha256:WEB_DIGEST \
  --set-string images.gateway=registry.example/agent-workspace/gateway@sha256:GATEWAY_DIGEST \
  --set-string images.runnerManager=registry.example/agent-workspace/runner@sha256:RUNNER_DIGEST \
  --set-string images.runtime.claude-agent-sdk=registry.example/agent-workspace/runtime-claude-agent-sdk@sha256:RUNTIME_DIGEST \
  --wait
kubectl -n agent-workspace get pods
```

The chart's lint and template paths are verified without a cluster, and the install and an agent
turn are verified on kind in CI (above). The full Kubernetes A.12 lifecycle, gVisor, and the
four managed-cluster installs remain external-resource proofs rather than claimed passes.

### Upgrading to the engine-identity release (single-revision cutover)

The release that carries migrations `0024` and `0025` is not compatible with the previous release
([ADR-0069](../adr/0069-the-engine-identity-migrations-require-a-single-revision-cutover.md)), and
`web` migrates as it starts, so a rolling update would migrate the database under pods that can no
longer read it. Back up PostgreSQL, scale every previous-release Deployment in the namespace to zero,
wait for the pods to terminate, then run the `helm upgrade --install` above with the new digests:

```sh
kubectl -n agent-workspace scale deployment --all --replicas=0
kubectl -n agent-workspace wait --for=delete pod --all --timeout=300s
```

### Upgrading to the engine-scoped session-state release (single-revision cutover)

The release that carries migrations `0026` and `0027` needs the same cutover
([ADR-0071](../adr/0071-one-engine-scoped-session-state-store.md)). Its schema is additive, but
`0027` copies every Claude transcript into the new store **once**, when `web` migrates at start-up;
a previous-release pod still serving during a rolling update would keep writing turns to the legacy
tables that nothing copies, and a later resume would silently lose them. Back up PostgreSQL, scale
every previous-release Deployment to zero and wait for the pods to terminate (the two commands
above), then `helm upgrade --install`. Rollback means restoring that backup together with the
previous digests.

If PostgreSQL runs in the same namespace, scale only the `web`, `gateway` and runner-manager
Deployments instead of `--all`. Rollback means restoring the backup together with the previous
images.

## Uninstall

```sh
helm uninstall agent-workspace --namespace agent-workspace
```

Delete persistent volumes only under the deployment's retention policy.

## Public URL for external agent platforms (`AW_PUBLIC_URL`)

Set `AW_PUBLIC_URL` on the `web` deployment to the https origin external platforms reach it at, with
no path (`https://aw.example.com`). The A2A agent card (ADR-0135) builds its `url` from it; unset,
the card route answers `503 a2a_public_url_not_configured` and JSON-RPC calls still work. It is also the
OAuth 2.1 issuer for endpoint clients (ADR-0134): unset, `/oauth/*` and the `/.well-known/oauth-*`
documents answer `404 oauth_not_configured`. Set the chart's
`publicUrl` value (`aw deploy` sets it to the origin of the production URL, and
`agent-workspace render` sets it from `AW_PUBLIC_URL` in `.env`); empty, the `web`
deployment gets no `AW_PUBLIC_URL` and the rendered manifest is unchanged.

## Project tool endpoint (`/mcp/projects/:name`)

The endpoint (ADR-0134 part 2) runs a project's code tools in a tool sandbox opened by the runner
manager, using the workspace's default runtime profile. The kubernetes driver does not place tool
sandboxes yet (see Agent sessions), so on this deployment a tool call answers
`503 tool_endpoint_unavailable`. Revoking the endpoint client, one of its keys or an OAuth grant
closes its sandbox at once, best effort; the idle timeout ends it if the close cannot reach the
runner manager.
