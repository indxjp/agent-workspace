# W1-INF-01 — MinIO is AGPL, and referencing a published image is not redistribution

Status: accepted
Date: 2026-09-03
Decided by: W1-INF-01 (Infra)
Scope: `compose.yaml`, the `minio` service; `docs/dependency-policy.md` §5

## Context

`docs/dependency-policy.md` §5 is unambiguous about copyleft: *"No strong copyleft, anywhere in any
of them. GPL and AGPL, in every spelling including the deprecated identifiers, are DENY and are not
clearable by an exception."*

MinIO is licensed AGPL-3.0. Spec §32 names "Object Storage" as one of Simple Mode's five
components, spec A.4 names MinIO specifically, and this task's brief requires it. Read without its
scope, the policy forbids the file the brief requires.

## Decision

**The policy's scope is what we redistribute, and we redistribute no part of MinIO.** §5 opens by
naming the three artefacts it governs: *"an npm tarball, the two Docker images of spec A.2
(`control-plane`, `runtime`), and the Helm chart of A.5"*. MinIO is in none of them. `compose.yaml`
names a tag that Docker Hub serves to the operator's own machine; nothing in this repository
contains, links against, statically or dynamically loads, or modifies MinIO code.

The interface is the S3 HTTP API over a network socket, which is also why the AGPL's network clause
does not reach us: §13 obliges *the operator of the modified MinIO* to offer its users the MinIO
source. We do not modify it and we do not operate it — the self-hoster does, unmodified, in which
case the obligation is discharged by MinIO's own published source.

This is the same status as `postgres:17-alpine` and `node:24.19.0-bookworm-slim`: third-party
images an operator pulls, not artefacts we ship.

**The tag is pinned to an exact release** (`RELEASE.2025-09-07T16-13-09Z`) rather than `latest`, so
that the licence and the behaviour of the thing being referenced cannot change under a deployment
without a diff.

**The port is not published**, so nothing outside the host reaches it, and its root credentials are
literals in `compose.yaml` for the reason recorded in
`W1-INF-01-env-example-is-six-values.md`.

## Alternatives rejected

* **Treat the policy as covering compose references and pick a non-AGPL S3 server.** `SeaweedFS`
  (Apache-2.0) and `Garage` (AGPL) and `localstack` (mixed) were the alternatives. It would
  contradict spec A.4, which names MinIO, and the policy's own scope sentence, which does not
  reach here. Contradicting the specification to satisfy a policy that does not apply is worse than
  either.
* **Add a recorded exception to `scripts/check-licenses.mjs`.** The gate reads the npm tree. It
  has never seen a container image and cannot; an exception there would be a claim that the gate
  checked something it structurally cannot check — ADR-0015's shape exactly.
* **Say nothing.** The next person to read `docs/dependency-policy.md` §5 and then `compose.yaml`
  will believe one of them is wrong. This record is cheaper than that conversation happening twice.

## Honest downside

**No gate enforces the distinction this record draws.** Nothing stops a later task from adding a
strong-copyleft image to `compose.yaml` in circumstances where the reasoning above does *not* hold
— for example, an image we fork, patch and publish. The rule is: **if we build it or publish it,
§5 applies in full; if the operator pulls it from its own upstream, unmodified, §5 does not
reach it.** That sentence belongs in `docs/dependency-policy.md`, which is not this task's file, so
it is proposed here and declared as a gap in this task's PR.

**Recent MinIO community releases have removed features from the web console.** Irrelevant to this
deployment, which uses the S3 API only and publishes no console port, and worth knowing before
anyone expects a browser UI from this service.
