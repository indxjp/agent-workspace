# ADR-0094 — `agent-workspace deploy` wraps Compose, Helm and Terraform, plan first

Status: accepted — extends [ADR-0090](0090-agent-workspace-render-owns-deploy-compose-and-the-env-image-keys.md) (`render`) and [ADR-0055](0055-the-deployment-profile-is-one-validated-document-the-installer-renders.md) (artefacts are rendered from the profile)
Date: 2026-10-01
Decided by: the implementer of issue #430 (developer-platform slice 1c, #333)
Scope: `packages/cli/src/deploy/`, `packages/cli/src/index.ts`

## Context

After ADR-0090, `agent-workspace render` brings a generated project's files in line with an edited
`agent-workspace.yaml`. The operator still had to apply those files with the right tool, flags and
files for their cloud: `docker compose up`, `helm upgrade --install` with two values files, or a
copy of the Terraform variables into the module followed by `terraform apply`. Issue #430 adds
`agent-workspace deploy [dir]`, which goes from the profile to the running deployment. It must
show the plan before it changes anything, never print a secret, and stay testable without real
tools.

## Decision

### Render, then plan, then apply only with `--yes`

`deploy` calls `runRenderCommand` in-process first. A refused profile is reported with its line
and column, and no tool runs. `render` writes its owned files even without `--yes`: they are
deterministic, Terraform and Helm read them from disk, and they are what the operator commits.
"Without `--yes` nothing changes" applies to the deployment: no `up`, `upgrade` or `apply` runs.

### Target dispatch

The target is read from the renderers `render` uses, not restated:

| Profile                                         | Target    | Plan                                                                                             | `--yes`                           |
| ----------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------ | --------------------------------- |
| `local`                                         | Compose   | `docker compose config --quiet`, `config --hash '*'` against the containers' `config-hash` label | `docker compose up --detach`      |
| has Terraform variables (`gcp`, `azure`)        | Terraform | `terraform -chdir=<module> plan -detailed-exitcode -var-file=<rendered> -out=<plan file>`        | `terraform apply <plan file>`     |
| has a chart overlay (`aws`, or `--target helm`) | Helm      | `helm diff upgrade --detailed-exitcode` with the plugin, else `helm template` summarised         | `helm upgrade --install … --wait` |

Terraform is the default where a module exists, and `--target helm` selects the chart. A
`--target` the profile has no artefact for is refused by name.

### `--infra`

The modules and the chart live in this repository's `infra/`, not in a generated project. A
cloud target needs `--infra <dir>`. The rendered `.auto.tfvars.json` is passed with `-var-file`
where it lies in the project, so it no longer has to be copied into the module, and a stale copy
there cannot win. `deploy` refuses a module without `.terraform` and tells the operator to run
`terraform init`, because `init` configures a backend, which is the operator's choice.

### Apply exactly what was printed

Terraform's plan is written with `-out` to a file in a `mkdtemp` directory (mode `0700`, because a
plan file holds variable values in plain text). `--yes` applies that file. The directory is
removed when the command ends, whether or not it applied. A hard kill can leave it in the
temporary directory.

### Exit codes

Without `--yes`: 0 when the plan has no changes, 2 when it has (the `--detailed-exitcode`
convention). A refusal is 1. With `--yes`, a successful run is 0. `runCli` returns the exit code,
and the binary's entry sets it when the command completed. `runAsProcess` is unchanged. Without
helm-diff the cluster cannot be compared, so a chart plan counts as a change.

### Tool invocation and output

Every tool is spawned without a shell, with arguments as an array, in the project directory,
through an injected `ToolRunner`. The suite stubs it, so no test calls real `docker`, `helm` or
`terraform`. `ENOENT` becomes advice to run `agent-workspace doctor`.

Output is collected, not inherited, and every echoed command line and every line of tool output
passes through a redactor. It masks, as literal substrings, every `.env` value of four or more
characters except the public settings the generator writes (an allow-list: image references, the
project name, bucket, region, service addresses and similar), and the password of any
`scheme://user:password@` URL, including one only the profile holds. A key an operator adds is
masked until it is allow-listed. `docker compose config` is never printed, because it interpolates
`.env`, and `helm template` output is summarised as `Kind/name` lines.

## Consequences

- One command takes a profile edit to the deployment, with the plan shown first and the exit code
  usable as a CI gate.
- Output appears when each tool finishes, not as it runs. Streaming it line by line through the
  redactor is a follow-up.
- Redaction is substring-based. A value a tool transforms, such as base64 in a Secret, is not
  matched. helm-diff hides Secret data by default and `helm template` output is not printed.
- A cloud target needs a checkout for `--infra` until the modules and the chart are published
  with the CLI or to an OCI registry.

## Alternatives rejected

- **Copy the tfvars into the module before planning.** That writes outside the project and
  silently overrides a file the operator kept there.
- **Print `docker compose config` or use `docker compose --dry-run up`.** The first prints the
  interpolated secrets. The second needs Compose 2.21 or later and its wording is not a stable
  contract to parse.
- **Run a fresh `terraform apply` with `-auto-approve` after the plan.** It could apply a plan
  different from the one the operator read.
- **Inherit the tools' stdio.** It shows progress live, but nothing could keep a secret a tool
  prints out of the log.
- **Set `process.exitCode` inside the command, or change `runAsProcess`.** The entry overwrites
  the former, and the latter is shared by every command.
