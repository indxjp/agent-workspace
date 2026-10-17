# W1-INF-01 — Two images ship the same §14.3 server, and the difference is the file, not a flag

Status: accepted
Date: 2026-09-03
Decided by: W1-INF-01 (Infra)
Scope: `Dockerfile`, `runtime.Dockerfile`, `compose.yaml`

## Context

Spec A.2 ships exactly two images: `agent-workspace/control-plane` (*"Next.js web, model gateway,
runner manager"*) and `agent-workspace/runtime` (*"Node, Claude Agent SDK, the HTTP contract in
section 14.3"*). Spec A.4 adds that sandbox containers are *"created on demand by the docker
driver, not declared in compose"*.

In Wave 1 there is one server that answers §14.3 — `apps/runner/src/server.ts` — and it appears in
both roles. §33's long-lived `runner` service is that server with the `local` driver. The sandbox
image is that same server, one container per run, launched by a `docker` driver that Wave 3 will
write. Nothing in this wave launches the sandbox image at all.

So a build file could reasonably have gone either way: one image with two commands, or two images.

## Decision

**Two files, `Dockerfile` and `runtime.Dockerfile`, because the two images have opposite postures
and a posture expressed as a runtime flag is one environment variable away from being wrong.**

| | `Dockerfile` target `runner` | `runtime.Dockerfile` |
| --- | --- | --- |
| Role | §33's long-lived `runner` service | one throwaway sandbox per run |
| Installed | the whole workspace, `apps/web` included | `pnpm --filter "@agent-workspace/runner..."` only |
| Working directory | the repository | `/workspace`, empty, writable, owned by uid 1000 |
| User | `node` | `node` — §14.3 requires it, so it is verified, not assumed |
| In `compose.yaml` | yes | **no**, per A.4 |

The sandbox image contains no Next.js and no React — verified by inspecting the built image, not by
reading the filter — and no `apps/web` directory at all. That is the property the separate file
buys, and it is the one that matters: whatever a container escape reaches inside a sandbox, it does
not reach the control plane's code.

`Dockerfile`'s `web` and `runner` targets, by contrast, **are** one image in two tags today; they
differ only in working directory and command. Collapsing them into A.2's single
`control-plane` tag is a packaging change that belongs with the `buildx` work of W3-RT-05, and the
tag suffix (`:dev-web`, `:dev-runner`) says which target produced which until then.

`runtime.Dockerfile` is not a `compose.yaml` service and is therefore not exercised by
`docker compose up`. To keep it from being a file that merely compiles, this task's acceptance run
builds it, starts it standalone, and checks `/healthz`, the container user, the working directory
and the absence of control-plane packages. The output is in the PR body.

## Alternatives rejected

* **One image, one `CMD`, the role chosen by an environment variable.** Smallest diff, and it makes
  "is this a sandbox?" a question about a variable rather than about an artefact. A misconfigured
  sandbox that is actually the control-plane image is a security failure that looks like a working
  deployment.
* **Make `compose.yaml`'s `runner` service build from `runtime.Dockerfile`.** Genuinely tempting:
  Wave 1's runner *is* a §14.3 runtime, and it would mean every `docker compose up` exercised the
  image the product ships as its sandbox. Rejected because A.4 and §33 name `runner` as a
  control-plane service and the sandbox as something the driver creates; conflating them now would
  have to be un-conflated in Wave 3, and the `docker` driver's whole job is to keep them apart.
* **Generate the sandbox image from `Dockerfile` with a third target.** A stage cannot be shared
  across files, so this would work — and it would put the sandbox's contents in the same file as
  the control plane's, where a `COPY --from=build /srv /srv` added for `web` silently widens the
  sandbox too.

## Honest downside

**Two files install the same dependency graph twice, and their build caches are separate.** A CI
run that builds both pays for two `pnpm install`s of overlapping trees. That is real, and it is the
price of the second column of the table above.

**They can drift.** The Node base image, the pnpm version and the entry-point command are written
in both files, and nothing checks that they agree. A gate that diffs the two would be better than
this paragraph; there is nowhere sensible in Wave 1 to put one, and W3-RT-05 will touch both files
for `buildx` anyway.

**Nothing launches `runtime.Dockerfile` in this wave**, so its acceptance evidence is a standalone
`docker run`, not a driver. Its multi-architecture requirement — mandatory, because Bedrock
AgentCore is Graviton-only and rejects `amd64` at deploy time — is entirely unbuilt here and
belongs to W3-RT-05.
