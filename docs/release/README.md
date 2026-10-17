# Release evidence

`evidence-manifest.json` is the single machine-readable input to `pnpm release:ready`. It is
intentionally incomplete on ordinary development branches. A passing structural check does not
make a release ready, and the release workflow will not publish while this manifest is incomplete.

## Candidate procedure

1. Select one release-candidate commit and build every executable image for `linux/amd64` and
   `linux/arm64` from that commit.
2. Record digest references for web, gateway, runner-manager, and runtime. Attach and verify SBOM
   and provenance attestations, then scan and sign each digest.
3. Run all repository, browser, isolated-runtime, live-provider, deployment/rebuild/restore, and
   operations-drill lanes at that same commit. Each evidence record must carry its stable
   capability id, commit SHA, completion time, and result.
4. Verify the owner-controlled package identity and record its exact name and version.
5. Have an independent participant complete the walkthrough. The participant and approver must be
   people; an automation or coding agent cannot approve it.
6. Record an owner disposition for every residual risk and obtain the distinct release-owner and
   security approvals required by the protected environment.
7. Change the canonical capability statuses and release verdict only when the evidence supports
   those changes. Run `pnpm status:check`, `pnpm release:check`, and `pnpm release:ready`.
8. Create the version tag at that exact commit. The verified release workflow rechecks signatures,
   attestations, package ownership, evidence freshness, approvals, and SHA equality before publish.

Steps 1 and 2 are the image release below: `release.yml` verifies images that
`.github/workflows/images.yml` has already published, and publishes none itself.

## Platform images

`.github/workflows/images.yml` builds, scans, signs and pushes the platform images to
`ghcr.io/indxdev/agent-workspace/*` from an `images-v<version>` tag (#370, ADR-0086). The image
list is `packages/cli/src/release-images.json`, the images the generator pins, plus one runtime
image per engine; `node infra/release/images.mjs --references` prints it. Each image is built for
`linux/amd64` and `linux/arm64` and pushed by digest only. Every platform is scanned with trivy and
described by an SPDX SBOM; the digest is signed keyless with cosign and carries the SBOMs and SLSA
provenance as cosign attestations (what `release.yml` verifies). Only when every image has passed
are the `<version>` tags added. The only credential is the run's `GITHUB_TOKEN`, in the
`images-publish` environment.

### Create the `images-publish` environment (Owner, once)

Before the first image release, create the environment the `publish` job runs in, as for
`npm-publish`: **Settings → Environments → New environment**, name `images-publish`. Under
**Deployment branches and tags**, choose **Selected branches and tags** and add the tag rule
`images-v*`. Add required reviewers if a person should approve each publication. Without the
environment, GitHub creates an unprotected one on the first run; without the tag rule, any tag
could deploy to it.

### Cut an image release

1. Make sure `version` in `packages/cli/src/release-images.json` is the version to publish. The
   CLI resolves `<name>:<version>`, so a CLI release that pins a new version needs this release
   first. Its major.minor must equal `CONTRACTS_VERSION`'s (`node scripts/release/check.mjs` and
   `tests/release/check.test.ts` refuse anything else, ADR-0078 D2): a project's images must serve
   the contracts minor its own CLI and `aw` state. For 0.2.0 that means **`images-v0.2.0` is
   published before `packages-v0.2.0`**.
2. Tag the commit on `main` and push the tag:
   `git tag images-v<version> <sha-on-main> && git push origin images-v<version>`. The workflow
   refuses a tag off `main`, and a tag whose version differs from the JSON.
3. The `publish` job uploads the `platform-images-<version>` artifact: `images.json` (each image's
   digest reference), the SBOMs and the provenance of every platform. The digests go into
   `docs/release/evidence-manifest.json` for the platform release.
4. The `verify-public` job logs out and inspects every digest anonymously. On the first release it
   fails until each package is public (below). Then use **Re-run failed jobs**, which repeats only
   this check and pushes nothing. A registry error that is not a refusal is reported as such, not
   as a visibility problem.

A published version is never overwritten (ADR-0086 D6). Before building, the job looks up every
`<name>:<version>`: a tag published from the same commit is kept as it is (so a re-run after a
partial failure publishes only the rest), and a tag published from any other commit stops the run.
A fix is a new version and a new tag.

The vulnerability gate is `infra/release/trivy-gate.sh`: a fixable HIGH or CRITICAL finding, in a
package or as a secret, fails the image (ADR-0087 D4). CI's `image-scan` job runs the same script
on every image of the plan, built for `linux/amd64`, on every pull request, so a finding normally
fails the pull request that introduces it rather than the release. The only exceptions are in
`.trivyignore.yaml`, each with a statement and an expiry. The images carry no npm and no corepack;
the `runner` and runtime images serve `npx` through `pnpm dlx` (ADR-0087 D1).

When a gate stops the run, no `<version>` tag was added: the images pushed by digest are untagged
and nothing references them. Once the fix is on `main`, the same version can be cut again by moving
the git tag, which ADR-0086 D6 allows because every `<name>:<version>` is still absent:
`git push origin :refs/tags/images-v<version>`, then tag the fixed commit on `main` and push the tag
as in step 2. Check first that no image tag exists
(`docker buildx imagetools inspect ghcr.io/indxdev/agent-workspace/web:<version>` must fail with
"not found" for each name); if one does, the version was published and the fix is a new version.

### Make the packages public (Owner, once per package)

A new GHCR package is private. An org owner makes each one public once. For every name that
`node infra/release/images.mjs` prints (`web`, `gateway`, `runner`, each `runtime-<engine>`,
`egress-proxy`, `tool-host`, and any image added since; step 1 of
[Cut a package release](#cut-a-package-release) names the new ones):

1. Open `https://github.com/orgs/<org>/packages/container/agent-workspace%2F<name>/settings`
   (`<org>` is the owner in `node infra/release/images.mjs --registry`),
   or go to the org's **Packages** tab, open `agent-workspace/<name>` and choose **Package
   settings**.
2. Under **Danger Zone**, choose **Change visibility**, select **Public**, and type the package name
   to confirm.

If **Public** is not offered, an org owner must first allow public packages under
**Settings → Packages → Package creation**. GitHub's REST API can read a package's visibility
(`gh api /orgs/<org>/packages/container/agent-workspace%2F<name> --jq .visibility`) but cannot
change it, so this step is done in the web UI.

When all packages are public, `npm create @indx-workspace@latest demo -- --cloud local` resolves
every image to a digest without credentials. CI's heavy-checks runs the same generator against the
registry (`infra/release/smoke-create.mjs`). It fails only when every pinned image is public and
`create` still does not work; while any image is unpublished or not public, or the registry does
not answer, it skips with a warning, so registry state never fails an unrelated change.

## Fail-closed rules

The readiness checker refuses an open blocker, stale or missing evidence, evidence from another
commit, mutable image tags, missing image signatures/SBOMs, unverified package ownership or
provenance, an unperformed walkthrough, unsigned residual risk, or absent owner/security approval.
Changing prose does not bypass any of these checks.

Live credentials and cloud permissions belong only in protected GitHub environments. Evidence and
service logs must be redacted before upload. Secret values, downloaded service-account keys, and
Terraform-managed secret payloads must never be committed.

## npm packages

`@indx-workspace/contracts`, `@indx-workspace/platforms`, `@indx-workspace/sdk`,
`@indx-workspace/react`, `@indx-workspace/aw`, `@indx-workspace/cli`, `@indx-workspace/embedded` and
`@indx-workspace/create` are released
separately from the platform, by `.github/workflows/publish-packages.yml`, from a
`packages-v<version>` tag (ADR-0082 and its amendments, ADR-0109). The `v*` tags above belong to
the platform release; the two namespaces never overlap.
Each package packs from `packages/<name>`, except `@indx-workspace/embedded`, which packs from the
staging directory its build writes, `packages/embedded/publish` (ADR-0109); the release fails, and
never skips it, when that directory is missing.

- **Version.** All eight carry `CONTRACTS_VERSION` (`packages/contracts/src/version.ts`), pinned by
  `packages/aw/src/version.test.ts` and `tests/public-docs-truth.test.ts`. The workflow refuses a
  tag that names any other version. That version moves on its own, by patch releases of the eight
  packages, and is not the platform version: the root `package.json` is, and it is the one
  `evidence-manifest.json` records.
- **Evidence.** Before any publish, `scripts/release/pack-packages.mjs --smoke` packs each package,
  refuses a tarball with anything but `dist/` and the manifests (and, for the CLI, its generator
  `templates/`), a `workspace:` specifier, a sibling off lock-step, or any `@agent-workspace/*` name
  in the manifest, `dist/` or `templates/` (a third party's npm scope; for embedded this covers
  `dist/web/`), then installs the eight tarballs into an empty project, imports every documented
  subpath, type-checks a consumer of `@indx-workspace/sdk/testing`, runs `npx aw --version` and
  `npx agent-workspace --help`, and runs `npm create @indx-workspace` offline into a new directory
  once per create smoke case (`CREATE_SMOKE_CASES`), with the flags after npm's `--` so npm does
  not take them as its own. `npm create @indx-workspace <dir> -- --cloud local` writes the Compose
  project, whose `package.json` must depend on `@indx-workspace/cli` at the release version and
  nothing else. `npm create @indx-workspace <dir> -- --yes` writes the default v2 project, whose
  `package.json` must depend on exactly `@indx-workspace/aw`, `@indx-workspace/embedded` and
  `@indx-workspace/sdk` at the release version. It then runs the **boot smoke**: a second empty project installs the embedded and contracts
  tarballs with `--ignore-scripts`, runs `npm rebuild` of its `@embedded-postgres/*` package, forks
  `@indx-workspace/embedded/launch` with an IPC channel and checks every message against the
  installed contracts' `LocalRuntimeChildMessageSchema`: `ready`, then `credential`, then
  `GET /api/me` answering 200 with that token, then exit 0 on SIGINT. It prints
  `smoke: embedded ready`, `smoke: credential received` and `smoke: /api/me 200` on stderr and
  never prints the token; stdout carries only the tarball list. The embedded PostgreSQL listens on
  the fixed port 25432 (or `AW_DATABASE_PORT`), so the boot smoke fails, naming that port, while
  another local runtime runs on the same host. CI's heavy-checks runs the same command on every
  change.
  `--packages <list>` packs a subset, in publish order; it exists only for
  `tests/generated-project/run.mjs`, whose v1 Compose project needs only the CLI, and is refused
  together with `--smoke` or `--expect-tag`, so a release and the smoke always pack all eight.
- **Two jobs.** `verify` holds no OIDC token: it refuses a tag whose commit is not on `main`,
  installs with `--ignore-scripts`, builds the eight without any cache (`--skip-nx-cache`, and no
  remote-cache credential — ADR-0110), checks the pinned images are public, packs and verifies the
  eight with `--expect-tag`, records each tarball's sha256 as a job output and uploads the tarballs
  and their list as an artifact of the run, kept for 7 days. Only then does it run the smoke, which
  re-packs into its own directory and must produce byte-identical tarballs. `publish` runs in the
  `npm-publish` environment with `id-token: write`, checks out without a git credential, installs
  only the pinned npm CLI, downloads that artifact, refuses any tarball whose sha256 is not the one
  recorded before the smoke, re-runs every tarball check at the version the tag names, and
  publishes. The smoke runs third-party code (`npm rebuild`, the runtime's registry-resolved
  dependencies), so it never runs in the job that can publish, and it runs with an allowlisted
  environment (`PATH`, home, temporary directories, locale, proxy), so no CI credential reaches it.
- **Provenance.** Off while this repository is internal (Owner decision 2026-09-30, ADR-0082 D5):
  npm accepts provenance only from a public repository. The workflow's `NPM_PROVENANCE` is the one
  switch; set it to `'true'` when the repository becomes public, after which npm records each
  tarball's provenance (repository, workflow, commit). `'true'` on a non-public repository is
  refused before anything is published.
- **Credentials.** None are stored. The publish job publishes through npm trusted publishing
  (GitHub OIDC). Each package's trusted publisher on npmjs.com names this repository,
  `publish-packages.yml` and `npm-publish`.
- **Re-runs.** A version npm already serves (`npm view` prints exactly that version) is skipped, so
  a re-run after a partial failure publishes only the rest; the run then fails unless npm serves
  all eight. The tarball list must be exactly contracts, platforms, sdk, react, aw, cli, embedded, create, in
  that order and at one version, or nothing is published; `publish-packages.mjs` checks this again from
  the tarballs' own manifests, and resolves each line of the list against the list file's
  directory. A published version is never overwritten; a fix is a new patch version and tag.
  "Re-run failed jobs" works while the run's artifact is kept (7 days); after that, re-run all
  jobs, which packs and verifies again from the tagged commit.
- **First publish of a new package name (Owner, once).** A trusted publisher can be configured
  only for a package that exists, so for each name the list adds — `@indx-workspace/embedded`
  (ADR-0109), `@indx-workspace/react` (issue #623), then `@indx-workspace/platforms` (issue #956) —
  the Owner publishes a placeholder first
  version by hand, `0.0.0-bootstrap` as for the first five (ADR-0082 D5), and then configures its
  trusted publisher (this repository, `publish-packages.yml`, `npm-publish`). For
  `@indx-workspace/react` this must happen before `packages-v0.4.0` is tagged: until it does, that
  release and every later one is refused; the same holds for `@indx-workspace/platforms` and the
  first `packages-v*` tag after it joined the list. The placeholder is a `package.json` alone (name, that
  version, `license`, `repository`) published with `npm publish --access public`; never publish the release version
  by hand, because the workflow would then skip it and npm would serve bytes the verify job never
  checked. Until the placeholder exists, the publish job refuses the whole release before
  publishing anything: before the first `npm publish`, `publish-packages.mjs` asks npm
  (`npm view <name> versions --json`) about all eight packages, and a package npm has never served
  (E404 or no versions) fails the run with `ReleaseRefusedError` `NEVER_PUBLISHED`, naming it and
  this step. A lookup that fails any other way (network or registry error) also refuses
  (`REGISTRY_UNREACHABLE`) rather than proceeding. There is no bootstrap path inside the
  workflow; the placeholder is only ever published by hand. So a tag never leaves a partial
  lock-step set; after the Owner's step, re-run the publish job (or all jobs once the artifact has
  expired). This is a declared gap: until then, `@indx-workspace/embedded`,
  `@indx-workspace/react` and `@indx-workspace/platforms` are proven from tarballs only.

### Cut a package release

1. Bump the eight packages lock-step in one pull request: `version` in each `package.json`,
   `CONTRACTS_VERSION`, `AW_VERSION`, `CLI_VERSION`, `release-images.json`'s `version` (same
   major.minor), the schema URL in the CLI's profile fixtures, a heading in each `CHANGELOG.md`,
   and the regenerated docs (`pnpm docs:generate`). `create`'s generated `package.json` pins
   `CLI_VERSION`, so it moves with it. 0.3.0 is the example: `docs/release/notes/0.3.0.md`.
   The release notes' status line reads **published from the `packages-v<version>` tag**, never
   "not published yet": the notes merge before the tag, and nothing edits them after it. Name in
   the pull request every image that `node infra/release/images.mjs` prints and no earlier
   `images-v*` tag published (compare with the previous release's `platform-images-<version>`
   artifact): each starts private (step 2).
2. After it merges, publish the images first: `images-v<version>` on the same commit (above).
   `publish-packages.yml` refuses to publish while any pinned image is unpublished or private.
   Before tagging, list each image's visibility; a `404` is an image this release publishes for
   the first time, and anything but `public` needs the Owner step in
   [Make the packages public](#make-the-packages-public-owner-once-per-package) once the
   `images-v<version>` run has pushed it, then **Re-run failed jobs** on its `verify-public` job:
   ```sh
   org=$(node infra/release/images.mjs --registry | cut -d/ -f2)
   for name in $(node infra/release/images.mjs | cut -d' ' -f1); do
     printf '%s ' "$name"
     gh api "/orgs/$org/packages/container/agent-workspace%2F$name" --jq .visibility 2>&1 | tail -1
   done
   ```
3. Tag `packages-v<version>` on that commit and push it. Never a `v<version>` tag: that is the
   platform release, which needs the evidence manifest.
4. Check the `install-live` run for this version and link it from the release's tracker issue
   (below). It starts by itself when `publish-packages.yml` finishes. If you cannot, run the
   post-publish smoke below by hand.
5. Redeploy the public sites from the tagged commit, so docs.agentworkspace.indx.jp describes the
   release npm now serves: `git checkout packages-v<version> && pnpm install && pnpm sites:deploy`
   ([infra/cloudflare](../../infra/cloudflare/README.md); it needs a Cloudflare token for the two
   Workers). No workflow deploys them yet.

### Install live

`.github/workflows/install-live.yml` (ADR-0130) installs the published release from
registry.npmjs.org on a clean ubuntu, macOS and Windows machine and runs the docs' commands and the
ten use cases against the real model. It waits for npm to serve the version as `latest`, runs after
every `packages-v*` publish, nightly and on demand (Actions > Install live > Run workflow), and is
not a required check. It needs the repository secret `ANTHROPIC_API_KEY`; without it every row from
the first `npm run dev` on reads `skipped` and the run is red. A run with only skipped rows files
nothing; FAIL rows still file, deduplicated by failure set: a failure opens (or comments on) the
issue labelled `install-live` unless its latest body or comment already reports the same set, and a
run with nothing failed or skipped closes it. A failure that is a product bug gets its own issue and
an entry in `tests/docs-claims/install-live-known.json`; it then reads `known failure (#N)`.
The table is in the run's job summary and the `install-live-summary` artifact, kept 90 days.

### Post-publish smoke

The fallback when `install-live` cannot run, from `git checkout packages-v<version>`.
`tests/journey/run.mjs` normally packs this checkout and installs it from its own Verdaccio. With
`JOURNEY_REGISTRY` set it starts no Verdaccio, packs and publishes nothing, and the clean machine
installs what that registry serves, so the same journey proves the published release:

```sh
pnpm install && pnpm build   # the harness imports the workspace's contracts
JOURNEY_REGISTRY=https://registry.npmjs.org/ node tests/journey/run.mjs
```

Run it on a Linux host with Docker once npm serves the release as `latest`
(`npm view @indx-workspace/create version`); `npm create @indx-workspace@latest` takes whatever
`latest` is. Add `--live` (with `ANTHROPIC_API_KEY`) for the real model. A value that is not an
`http(s)` URL, or that carries credentials, stops the run naming the variable. Unset or blank
keeps Verdaccio.
