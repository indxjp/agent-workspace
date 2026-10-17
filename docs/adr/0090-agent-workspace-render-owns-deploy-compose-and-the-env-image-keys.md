# ADR-0090 — `agent-workspace render` owns `deploy/`, `compose.yaml` and the image keys of `.env`

Status: accepted — extends [ADR-0055](0055-the-deployment-profile-is-one-validated-document-the-installer-renders.md) (artefacts are rendered from the profile)
Date: 2026-10-01
Decided by: the implementer of issue #422 (developer-platform slice 1b, #333)
Scope: `packages/cli/src/render.ts`, `packages/cli/src/render/artefacts.ts`, `packages/cli/src/render/env.ts`, `packages/cli/src/deployment.ts`, `packages/cli/src/index.ts`

## Context

ADR-0055 made `agent-workspace.yaml` the one document every artefact is rendered from, but only
`create-agent-workspace` rendered them, once, into a new directory. An operator who edited the
profile had to edit the generated files by hand or generate a new project with fresh secrets.
Issue #422 adds `agent-workspace render [dir]`, which re-renders a generated project in place, so
the profile stays the one place a decision is written.

Re-rendering in place differs from generating in one way: the project already holds things the
renderer must not touch. `.env` carries the deployment's secrets, which the renderer cannot
re-create, and keys the operator added. The project may hold files of the operator's own. Neither
ADR-0055 nor ADR-0089 says which files, or which `.env` lines, a re-render may write, or where
re-rendered image references come from.

## Decision

### What `render` owns

`render` writes exactly these, and nothing else:

- `deploy/helm/values.yaml` and `deploy/terraform/<module>.auto.tfvars.json`, where the profile
  selects that target, from `renderDeployArtefacts(profile, images)`. `create` renders the same
  files through the same function;
- `compose.yaml`, for `cloud: local` only, as the bytes of `templates/compose.yaml`, the file
  `create` copies;
- in `.env`, the image keys `envImageEntries(profile, images)` returns: `WEB_IMAGE`,
  `GATEWAY_IMAGE`, `RUNNER_IMAGE`, `AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK`, and for `local`
  `POSTGRES_IMAGE` and `SEAWEEDFS_IMAGE`. `renderEnv` writes its image lines from the same list.

`agent-workspace.yaml` is the input and is never written. `.gitignore`, `package.json` and
`pnpm-workspace.yaml` are not re-rendered.

### `.env` is edited line by line

`.env` is read with the rules `parseEnvironment` uses. An owned key is rewritten in place,
including every repeat of it. A missing owned key is inserted after the last owned line, or at the
end when there is none. Every other line keeps its bytes, its place and its line ending (CRLF
stays CRLF): comments, secrets, profile-derived settings and keys the operator added. An image key
the profile no longer selects is left alone. A missing `.env` is refused, because `render` never
mints secrets. A malformed line is refused by its line number, without quoting it.

### Where image references come from

For each image the profile needs, in order: an `AW_<NAME>_IMAGE` override, resolved as `create`
resolves it; else the reference `.env` already pins, held to the same digest gate
(`assertDigestReference`); else this CLI's release default. `resolveDeploymentImages` takes the
pins as an optional argument, so there is one resolver and one gate. A pin is used without a
registry, so `render` and `render --check` run offline on a generated project and never upgrade
an image the operator did not ask for.

### Plan first, then write; never delete

Every owned file's content is computed, and compared with what is on disk, before anything is
written. A refused profile, a malformed `.env` or an image that fails the gate therefore writes
nothing. Only changed files are written, and an existing file keeps its mode, so `.env` stays
`0600`. A file a previous profile rendered and the current one does not, such as the Terraform
variables for the previous cloud, is left in place. `render` deletes nothing.

### Output, and `--check`

Each owned file is listed by path as `created`, `updated` or `unchanged`. No value read from `.env`
is printed. `--check` lists the same files as `would create`, `would update` or `unchanged`, writes
nothing, and exits 1 when anything would change.

## Alternatives rejected

- **Re-resolve every image from the registry on each run**, as `create` does. This needs Docker
  and the network in CI. A re-pushed tag would make `--check` flap. It is also a silent upgrade,
  which belongs to an explicit flag or to `deploy`.
- **Re-render all of `.env` with `renderEnv`.** That needs secrets `render` does not hold. It would
  also reorder or drop the keys the operator added.
- **Call `renderDeploymentArtefacts` with stub secrets and keep `deploy/`.** That works, but it
  couples `render` to secrets it never uses. `renderDeployArtefacts` is the smaller seam.
- **Delete artefacts the profile no longer selects.** A file the operator may have committed or
  copied elsewhere would vanish without a prompt. Reporting such files is a follow-up.

## Consequences

- A profile edit that changes a non-image `.env` value, such as `storage.objects`
  (`OBJECT_STORAGE_*`), `identity.bootstrapAdmin` (`BOOTSTRAP_ADMIN`), the runtime or the secret
  backend, updates `deploy/` but not that `.env` line. This is documented in
  `packages/cli/README.md`. Owning those keys too is a follow-up decision.
- `render` restores `compose.yaml` to this CLI's template. Running a newer CLI against an older
  project therefore brings its Compose file up to that release.
- Newly generated `.env` files say in their header that `render` owns the image lines. Projects
  generated earlier keep their old header comment, which `render` does not rewrite.
- Follow-ups: an explicit `--upgrade-images` mode, rendering the profile-derived non-secret `.env`
  keys, and reporting artefacts left over from a previous cloud.
