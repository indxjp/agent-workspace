# ADR-0123 — Kubernetes is an `aw deploy` target that installs the Helm chart

Status: accepted
Date: 2026-10-08
Decided by: the issue #796 plan (C3), reviewed in the pull request
Scope: `PROJECT_DEPLOY_TARGETS` in `packages/contracts/src/project-file.ts`, `packages/cli/src/deploy/project.ts`, `packages/aw/src/commands/deploy.ts`, `infra/helm/agent-workspace` (`networkpolicy.yaml`, `ingress.yaml`, `database.*`, `dns.*`, `ingress.*`, `deploymentPolicy`), the chart smoke in `infra/tests/isolation`

## Context

`aw deploy production` ([ADR-0103](0103-one-project-file-holds-every-environment.md)) reads
`environments.production.target` and takes a project to a single VM or to Cloud Run. Kubernetes was
reachable only through `agent-workspace deploy` over a v1 profile, and the chart's default-deny
NetworkPolicy (#849) left the migrate Job, web and the runner manager with no route to PostgreSQL or
to the cluster DNS, so an install that rendered cleanly could not start.

## Decision

- `kubernetes` joins `PROJECT_DEPLOY_TARGETS`. It has no v1 deployment profile: `aw deploy` installs
  the chart directly with the `helm` steps that already exist (`helm diff upgrade` or `helm
  template`, then `helm upgrade --install --wait`), and `projectToDeploymentProfile` refuses it by
  name.
- `--infra <dir>` is required and names the checkout whose `helm/agent-workspace` is installed. The
  chart is not shipped inside `@indx-workspace/cli`; shipping it is a follow-up.
- `aw deploy` owns one values overlay, `<state>/deploy/helm/values.yaml`: the four image digests
  (kept across runs, overridable with `AW_<NAME>_IMAGE`), an Ingress for the `url` host, and the
  project's policy ceiling as `deploymentPolicy`. The Ingress class and the cert-manager issuer come
  from `AW_INGRESS_CLASS_NAME` and `AW_TLS_CLUSTER_ISSUER` and are kept when a later run omits them.
  `AW_DATABASE_CIDR` sets `database.cidr` the same way; while it is unset every run warns that the
  database rule is open to any address.
- No credential is written. The three Secrets the chart reads are the operator's; `aw deploy` names
  them in its next steps and refuses nothing about them, because Helm and the migrate Job fail on a
  missing one with their own message.
- The chart's policy set becomes enough to start: DNS egress for every pod of the release, database
  egress on `database.port` for web, the migrate Job and the runner manager (narrowed by
  `database.cidr` or `database.podSelector`), and the paired ingress and egress for runner manager
  to gateway and web to runner manager. Ingress is off by default and, when on, admits web from
  `ingress.controllerNamespace` only.
- The kind lane installs the chart under Calico and checks that the migrate Job reaches PostgreSQL,
  that a pod labelled as web does and a pod labelled as the gateway does not.

## Alternatives

- **A `--target` flag.** `aw deploy` has none; the target is the project file's, and a flag would
  make two sources of truth.
- **Generate the Secrets from `aw deploy`.** It would have to hold the database URL and the master
  key; the single-VM `.env` does that, and a Kubernetes Secret written from a laptop is a different
  trust decision. Left to the operator until the project file can say where they live.
- **A `required` database destination.** It would fail every existing `helm` cloud on upgrade. The
  rule opens one port to any destination until the operator narrows it.

## Consequences

An agent turn does not run on the chart yet: the runner manager does not serve the `kubernetes`
runtime driver in a cluster (`apps/runner/src/manager-start.ts`), and the chart has no egress for the
gateway to a model provider or for web to an object store. The kind lane proves the install and the
database path, not a run. Those, the egress proxy image, and the web/gateway session-mirror
allowances are the follow-ups under issue #796.
