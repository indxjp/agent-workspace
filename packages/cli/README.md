# Agent Workspace CLI

`@indx-workspace/cli` on npm, released in lock-step with `@indx-workspace/contracts`, `sdk`, `aw`
and `create` (ADR-0082). `npm create @indx-workspace@latest <directory>` runs its generator through
`@indx-workspace/create`; `npx -p @indx-workspace/cli agent-workspace --help` prints the operator
usage. The package exposes two commands:

- `create-agent-workspace <directory> [--yes]` writes the v2 project `aw dev` runs (S1-16). See
  [Creating a project](#creating-a-project).
- `create-agent-workspace <directory> --cloud aws|gcp|azure|local [--validate]` writes the
  deployment profile and renders every artefact from it. It resolves every release and third-party
  image tag to an immutable registry digest before writing the project, so generation fails when
  artifacts cannot be verified.
- `agent-workspace start` validates those digests and starts the generated Compose topology, then
  waits for the web URL to answer and exits non-zero, naming the URL, when it does not. It prints
  the configured and effective runtime after Compose is healthy.
- `agent-workspace stop [--volumes]` takes the generated Compose project down, with the runtime
  sandboxes its runner started, and fails unless nothing of the project is left. See
  [Stopping a project](#stopping-a-project).
- `agent-workspace start --embedded` is refused. The development-only process-local mode imports
  the server itself, which is not published, so it runs from a clone of the repository:
  `pnpm start:embedded` at its root (`packages/embedded`).
- `agent-workspace validate [directory]` re-checks `agent-workspace.yaml` and probes the stores it
  names.
- `agent-workspace render [directory] [--check] [--upgrade]` re-renders `deploy/`, `compose.yaml` and the image
  lines of `.env` from an edited `agent-workspace.yaml`; `--check` exits non-zero on drift and
  writes nothing. See [Re-rendering a project](#re-rendering-a-project).
- `agent-workspace deploy [directory] [--yes] [--target helm|terraform] [--infra <dir>]` renders,
  prints the plan of the real tool for the profile's target (Docker Compose, Helm or Terraform),
  and applies it only with `--yes`. See [Deploying a project](#deploying-a-project).
- `agent-workspace doctor [directory] [--json]` reports, in one run, whether the project can start:
  the profile, its stores, the tools its target needs on `PATH`, and the server's contracts
  version. See [Doctor](#doctor).
- `agent-workspace --version` prints the CLI version and the contracts version it was built
  against, the way `aw --version` does.

## Creating a project

Without `--cloud`, `npm create @indx-workspace <directory>` writes a new directory holding the v2
project `aw dev` runs: `package.json` (exact pins of `@indx-workspace/aw`,
`@indx-workspace/embedded` and `@indx-workspace/sdk` at this CLI's version, and a `dev` script
running `aw dev`), `pnpm-workspace.yaml`, `.gitignore`, `agent-workspace.yaml` (`kind: Project`),
`agents/<agentName>.ts` and `surfaces/main.ts`. The last three are the files `aw init` writes,
rendered from the same setup answers.

- Without a directory, create asks `Project name` first (typed; Enter takes `my-agent`; a name that
  exists or is not a valid name is refused and asked again). With no terminal it uses `my-agent`
  and says so on stderr.
- On a terminal, create asks the setup questions in order, showing each one's choices or
  grammar and its recommended answer; an empty line takes the recommendation, and an answer that
  does not fit is asked again. It then lists the files and asks `Write these 6 files into
  <directory>?` as a Yes/No menu (Yes is the default); a No writes nothing.
- After writing, on a terminal, it asks `Install dependencies now?` and then `Start it now?`
  (Yes is the default for both). The install runs the package manager that ran `npm create`
  (`npm_config_user_agent`: npm, pnpm, yarn or bun) in the project directory, and starting runs
  `<manager> run dev` there, which is `aw dev`. `--install` / `--no-install` and
  `--start` / `--no-start` answer the questions (`--start` implies `--install`). Starting keeps
  `aw dev` in the foreground until Ctrl-C, and create then exits with `aw dev`'s exit code.
- `--yes` takes every recommended answer, writes without asking and installs the dependencies; it
  never starts the dev server, so a coding agent or CI does not block. npm reads a `--yes` of its
  own, so pass it after `--`: `npm create @indx-workspace <directory> -- --yes`.
- When no person is at a terminal (stdin or stdout is not a TTY, or `CI` is set) and `--yes` is not
  given, create takes the recommended answers (and your flags) and says so on stderr:
  `no terminal: used the recommended answers (to choose others, pass flags or --answers <file>;
  see --help)`. It installs or starts only when `--install` or `--start` is given. It never reads
  answers from stdin.
- Exit codes: 0 when the project was written and everything create ran succeeded; 2 for a usage
  error (an unknown flag, a value a flag does not accept); 1 for any other refusal and for a
  failed install; 130 for Ctrl-C at any question; with `--start`, the exit code of `aw dev`.
- `--answers <file>` (YAML or JSON) answers the setup questions from a file; flags win over it.
  A provider that needs an endpoint without `--model-base-url` exits 2 with
  `fix: add --model-base-url <url>` and writes nothing.
- What was not done is printed as `Next steps:` in order: `cd`, the install, the model key
  (`export NAME=<your key>`, or on Windows both a PowerShell and a cmd line), then
  `<manager> run dev`.
- Each setup question has a flag that answers it: `--provider`, `--agent`, `--color` and the rest;
  `create --help` lists them all with their format and default. A flag's value is checked like the
  interview's answer, and a question a flag answered is not asked again.
- An existing directory is refused, and no file is ever overwritten. No `.env` is written and no
  secret is generated: `aw dev` reads `ANTHROPIC_API_KEY` from its environment and never writes it
  to a file.
- It ends with what to run next (`Next steps:` then `cd <directory>`, `npm install`, `npm run dev`,
  and an `export` line when the provider key is not set), then
  `to share a workspace later: aw login --url <url> (reads workspaces; pushing with it is not supported yet)`.

`--cloud local|aws|gcp|azure` writes the deployment project instead, as before: the Compose
project for `local` (whose four answers are `--database`, `--storage`, `--runtime` and `--auth`,
or the defaults with `--yes`; `--port <n>` publishes its web service on that host port instead of
3000), or the profile and the Helm and Terraform artefacts for a cloud. `--yes`, `--answers` and
`--port` are refused with a cloud other than `local`, and `--validate` without one.

`render`, `validate`, `deploy` and `doctor` read a deployment profile. Until P-2 they refuse a v2
project's `agent-workspace.yaml` by name, at the line and column of its `kind` key:

```text
kind: Project is read by aw dev; render and deploy arrive with P-2
```

## The deployment profile

`agent-workspace.yaml` states where one deployment keeps its state, bytes, secrets, sandboxes and
identity. It is the only place those five decisions are written down, and every other artefact is
rendered from it — nothing is configured twice.

```yaml title="illustrative" claim="illustrative"
apiVersion: agentworkspace.dev/v1
kind: Deployment
cloud: gcp
storage:
  relational: cloud-sql # a postgres:// URL, or that cloud's store by name
  # rds | cloud-sql | azure-postgres, or compose-postgres on cloud: local. A name keeps the
  # connection string — a credential — out of the file, in .env where the deployment reads it.
  objects: s3://acme-ai-files # s3://, GCP's gcs://, Azure's azblob://, or local-filesystem
  secrets: local-key # AWS also accepts kms, GCP secret-manager, and Azure key-vault
runtime:
  default: cloud-run-service
identity:
  oidc: https://accounts.google.com # optional
  bootstrapAdmin: ops@acme.example
```

The file is read by a YAML 1.2 parser (the core schema), so any valid YAML spelling of these fields
works. Some valid YAML is still refused, because a reader could take it more than one way: anchors
and aliases, tags other than the core schema's (`!!str`, `!!int` and so on), `%TAG` and `%YAML`
directives, duplicate keys, and a second document. Every refusal, including an unknown or
misspelt field, names the line and the column, as in
`agent-workspace.yaml line 6, column 3: storage.kms is not a field of the deployment profile; …`.

`apiVersion` and `kind` say which format the file is in; this release reads
`agentworkspace.dev/v1` and `Deployment` and refuses any other value. A profile written before they
existed is still read as v1 for one minor release: `agent-workspace validate` accepts it and prints
a warning on stderr naming the two lines to add at the top of the file. A later release will refuse
it.

### Editor validation and completion

A generated profile starts with a line that points the
[YAML extension for VS Code](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml),
and any other editor that uses `yaml-language-server`, at the profile's JSON Schema:

```yaml title="illustrative" claim="illustrative"
# yaml-language-server: $schema=https://unpkg.com/@indx-workspace/cli@<version>/schema/agent-workspace.schema.json
```

With the extension installed, the editor completes each block's keys and the values the profile's
`cloud` accepts, and underlines an unknown key, a cross-cloud store or an unbuilt runtime driver as
you type. This package ships the schema as `schema/agent-workspace.schema.json`, and the URL names
that file on unpkg for the CLI release that wrote the profile, so it does not change under a
committed profile; for a profile written by an earlier release, add the line with the version of
the CLI you run.

0.2.1 was published before the package shipped the schema, so the URL a 0.2.1 profile names does
not resolve and the editor silently stops validating; it resolves from the first release after
0.2.1. To validate without the network, point the first line at the installed copy:

```yaml title="illustrative" claim="illustrative"
# yaml-language-server: $schema=./node_modules/@indx-workspace/cli/schema/agent-workspace.schema.json
```

The schema is generated from the same Zod definition `validate` checks with
(`src/profile-schema.ts`), into this package's `schema/`.
`validate` stays the authority: it also checks that a `postgres://` connection string and the OIDC
issuer parse as URLs, which JSON Schema cannot express. The decision and the URL are recorded in
ADR-0091.

What `--cloud` writes:

| `--cloud` | Rendered, besides `agent-workspace.yaml`, `.env` and `.gitignore` | Default runtime     |
| --------- | ----------------------------------------------------------------- | ------------------- |
| `local`   | the Compose project                                               | `docker`            |
| `aws`     | `deploy/helm/values.yaml` (layered on `values-eks`)               | `kubernetes`        |
| `gcp`     | the same, plus `deploy/terraform/gcp-cloudrun.auto.tfvars.json`   | `cloud-run-service` |
| `azure`   | `deploy/terraform/azure-container-apps.auto.tfvars.json` only     | `aca-sessions`      |

The `local` Compose project is named after its directory: `.env` sets `COMPOSE_PROJECT_NAME` to
the directory name lowercased, with every character Compose does not accept replaced by `-`, and
the project's runtime-control and provider-egress networks take that name as their prefix. Two
generated projects, or one beside the repository's own development stack, therefore never adopt or
remove each other's containers. Two directories with the same name (in different parents) get the
same project name: set `COMPOSE_PROJECT_NAME` in one project's `.env` to run two projects of the
same name side by side. `PORT` in `.env` is the host address and port the web service is
published on (`127.0.0.1:3000` by default, so only this machine reaches it): change the port when it
is taken or to run a second project beside the first, and write the port alone (`PORT=3000`) to
publish on every interface, which a remote Docker daemon needs. `agent-workspace start` answers on `http://127.0.0.1:<PORT>`, or on the host a `tcp://` or
`ssh://` Docker endpoint names: `DOCKER_HOST` from the shell or `.env`, else the current
`docker context`. It fails when the URL does not answer, or when something other than this
project's web service answers on it (another process holding the port). Before it pulls or starts
anything, `start` checks that `PORT` is free: it asks the daemon which containers publish it (a
container of this project is the project already running, and is fine), and on a local daemon it
also binds the port on this machine. A taken port stops the start with nothing started, saying to
free the port or change `PORT`. A process outside Docker on a remote daemon's host is found only
when Docker cannot bind `PORT` there: `start` then stops the services Compose had already started
with `docker compose down` (the data volumes are kept) and gives the same advice. The web service
is the only one on a non-internal network, which also gives it outbound access.

The runner reaches the daemon through its mounted `/var/run/docker.sock` and joins the socket's
group, `DOCKER_GID`. The generator writes this machine's value (0 outside Linux); `start` asks the
daemon it talks to, with a short-lived container of the pinned PostgreSQL image, and uses the
daemon's answer for that start when it differs, printing the value to record in `.env`. That is
what makes a remote, VM or docker-in-docker daemon work. If the daemon cannot answer and the runner
is denied the socket, `start` fails, naming `DOCKER_GID`. The session cookie is `Secure`, which
browsers keep only over HTTPS or on localhost: for a web URL on a remote Docker host, `start` names
an SSH port forward to `localhost`, or serve the project over HTTPS.

Browsers share cookies across ports, so the generated project passes `COMPOSE_PROJECT_NAME` to the
web service as `AW_INSTANCE_ID`, and its sign-in cookie is `__Host-aw_session_<project>`: two
projects on `localhost:3000` and `localhost:3002` in one browser keep separate sessions. A
deployment without `AW_INSTANCE_ID` keeps the name `__Host-aw_session`.

### Re-rendering a project

Edit `agent-workspace.yaml`, then run `agent-workspace render` in the project directory (or
`agent-workspace render <directory>`). It reads the profile with the same reader as `validate`, so
a refused profile names its line, and then nothing is written. It re-renders, with the renderers
`create-agent-workspace` uses, the files it owns:

- `deploy/helm/values.yaml` and `deploy/terraform/<module>.auto.tfvars.json`, where the profile has
  that target;
- `compose.yaml`, for `cloud: local`, restored to the template the generator copies;
- the image lines of `.env`: `WEB_IMAGE`, `GATEWAY_IMAGE`, `RUNNER_IMAGE`,
  `AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK`, and for `local` `POSTGRES_IMAGE` and
  `SEAWEEDFS_IMAGE`.

Every other line of `.env` (the secrets, the profile-derived settings, and anything you added) keeps
its value, its place and its line ending; a missing image line is added after the others. Each owned
file is listed as `created`, `updated` or `unchanged`, by path only: no value from `.env` is ever
printed, and a malformed `.env` line is refused by its number. A second run with the same profile
changes nothing. `render` never deletes a file, including one an earlier profile rendered (a
`deploy/terraform/` file for the previous cloud, say), and never writes a file it does not own.
What it leaves in place is listed under `Left in place`, by path or `.env` key name only: a
`compose.yaml` or `deploy/` file the current profile no longer renders, an image key it no longer
writes (`POSTGRES_IMAGE` and `SEAWEEDFS_IMAGE` off `local`), and the image keys of an older
generator (`RUNTIME_IMAGE`, `MINIO_IMAGE`). Remove them yourself once nothing uses them; the list
does not change the exit code of `--check`.

`.env` lines are read as Compose reads them: `export WEB_IMAGE=…` is the key `WEB_IMAGE`, and in an
unquoted value a `#` after whitespace starts a comment. An image line is rewritten in place and
keeps its `export` and its comment.

Each changed file is written to a temporary file next to it, flushed to disk and renamed over the
old one, so a crash cannot leave `.env` half-written; the new file keeps the old one's mode. A
replaced file is a new file, so a hard link to it no longer follows it and it is owned by whoever
ran `render`. `render` writes only regular files inside the project: if an owned path, or a
directory on the way to it (`deploy`, `deploy/helm`), is a symbolic link, it refuses before writing
anything.

Each image is taken from an `AW_<NAME>_IMAGE` override when one is set, else from the digest the
project's `.env` already pins, else from this CLI's release default. So a plain `render` is
offline and never upgrades an image; `AW_WEB_IMAGE=…@sha256:… agent-workspace render` is how a
patched image is picked up. A missing `.env` is refused: `render` never generates secrets.

`agent-workspace render --upgrade` is how a project follows the CLI to a new release: after
installing the new `@indx-workspace/cli`, it resolves the web, gateway, runner and runtime images
of this CLI's release to digests (a registry lookup, like `create`), writes them over the pins in
`.env`, and prints each move as `KEY: old -> new`. The PostgreSQL and SeaweedFS pins stay, since a
new major of either is a data migration. An `AW_<NAME>_IMAGE` override still wins. Add `--check` to
see the moves without writing, then `agent-workspace start` to run the new images.

`agent-workspace render --check` lists what would change (`would create`, `would update`) and exits
1 when anything would, writing nothing — run it in CI to fail a pull request whose generated files
were not re-rendered.

`render` rewrites only the image keys of `.env`. A profile edit that changes another `.env` value —
`storage.objects` (the `OBJECT_STORAGE_*` keys), `identity.bootstrapAdmin` (`BOOTSTRAP_ADMIN`), the
runtime or the secret backend — still needs that line edited by hand (ADR-0090).

### Deploying a project

`agent-workspace deploy` takes an edited profile to the running deployment (ADR-0094). It runs
`render` first, in-process, so a refused profile is reported with its line and no tool runs. It
then drives the real tool for the profile's target, prints that tool's plan, and changes the
deployment only with `--yes`:

| `cloud`                                    | Target                                             | Plan                                                                                                    | `--yes`                                              |
| ------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `local`                                    | Docker Compose                                     | `docker compose config --quiet`, then each service as `create`, `recreate`, `start` or `unchanged`      | `docker compose up --detach`                         |
| `gcp`, `azure`                             | Terraform (`gcp-cloudrun`, `azure-container-apps`) | `terraform plan -detailed-exitcode -var-file=<rendered tfvars> -out=<temporary plan file>`              | `terraform apply <that plan file>`                   |
| `aws`; `gcp`, `azure` with `--target helm` | the chart `infra/helm/agent-workspace`             | `helm diff upgrade` with the helm-diff plugin, else `helm template` and a `Kind/name` list of resources | `helm upgrade --install … --create-namespace --wait` |

- **Exit codes.** Without `--yes` nothing is deployed: `deploy` exits 0 when the deployment
  matches the profile and 2 when there are changes, as `terraform plan -detailed-exitcode` does. A
  refusal exits 1. Without helm-diff the cluster cannot be compared, so a chart plan always counts
  as a change.
- **Apply what was printed.** For Terraform, `--yes` applies the plan file the printed plan
  wrote, never a second plan. The file holds variable values in plain text, so it lives in a
  `0700` temporary directory and is removed when the command ends, including on Ctrl-C or
  `SIGTERM`.
- **`--infra <dir>`.** The Terraform modules and the chart are not part of a generated project.
  A cloud target needs `--infra` naming the `infra/` directory of a checkout of this repository;
  `local` does not. Terraform runs as `terraform -chdir=<infra>/terraform/<module>` with the
  rendered `deploy/terraform/<module>.auto.tfvars.json` passed as `-var-file`, so nothing has to be
  copied into the module. Run `terraform -chdir=<infra>/terraform/<module> init` with your backend
  once first; `deploy` refuses an uninitialised module rather than configure a backend for you.
  Helm installs the release `agent-workspace` in the namespace `agent-workspace`, with the cloud's
  flavour file and the rendered `deploy/helm/values.yaml`, as [the deploy guide](https://docs.agentworkspace.indx.jp/guides/deploy) does,
  and creates that namespace on the first install.
- **The Compose project.** Every `docker compose` call runs for the `COMPOSE_PROJECT_NAME` in the
  project's `.env`, even when your shell sets another one.
- **`--target`.** `gcp` and `azure` deploy with Terraform by default; `--target helm` selects the
  chart. A target the profile has no artefact for (`--target terraform` on `aws`, `--target helm`
  on an Azure profile with an `azblob://` store) is refused by name.
- **What is printed.** Every tool runs without a shell, with its arguments as an array, in the
  project directory. Each command line is echoed, and everything a tool prints passes through a
  redactor first: it masks every `.env` value except the public settings the generator writes
  (image references, the project name, bucket, region and service addresses) and the password of
  any `scheme://user:password@` URL. `docker compose config` itself is never printed, because it
  interpolates `.env`. `render`'s own report passes through the same redactor. A missing tool
  fails with advice to run `agent-workspace doctor`.

`deploy` writes the files `render` owns before it plans, because Terraform and Helm read them from
disk; that is the only thing it changes without `--yes`. So even a plan-only `deploy` rewrites
`deploy/`, `compose.yaml` (`local`) and the image lines of `.env` to match the profile. Run
`agent-workspace render --check` first to see what that would change without writing anything.

**From a v2 project.** `@indx-workspace/cli/deploy` exports `deployProjectEnvironment`, which
`aw deploy production` loads (ADR-0103, #621). It bridges the project's `environments.production`
to a profile with `projectToDeploymentProfile`, keeps that profile's deployment at
`~/.config/agent-workspace/deployments/<project>/production/` (created `0700` with a `0600`
`.env` on the first run, never regenerated), and runs this `deploy` over it. `single-vm` deploys
with Compose; `gcp-cloudrun` deploys with Terraform and needs
`infraDirectory`. [the deploy guide](https://docs.agentworkspace.indx.jp/guides/deploy) lists the prerequisites each target refuses by name.

### Stopping a project

Run `pnpm stop` (`agent-workspace stop`) in the project directory. It runs
`docker compose down --remove-orphans`, then removes what Compose does not know about: the runtime
sandboxes the runner started through the Docker socket, and the project's networks. A sandbox is a
container labelled `agent-workspace.runtime=docker` and either `agent-workspace.compose-project=<project>`
or attached to `<project>-runtime-control` (sandboxes from 0.1.2 and earlier carry no project
label); nothing else is removed. A sandbox's anonymous workspace volume goes with it, as when the
runner ends a session. The project's named volumes (the database, the object store, the files) are
kept; `pnpm stop --volumes` removes them too. The command exits non-zero, naming each container
or network still there, unless the project is gone.

The runner also removes its own sandboxes when it is stopped (`SIGTERM`, within the 30-second stop
grace period the template gives it), so a plain `docker compose down` normally leaves nothing
either. `agent-workspace stop` is what catches a runner that was killed, or sandboxes an older
release left.

Every cloud renders the `.gitignore`, which excludes `.env`: that file is where the generated
administrator password and every store credential live, and the profile beside it is the one the
deploy guides tell you to read, edit and commit.

`agent-workspace deploy --infra <checkout>/infra` applies a rendered
`deploy/terraform/<module>.auto.tfvars.json` where it lies (see
[Deploying a project](#deploying-a-project)). To run Terraform yourself, copy it into
`infra/terraform/<module>/` and run Terraform there — that file is auto-loaded only from the
directory Terraform runs in, and the generated `deploy/terraform/` holds no `.tf` file of its own:

```sh title="illustrative" claim="illustrative"
cp acme-ai/deploy/terraform/gcp-cloudrun.auto.tfvars.json infra/terraform/gcp-cloudrun/
terraform -chdir=infra/terraform/gcp-cloudrun apply
```

The same copy applies to `azure-container-apps`. The
generator's own `Next:` line prints these steps for the artefacts it actually rendered.

There is no Terraform module for AWS; an EKS cluster you already run is installed with the chart.
And `--cloud azure` renders no chart overlay: its default `storage.objects` is an `azblob://`
container, while the chart wires only the S3 environment contract. Container Apps supplies the
Blob endpoint, managed identity and container. Name an `s3://` bucket in `agent-workspace.yaml` to
deploy an Azure profile with the chart; the command says so when it withholds the overlay.

"Validated" means two things. **Always**, before any file is written: the document is schema-valid,
every URL scheme is one this release serves, and the cross-field rules hold — a refusal names the
offending dotted path. **With `--validate`**, and only for a store whose credential is present: a
connectivity probe (`select 1`, a bucket head, an OIDC discovery fetch). A failed probe names the
store and never prints the driver's own message, which routinely quotes a connection string.

Validation never writes. A bucket that is not there yet is reported as its own outcome —
`missing  objects: bucket <name> does not exist yet — the platform creates it on first boot` —
rather than created: the platform creates it when it first boots, and a bucket the command created
itself would hide the mistake this outcome exists to show, a typo in `storage.objects`. It is not
a refusal, so the command still exits 0.

AWS profiles accept `s3://` with `kms`; GCP profiles accept `gcs://` with `secret-manager`;
Azure profiles accept `azblob://` with `key-vault`. Cross-cloud use is refused rather than
accepted-and-ignored. See
ADR-0055.

## Doctor

`agent-workspace doctor [directory] [--json]` runs four checks and prints one line for each result,
`pass`, `warn` or `fail`, with one line of advice under every warning and failure. It fixes
nothing.

| Check           | Pass                                        | Warn                                                                               | Fail                                                 |
| --------------- | ------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `profile`       | `agent-workspace.yaml` validates            | it has no `apiVersion`                                                             | it is missing or refused; the refusal names the line |
| `stores`        | the store answered the `validate` probe     | the store was not probed, or its bucket is not created yet                         | the store did not answer, or `.env` is malformed     |
| `prerequisites` | the tool is on `PATH`; its version is shown | an optional tool is missing, or a tool printed no version                          | a tool the target needs is missing                   |
| `version-skew`  | the server serves this CLI's contracts      | `AGENT_WORKSPACE_URL` is unset, the server is unreachable, or it states no version | the server is outside the range this CLI supports    |

A store is not probed when `.env` holds no credential for it, or when it is on the Compose
project's internal network; the detail says how to check it. A bucket the platform creates on
first boot is a warning until it exists. The store probes are the ones `validate` runs, and they
stop at the first store that does not answer: that store fails and the others are reported as not
checked. The version check is the one `validate` and `start` run (ADR-0078). When the profile is
refused, the store and tool checks are reported as not checked; the version check still runs.

The tools checked depend on the profile:

| Profile                                     | Tools                                                                               |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `cloud: local`                              | `docker` and Docker Compose v2                                                      |
| `cloud: aws` (the chart)                    | `kubectl` and `helm`                                                                |
| `cloud: gcp`, `cloud: azure` (Terraform)    | `terraform`; with a `gcs://` or `s3://` bucket, also `kubectl` and `helm`, optional |
| `runtime.default: sandbox-runtime` on Linux | `bwrap` (bubblewrap)                                                                |
| `runtime.default: docker` / `kubernetes`    | `docker` / `kubectl`                                                                |

A tool the profile does not need is neither run nor reported. Each tool is run once with its
version flag (`terraform version`, `docker compose version --short`, …); only the version number
is printed, never the tool's own output. A missing required tool fails with the address of its
install page.

The command exits 1 when any check fails and 0 when there are only warnings. The report is written
in full first; a failure then adds `agent-workspace doctor: N check(s) failed` on stderr.
`--json` writes the same results to stdout as one object, for a pipeline to read:

```json title="illustrative" claim="illustrative"
{
  "ok": false,
  "checks": [
    {
      "check": "prerequisites",
      "subject": "terraform",
      "status": "fail",
      "detail": "terraform could not be run (not on PATH, or it did not answer); it is needed to apply the gcp module",
      "advice": "Install Terraform: https://developer.hashicorp.com/terraform/install"
    }
  ]
}
```

No secret is printed, in either form. The userinfo of every URL is shown as `***`, and so is any
value from the profile, `.env` or the environment that is a URL password or belongs to a variable
named like a credential (`…PASSWORD`, `…SECRET`, `…TOKEN`, `…KEY`).

## Version skew

`agent-workspace start` and `agent-workspace validate` refuse a server whose contracts version this
CLI cannot operate. The check is one unauthenticated `GET /api/me`; a `401` is fine, because only the
`x-agent-workspace-contracts` and `x-agent-workspace-contracts-minimum` headers matter (ADR-0078).

- `start` checks once the server answers; a web URL that does not answer within two minutes is a
  failed start. A refused Compose deployment is **left running**: Compose started it and answered
  healthy before the check, and the CLI does not tear down what an operator may be about to
  inspect. `agent-workspace stop` in the project stops it. `validate` checks when
  `AGENT_WORKSPACE_URL` is set, in the shell or the project `.env`; without it `validate` stays
  offline.
- Outside the served range the command exits non-zero. The message names the CLI's contracts
  version, the range the server serves, which side to upgrade, and the fix: when the CLI is older,
  `Upgrade the CLI: npm install --global @indx-workspace/cli@<server minor>`; when the server is
  older, upgrade the server (a Compose project: `agent-workspace render --upgrade`, then
  `agent-workspace start`), `or downgrade the CLI: npm install --global
@indx-workspace/cli@<server minor>`.
- `validate` bounds the check by the same `timeoutMs` as its store probes.
- An answer without the headers, or an unreachable server: `validate` warns on stderr and
  proceeds, because ADR-0078 accepts a missing header. `start` fails in both cases. No headers
  means another process is holding the port: stop it or set `PORT` in `.env`. Unreachable means
  the start failed: check `docker compose logs web`.
- In range: no change in behaviour or output.

The package is `@indx-workspace/cli` (`CLI_PUBLISHED_PACKAGE`, pinned to this manifest's name by a
test). The `@agent-workspace` scope on npm belongs to a third party, so nothing published names it.
A `local` project depends on exactly `@indx-workspace/cli` at the generator's own version (the
generator writes that dependency; the template's specifier is a placeholder), so `pnpm install`
inside it keeps the executable available after the ephemeral generator exits. A
`--cloud aws|gcp|azure` project deploys through Helm or Terraform and ships no `package.json`, so
its operator runs `npx -p @indx-workspace/cli agent-workspace validate acme-ai` instead. Do not
redirect users to the unscoped `create-agent-workspace` package name, which is not ours.

Release engineering can override source tags with `AW_WEB_IMAGE`, `AW_GATEWAY_IMAGE`,
`AW_RUNNER_IMAGE`, `AW_RUNTIME_IMAGE`, `AW_POSTGRES_IMAGE`, and `AW_SEAWEEDFS_IMAGE`. Overrides must
already be digest references. Mutable tags never reach the generated `.env` file.
`AW_RUNTIME_IMAGE` is the `claude-agent-sdk` engine's runtime image; the generated `.env` pins it
as `AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK` (ADR-0073). The MinIO-era
`AW_MINIO_IMAGE` is refused by name rather than ignored: the bundled object store is SeaweedFS
(ADR-0067).

### Picking up patched images in an existing project

Platform images 0.1.2 patch the next/og remote code execution (GHSA-vcvr-r3jv-pc5j) and
@grpc/grpc-js CVE-2026-101916; projects generated with CLI 0.1.0 to 0.1.2 pin the vulnerable 0.1.0
or 0.1.1 images. Regenerate projects generated with CLI 0.1.0: their `compose.yaml` predates the
fixes in #379, so editing the image pins is not enough. The generator refuses an existing directory
and mints new secrets, so it cannot be re-run in place. Three ways work today:

- Generate a new project with `@indx-workspace/create@0.1.3` (or later) and move your data and
  settings across.
- Edit the existing project's `.env`: replace the digest in `WEB_IMAGE`, `GATEWAY_IMAGE`,
  `RUNNER_IMAGE` and `AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK` with the digest of
  `ghcr.io/indxdev/agent-workspace/<name>:0.1.2` (`web`, `gateway`, `runner`,
  `runtime-claude-agent-sdk`), for example from `docker buildx imagetools inspect`. Keep each value a
  digest reference (`...@sha256:...`); the Compose file refuses a tag. Then run
  `agent-workspace start` again.
- With CLI 0.2.1 or later in the project, run
  `AW_WEB_IMAGE=… AW_GATEWAY_IMAGE=… AW_RUNNER_IMAGE=… AW_RUNTIME_IMAGE=… agent-workspace render`
  with those digest references, which rewrites the same four lines of `.env` (and the rendered
  `deploy/` files) and nothing else. See [Re-rendering a project](#re-rendering-a-project).
