# ADR-0086 — The platform images publish to GHCR, publicly, from an `images-v<version>` tag

Status: accepted
Date: 2026-09-30
Decided by: the implementer of developer-platform slice 0d (issue #370), on the Owner's decision of
2026-09-30 to publish the platform images on GHCR, publicly pullable
Scope: `packages/cli/src/release-images.{json,ts}`; `packages/cli/src/deployment.ts`;
`infra/release/*`; `.github/workflows/images.yml`; the `ci.yml` heavy-checks image steps;
`scripts/check-workflows.mjs`'s action allowlist; `docs/release/README.md`

## Context

The published generator (`npm create @indx-workspace@latest demo -- --cloud local`, 0.1.0) refuses
to write a project: `Could not resolve immutable digest for ghcr.io/indxdev/agent-workspace/web:0.1.0
… 403 Forbidden`. `packages/cli/src/deployment.ts` resolves every image it pins to a digest through
`docker buildx imagetools inspect` and refuses a mutable tag, which is right, but no platform image
had ever been published: `infra/release/build-and-push.sh` existed and nothing ran it, and
`release.yml` only verifies images that are already published and signed.

The image list was written three times: as tags in `deployment.ts`, as `publish` lines in
`build-and-push.sh`, and as `releaseImages()` in `scripts/release/check.mjs`.

## Decision

### D1 — A dedicated `images-v<version>` tag, not `v*`

`.github/workflows/images.yml` runs on a push of `images-v*`. The tag must point at a commit on
`main`, and must name the version `packages/cli/src/release-images.json` pins, or nothing is built.

`v*` was rejected. It triggers `release.yml`, the verified platform release, which requires the
images to be published, signed and recorded in `docs/release/evidence-manifest.json` before that
tag exists, together with evidence and approvals the images do not need. One tag cannot both
produce the images and prove they were produced before it. A separate namespace also follows
`packages-v*` (ADR-0082): each publishing workflow has its own tag, and the namespaces never
overlap. The order is `images-v<version>`, then the evidence, then `v<version>`.

### D2 — One list of images, owned by the generator

`packages/cli/src/release-images.json` names the registry (`ghcr.io/indxdev`), the version and the
image each generator field pins (`web`, `gateway`, `runner`, `runtime`). The CLI imports it, and
`tsc` copies it into `dist/`, so the published CLI carries the list it resolves.
`infra/release/images.mjs` turns it into the build plan: the three process images with their
Dockerfile and `--target`, then one runtime image per engine adapter (ADR-0073, from
`scripts/engine-images.mjs`). It refuses a generator image that nothing builds.
`build-and-push.sh` and `write-manifest.mjs` read the plan, and `tests/release/platform-images.test.ts`
holds the plan to the generator list, to the engine list and to `releaseImages()`.

The runtime images of the engines the generator does not pin (Mastra, OpenAI Agents, Pi) are
published too. ADR-0073 makes the release publish one per engine, and a deployment that runs those
engines resolves them from the same registry.

### D3 — Signed, attested, multi-arch, with the run's token only

The `publish` job builds `linux/amd64` and `linux/arm64` with `docker buildx` (QEMU for arm64) on
the largest Blacksmith size CI uses. buildx (`v0.36.0`) and BuildKit (`v0.32.2`, by digest) are
pinned, and the build asks for SLSA provenance `v0.2` explicitly, because `check-provenance.mjs`
and `cosign attest --type slsaprovenance` read that format. The job logs in to GHCR with the run's
`GITHUB_TOKEN`, holds `contents: read`, `packages: write` and `id-token: write`, and runs in the
`images-publish` environment. The Owner creates that environment with a deployment tag rule
`images-v*` (and reviewers, if wanted), as for `npm-publish`, so that a tag alone is not enough to
publish public images. The tag-on-`main` check reads `origin/main` from the full-depth checkout;
the checkout keeps no credential, and nothing fetches again. For each image, `build-and-push.sh`:

1. for every platform of the index, writes an SPDX SBOM with syft, scans with trivy (failing on a
   fixable HIGH or CRITICAL finding), and checks the SLSA provenance BuildKit recorded;
2. signs the digest keyless with cosign;
3. attaches each platform's SBOM (`spdxjson`) and provenance (`slsaprovenance`) as cosign
   attestations;
4. verifies the signature and both attestation types against this workflow's identity.

These are the checks `release.yml` runs. The job does not hold `attestations: write`, because the
attestations are cosign's, stored beside the image, not GitHub's attestation API. The manifest
(name → digest reference), SBOMs and provenance are uploaded as the `platform-images-<version>`
artifact.

Amended by ADR-0087 (#373): the trivy step's flags live in `infra/release/trivy-gate.sh`, which CI's
`image-scan` job also runs on every pull request, and its only exceptions are in `.trivyignore.yaml`.

### D4 — Public by one Owner step, checked by the workflow

A new GHCR package is private, and an org package's visibility is changed by an org owner, once per
package, in the package settings (docs/release/README.md, "Platform images"). The `verify-public`
job logs out and inspects every digest in the manifest anonymously. It fails, naming each package
and the settings page, until every package is public. It is a separate job, so that "Re-run failed
jobs" repeats only the check and never pushes an image again.

### D5 — The generator keeps refusing, and says why

When a default platform image cannot be resolved, `create` still refuses, and its error names the
`images-v<version>` tag, `.github/workflows/images.yml`, the public-visibility step and the
`AW_*_IMAGE` digest overrides. CI heavy-checks runs `infra/release/smoke-create.mjs`, which asks
the registry anonymously about each pinned tag, with a 15-second timeout and three attempts (with
backoff) on a network error, 429 or 5xx. If every tag is published, it runs `create --cloud local`
and requires a digest-pinned `.env`; that is the only way it fails on registry grounds, since the
images are then public and `create` should work. Every other state (none or some published, a
package not public yet, a registry that did not answer after the retries) skips with a
`::warning::` naming each image's state: registry state must never fail an unrelated PR. The one
exception is a `ghcr.io` owner GitHub answers 404 for, which is a wrong `registry` in
`release-images.json`, a change to the tree. CI also dry-runs `build-and-push.sh` for one image and
one platform, building by digest and pushing nothing.

### D6 — Digest first, tag last, and a published tag never moves

`build-and-push.sh` pushes each image by digest only (`push-by-digest=true`, no tag), runs every
gate of D3 on that digest, and adds the `<version>` tags (`docker buildx imagetools create`, which
copies the signed index unchanged; each tag is read back and must name the digest that passed) only
after every image has passed. A failed gate therefore leaves no tag behind, and no public
`<version>` points at an unscanned or unsigned image.

Before it builds anything, the script resolves every planned `<name>:<version>`. A tag that does
not exist is built. A tag that exists must carry this commit's `org.opencontainers.image.revision`
(every image is labelled with it at build time): it is then a re-run of this release, so its
signature and attestations are verified again and it is kept as it is. A tag that exists with any
other revision stops the run before a build, as does a registry that cannot say whether the tag
exists. Re-running the workflow, or re-pushing the tag, therefore never moves a published tag to
other content; a fix is a new version.

## Consequences

- Cutting a platform release is now: `images-v<version>`, make the packages public (the first time),
  collect the evidence, then `v<version>`. `release.yml` is unchanged; its header names this order.
- The first run cannot pass `verify-public` until the Owner makes each package public; that is
  expected, and the job says what to do.
- A HIGH or CRITICAL finding with a fix available blocks the release until the base image or the
  dependency is updated. That gate is not relaxed here.
- A re-run after a partial failure publishes only what is missing; a tag already published from
  another commit fails the run, and the release takes a new version.
- Changing the pinned version is one edit to `release-images.json`, which the CLI then ships.
