# ADR-0055 — The deployment profile is one validated document, and every artefact is rendered from it

Status: accepted
Superseded in part by: ADR-0060 (`azblob://`), ADR-0061 (`key-vault`) and ADR-0089 (the document format)
Date: 2026-09-21
Decided by: the Owner
Scope: `packages/cli/`, the rendered `.env` / Compose / Helm / Terraform artefacts, `infra/helm/agent-workspace/templates/services.yaml`, `infra/helm/agent-workspace/templates/deployments.yaml`, `infra/helm/agent-workspace/values.yaml`, `infra/helm/agent-workspace/values.schema.json`, `infra/tests/contracts.test.mjs`, `docs/deploy/`

## Context

A deployment of Agent Workspace makes five decisions: which relational store holds its rows, where
its bytes go, what protects its credentials, which sandbox driver its agents fall back to, and who
signs people in. Today none of those five is written down as one thing. An operator assembles
`DATABASE_URL`, `OBJECT_STORAGE_*`, `MASTER_ENCRYPTION_KEY`, `SESSION_SECRET`,
`RUNNER_MANAGER_TOKEN`, `AW_TRUSTED_PROXY_HOPS` and the `OIDC_*` variables by hand from
`.env.example` and the deploy guides, and then repeats a subset of the same decisions in a Helm
values file or a Terraform module. The generator (`create-agent-workspace`) asks four free-text
questions and writes one hard-coded `.env`; it has no cloud dimension at all.

The cost is not typing. It is that the same decision exists in three places with no mechanism
making them agree, and that nothing refuses a decision this release cannot honour — a profile
naming Azure Blob Storage or Cloud KMS would be accepted by every file that carries it and fail
only when a request reached the store.

This is roadmap item D-1, and the roadmap's prefix table requires a `D-n` item to become an ADR
before work starts (the SDK migration playbook §2, move 0).

## Decision

**One profile, `agent-workspace.yaml`, is the single source, and every artefact is a pure function
of it.**

```yaml
apiVersion: agentworkspace.dev/v1 # since ADR-0089
kind: Deployment
cloud: aws | gcp | azure | local
storage:
  relational: <postgres:// URL> | rds | cloud-sql | azure-postgres | compose-postgres
  objects: s3://<bucket> | local-filesystem
  secrets: local-key
runtime:
  default: local | sandbox-runtime | docker | kubernetes | cloud-run-service | aca-sessions
identity:
  oidc: <https:// issuer URL> # optional
  bootstrapAdmin: <email>
```

### What each store accepts today, and what is refused

| Field                | Accepted                                                                                                                                                    | Refused, and why                                                                                                                                                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage.relational` | `postgres://`, `postgresql://`; or the store of _that_ cloud by name — `rds`, `cloud-sql`, `azure-postgres`, and `compose-postgres` for the Compose project | Every other scheme. This agrees with `packages/core/src/db/client.ts`, which already refuses them — a profile that validated here and failed at start-up would be the worst of both checks. A name belongs to one cloud, so `rds` on GCP is refused.              |
| `storage.objects`    | `s3://<bucket>`; `gcs://<bucket>` on GCP; `local-filesystem` on `local` and `azure`                                                                         | `azblob://` is still undelivered; `gcs://` is refused outside GCP. `local-filesystem` is refused on `aws` and `gcp`, which have native object stores. ADR-0058 records the later GCS decision.                                                                    |
| `storage.secrets`    | `local-key`; `secret-manager` on GCP                                                                                                                        | `kms` and `key-vault` remain undelivered; `secret-manager` is refused outside GCP. ADR-0059 records the later provider decision.                                                                                                                                  |
| `runtime.default`    | the six driver ids `packages/runtime` implements                                                                                                            | `gke-agent-sandbox`, `aws-agentcore`, `aws-ecs`, `cloud-run-sandbox` and `external` are ids the runtime contract lists with no code behind them. They are refused with a message saying so, which is a different failure from a typo and is reported differently. |
| `identity.oidc`      | an `https://` issuer URL, or absent                                                                                                                         | The client id, secret and redirect URI are per-deployment and one of them is a secret, so the profile never holds them.                                                                                                                                           |

The reserved and undelivered values are **named in their refusals rather than omitted from the
vocabulary**: an operator who writes `secrets: key-vault` learns that Key Vault is roadmap item
D-3, not that they made a typo.

### No secret belongs in the profile, including the one the generator makes itself

The profile's own header says a secret does not belong in it, and that has to be true of the file
the generator writes, not only of the ones an operator edits. The Compose project's PostgreSQL
password is generated per project, so the obvious rendering — a full
`postgres://agent_workspace:<password>@postgres:5432/agent_workspace` in `storage.relational` —
would have put a live credential into the one artefact meant to be committed.

`local` therefore names its store the way every cloud already does: **`compose-postgres`**. The
connection string is assembled in `render/env.ts` and exists in `.env` alone, `relationalTarget`
reads `DATABASE_URL` for it exactly as it does for `rds` or `cloud-sql`, and the generated project
ships a `.gitignore` covering `.env`. The MinIO credentials were never in the profile — the bucket
is (`s3://agent-workspace`), the access key and secret are rendered into `.env` — so the same rule
already held for them. `render/artefacts.test.ts` scans every committed `agent-workspace.yaml`
golden for each generated secret and finds none, which is what keeps the header honest.

### The env-var mapping lives in exactly one place

`packages/cli/src/render/env.ts` is the only code in the repository that maps a profile to the
variables the platform reads. `.env.example` is the documented inventory and
`docs/sdk/site/concepts/data-plane.mdx` prints the same list with each variable's reader;
`env.test.ts` asserts that every variable `.env.example` declares is rendered, so the mapping
cannot drift from the documentation without a failing test.

Two consequences of writing it down once:

- **Every cloud renders the same key set**, with three deliberate exceptions, all of them
  Compose's own. A value only the target can know — a managed database's URL, an IAM-supplied
  object-store credential — is rendered _empty_, under a comment naming what supplies it. That is
  what `.env.example` already does for `MASTER_ENCRYPTION_KEY`, and it makes "the rendered env is
  what a hand-written one would contain" a mechanical check rather than a judgement. The
  exceptions are `POSTGRES_IMAGE` and `MINIO_IMAGE`, which pin two services only the Compose
  project runs — so a cloud target neither renders them nor resolves them, and `DeploymentImages`
  carries them as optional members that `assertDigestReferences` still gates whenever they are
  present — and `PORT`, which is the host port `templates/compose.yaml` publishes the web service
  on. A cluster takes each listener from the chart instead: `templates/deployments.yaml` sets
  `PORT` per container from the same `$ports` dict the `containerPort` comes from, as an `env`
  entry, which wins over the three `envFrom` Secrets, so no Secret content can move a listener
  away from the port its Service routes to.
- **An in-cluster address is a value the generator does know.** The chart publishes Services for
  web, the gateway and — from this unit — the runner-manager, so a cloud target renders
  `AW_SESSION_MIRROR_URL`, `MODEL_GATEWAY_URL` and `RUNNER_MANAGER_URL` from those names rather
  than leaving them blank. `RUNNER_URL` stays empty under a comment, because there is genuinely no
  such address: the chart deploys no runner, and the runner-manager returns each sandbox's address
  per run. `infra/tests/contracts.test.mjs` holds the rendered goldens against
  `templates/services.yaml`, so a renamed or deleted Service fails a test instead of producing a
  deployment that cannot reach its gateway.
- **`AW_TRUSTED_PROXY_HOPS` is now rendered**, and the Compose template passes it to `web`. It is
  in `.env.example`, it is required, runnable public shares fail closed without it, and the
  generator has been silently omitting it. `local` is `0` (the Compose project publishes the web
  port directly); every cloud target is `1` (one load balancer or ingress).

### What each `--cloud` value renders

| `--cloud` | Artefacts besides `agent-workspace.yaml`, `.env` and `.gitignore` | Default runtime     |
| --------- | ----------------------------------------------------------------- | ------------------- |
| `local`   | the Compose project, copied from `templates/`                     | `docker`            |
| `aws`     | `deploy/helm/values.yaml`, layered on `values-eks.yaml`           | `kubernetes`        |
| `gcp`     | the same, plus `gcp-cloudrun.auto.tfvars.json`                    | `cloud-run-service` |
| `azure`   | `azure-container-apps.auto.tfvars.json` only                      | `aca-sessions`      |

**The chart overlay is gated on the object store, not on the cloud.** The chart serves an `s3://`
bucket and nothing else: `templates/deployments.yaml` runs with `readOnlyRootFilesystem: true` and
declares no `volumes`, so a `local-filesystem` profile would fall back to an
`AW_FILE_STORAGE_ROOT` path that does not exist and fail every file write at runtime rather than at
install time. `--cloud azure` defaults to that store, so it renders no overlay and `create` prints
which store the chart needs. Container Apps, which mounts an Azure Files share, is the target its
Terraform artefact applies to; naming an `s3://` bucket in the profile brings the AKS overlay back.

A rendered `deploy/terraform/<module>.auto.tfvars.json` is applied by copying it into
`infra/terraform/<module>/`: Terraform auto-loads `*.auto.tfvars.json` only from the directory it
runs in, and the generated `deploy/terraform/` holds no `.tf` file. The generator's `Next:` line
prints that copy and the `terraform -chdir=…` that follows it, for the artefacts it rendered.

There is no `infra/terraform` module for AWS, so `--cloud aws` renders none; an EKS cluster the
operator already runs is installed with the chart. `--cloud gcp` targets `gcp-cloudrun` rather than
`gcp-small` because the profile's own runtime default for GCP is the Cloud Run driver; an operator
who wants the single-VM topology writes `runtime.default: docker` and deploys the Compose project
`gcp-small` already carries.

### Rendered artefacts are inputs to the existing infrastructure, not a rewrite of it

No `.tf` file and no state is edited. Two chart templates are, in each case because the overlay had
nothing to render against otherwise. `templates/services.yaml` gains the ClusterIP Service for the
runner-manager, which had a Deployment and no address — without it `RUNNER_MANAGER_URL` has nothing
to name, and the alternative was rendering a blank the operator has no way to fill.
`templates/deployments.yaml` takes one image per component instead of one `images.controlPlane`
shared by three, and states each container's `PORT`; `values.yaml` and `values.schema.json` follow.
Both are the chart catching up with the release image set rather than a rewrite. The renderers
emit **only** what the operator must supply: the Helm overlay carries `images` alone, because the chart defaults
everything else and each flavour file already sets its cloud's storage class and load-balancer
annotation; the Terraform artefact carries `bootstrap_admin_email` and `images`, the two variables
those modules declare with no `default`. "No duplicated defaults" is enforced negatively —
`infra/tests/contracts.test.mjs` fails if a rendered key is not a declared `variable`, or if it
restates one the module already defaults.

### "Validated" means two things

- **Level 1, always, before any file is written.** Schema-valid, scheme allow-list, cross-field
  rules. A refusal carries the offending dotted path (`storage.objects`, `identity.bootstrapAdmin`).
  The generator renders the whole artefact set before it calls `mkdir`, so a refusal at any point
  leaves no partial project behind.
- **Level 2, only on `--validate`, and only where a credential is present.** `select 1`, a bucket
  head, and an OIDC discovery fetch, each under an `AbortSignal` that is honoured rather than
  merely passed: the relational probe owns a `pg.Pool` with `max: 1` and a
  `connectionTimeoutMillis` equal to the run's deadline and races the query against the signal,
  and the object probe owns an `S3Client` and sets `abortSignal` on every request. Calling into
  `openDatabaseRoot` / `createS3ObjectStoreProviderFromConfig` instead would have meant a
  cancellation seam in `packages/core` that nothing else needs; `pg` and `@aws-sdk/client-s3` are
  already in the tree through that package and become direct dependencies of `packages/cli` here.
  Probing unconditionally would make `create` require a network and live credentials, which
  contradicts the generator being the first-run path. A probe failure is a typed refusal naming
  the store; the driver's message is kept as the error's `cause` and never printed, because a
  PostgreSQL or S3 error routinely quotes the connection string.
- **Level 2 never writes.** Every probe is a read, so `validate` cannot change the account it was
  pointed at. The object probe heads the bucket and stops there: a 404 is a third outcome,
  `missing  objects: bucket <name> does not exist yet — the platform creates it on first boot`,
  distinct from `passed` and not a refusal, so the command still exits 0. Creating the bucket —
  the proof `ensureS3Bucket` gives when the platform itself boots — would hide the mistake this
  outcome exists to show: a typo in `storage.objects` would be provisioned rather than reported.
- **A store on a Compose service is skipped by both commands, always.** `templates/compose.yaml`
  puts `postgres` and `minio` on `control`, which is `internal: true` and publishes no host port,
  so the host cannot reach either hostname whether or not the project is up. The skip is therefore
  a property of the store and not of the caller: level 2 reports `skipped … is on the Compose
project's internal network`, naming the `docker compose exec` command that does reach it.
  Gating it on the caller instead made `create --validate` pass and `agent-workspace validate
<project>` fail forever on the very project the generator had just written. A genuine refusal —
  an unreachable managed store, a bucket the credential cannot read — still exits non-zero, and
  under `create --validate` says that the project was written first.

### The document format is a closed subset of YAML, not a YAML parser

[ADR-0089](0089-the-deployment-profile-is-read-by-a-real-yaml-parser-and-carries-apiversion-and-kind.md)
supersedes this section: the profile is now read by the `yaml` parser, with the constructs it
lists refused by line and column, and carries `apiVersion` and `kind`.

`agent-workspace.yaml` is read and written by `packages/cli/src/profile-document.ts`: a two-level
mapping of string scalars, whole-line and trailing comments, single quotes. **Every other YAML
construct is refused by line number** — tabs, other indentation, a third level, sequences, flow
collections, anchors, aliases, tags, block scalars, double quotes, duplicate keys.

This is the part of the decision that most deserves scrutiny, so the reasoning is explicit. Spec
§40 says to implement a thing yourself when it is small, and in the same breath says never to
reimplement a standard. A reader that _guessed_ at an operator's quoting or indentation could point
a deployment at the wrong bucket or the wrong issuer — precisely the failure this unit exists to
prevent — so guessing is not available. A reader that _refuses_ everything outside a documented
grammar cannot mis-parse; its worst case is rejecting a valid-but-exotic file, which is an
inconvenience an error message resolves. The subset is therefore closed by construction rather than
partial by accident, and `profile-document.test.ts` pins one refusal per construct.

## Alternatives rejected

- **`zod` and a YAML library as new dependencies of `packages/cli`.** This was the plan's first
  choice and remains the better long-term shape: Zod is this repository's default for a structured
  contract, and `yaml@2.9.0` is already resolved in the tree. It is not taken here because it is a
  larger change than the profile needs, not because dependencies are closed to this package — the
  cancellation seam above adds `pg` and `@aws-sdk/client-s3`, both already in the tree through
  `@agent-workspace/core`. The hand-written validator is a declarative field
  walk of comparable size that produces better dotted paths for this schema than Zod's default
  issue formatting, and the document reader is a closed subset rather than a general parser — but
  the exit is real and cheap: replace `validateProfile` with a `.strict()` Zod schema and
  `parseProfileDocumentText` with `yaml.parse`, keeping `ProfileError` and the refusal messages.
  Neither is part of this package's published surface.
- **Putting the schema in `packages/contracts`.** The profile never crosses `/api/**`. That package
  is the public wire contract, and adding a deployment document to it would publish a type that is
  not a wire type.
- **`agent-workspace.json`.** The issue, the roadmap, and three fences on the documentation site
  all name `agent-workspace.yaml`.
- **Teaching the Terraform modules to read the profile directly.** A large blast radius on live
  deployments for no gain, and it would duplicate the schema in HCL.
- **Accepting `gcs://`, `azblob://` and the cloud key services and refusing only at render time.**
  A profile that validates and then cannot be deployed is a worse error than one refused where it
  is written, and the acceptance criterion asks for a refusal before any file exists.

## Consequences

- An operator states placement once and the installer renders it; the three artefact kinds cannot
  disagree with each other, because they are functions of the same document.
- The env-var mapping has one home and a test holding it against `.env.example`.
- A generated cloud project starts from `admin@localhost.test` as its bootstrap administrator, as
  every generated project does today. The profile is the file an operator edits to change it; the
  generator gained no flag for it, because the issue's CLI surface is `--cloud` and `--validate`.
- The profile carries no region field, so a deployment outside `us-east-1` edits `AWS_REGION` in
  the rendered `.env` (the Terraform modules have their own `region` variable and default). Adding
  `storage.region` is a small, additive change if review wants it.
- The chart and the release image set now agree. `values.yaml` takes one image per component —
  `images.web`, `images.gateway`, `images.runnerManager`, `images.runtime` — and each Deployment
  runs its own, so the single `images.controlPlane` reference and the `AW_COMPONENT` env that
  selected a process out of it are gone. Nothing implemented that selector: each image already has
  its own entrypoint, and `infra/release/build-and-push.sh` publishes all four separately.
  `images.runnerManager` takes the `runner` reference, because the runner manager is the root
  `Dockerfile`'s `runner` target. The rendered overlay pins all four by digest, and
  `infra/tests/contracts.test.mjs` holds the three files against each other: every image a
  Deployment names must be defaulted by `values.yaml` and pinned by the overlay.
- **The chart now translates the object-store credential.** The rendered `.env` names it
  `OBJECT_STORAGE_ACCESS_KEY_ID` / `OBJECT_STORAGE_SECRET_ACCESS_KEY`, which is the inventory
  `.env.example` documents, while `apps/web/server/composition/storage.ts` builds its S3 client
  from `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. `packages/cli/templates/compose.yaml` and
  `infra/terraform/gcp-cloudrun/main.tf` already performed that translation; the chart did not, so
  it does it too — each Deployment sets the two `AWS_*` names from the object-store Secret's
  `OBJECT_STORAGE_*` keys with `valueFrom.secretKeyRef` and `optional: true`. Keeping the profile's
  own names canonical is what makes the rendered file, `docs/deploy/kubernetes.md` and
  `.env.example` agree; `optional: true` is what keeps an IAM or workload-identity install, which
  supplies neither key, starting. `infra/tests/contracts.test.mjs` holds the mapping against the
  key set the renderer emits.
- **A cloud whose object store the chart cannot serve gets no chart overlay, and a stated gap.**
  `--cloud azure` therefore ships its Terraform artefact alone. The combination this unit does not
  deliver is Agent Workspace on AKS with Azure-native object storage: that needs either an `s3://`
  bucket named in the profile (supported today, and the generator says so) or native Blob support,
  which is unit 16 (#248, D-2). The chart is not taught to mount a volume here — that would be a
  storage decision for every distribution it serves, on a chart whose read-only root filesystem is
  a deliberate control — so the generator withholds the artefact rather than rendering one that
  installs and then fails at the first file write.
- **A refused command prints its own message and nothing beneath it.** The `cause` a
  `ProbeRefusedError` carries is only kept out of the operator's log if something catches it:
  `packages/cli/src/cli-failure.ts` is the one place either binary turns a refusal into process
  output, and both entry points route through it and exit 1. Without it Node's default handler
  printed the whole chain for a rejected top-level `await`, which is precisely how a connection
  string reaches the CI logs of the pipelines these deploy guides describe. Catching was not
  sufficient on its own: `embedded-postgres` depends on `async-exit-hook`, which on import
  registers a `beforeExit` listener that calls `process.exit(0)`, and `index.ts` re-exports
  `startWorkspace` — so the whole `agent-workspace` binary could not leave a non-zero exit code
  behind. `embedded-db.ts` now imports `embedded-postgres` inside `startEmbeddedDatabase`, so the
  hook is installed for the command that starts a database and for no other.
- `packages/cli` declares `pg` and `@aws-sdk/client-s3` directly, so `pnpm-lock.yaml` records two
  new importer entries and no new resolution: both versions are the ones `@agent-workspace/core`
  already pins.
- The chart's default-deny NetworkPolicy still allows only runner-manager → gateway egress. It
  predates the new Service and equally blocks the web → gateway path the generator has always
  rendered for Compose, so it is recorded here rather than widened by this unit.
- Adopting a Zod schema or a YAML library later is a contained change behind two functions.
