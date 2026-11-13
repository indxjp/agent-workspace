---
changelog: platform
section: Added
---

- `aw deploy production` deploys the whole workspace into your Google Cloud project from one
  `gcp: { project, region }` block in `agent-workspace.yaml` (BYOC Google Cloud, phase P1). It first
  checks your tools, sign-in, project, billing, APIs and organisation policies and prints every
  result with one fix command per failure; with `--yes` it creates the state bucket, enables the
  APIs, copies the release images and applies, printing a plan summary, per-step timings and the
  web address. `aw deploy production --show-owner-password` prints the generated Owner password,
  which is never shown otherwise. `aw deploy destroy production` removes the stack after you type
  the project id; data protection keeps the database unless the stack was created disposable
  (`TF_VAR_data_protection=false`). `docs/deploy/gcp-cloudrun.md` is rewritten task-first, with
  Cloud Shell first and the `--infra` procedure for maintainers.
  A Google Cloud region with a two-digit number (`europe-west10`) is accepted. The check now also
  asks for `gcloud auth login`, which a laptop needs beside `gcloud auth application-default
login`. `aw deploy` refuses a state bucket owned by another project, stops a destroy before
  anything is deleted when Cloud SQL data protection is on, and copies the release images again
  when a plan or a destroy left a pin to images that are not there.
  `aw deploy` re-runs `terraform init` (against the shipped lock file) when the shipped module's
  providers or lock file change, refuses a `name` in `terraform.tfvars` or `TF_VAR_name` that differs
  from the project name, checks the `iam.serviceAccounts.actAs` permission, refuses to start a second stack beside one whose state is elsewhere (it prints the `init -migrate-state`
  command), refuses a `--infra` checkout whose tfvars name another project or region, and
  `aw deploy destroy production` refuses a stack that never used the managed state. The permission
  fix names the narrowest roles instead of Owner, and the Terraform install command checks the
  archive against HashiCorp's SHA256SUMS. A project name longer than 19 characters is cut to 14 characters plus a short hash of the full name. The public-access organisation-policy check prints no fix, and `aw deploy destroy` says the same project name cannot be redeployed right away.
