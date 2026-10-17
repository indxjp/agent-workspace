# ADR-0087 — The release images carry no npm, serve `npx` through `pnpm dlx`, and every pull request runs the release trivy gate

Status: accepted
Date: 2026-09-30
Decided by: the implementer of developer-platform slice 0e (issue #373), on the Owner's approval of
the infrastructure changes that make the platform images pass the release trivy gate, and the
Owner's decision of 2026-09-30 to keep `npx` connectors working through `pnpm dlx` (D1)
Scope: `Dockerfile`; `gateway.Dockerfile`; `runtime.Dockerfile`; `infra/images/{npx,npx-run-bin}.mjs`;
`infra/release/{trivy-gate,scan-images,build-and-push}.sh`;
`.github/workflows/ci.yml` (`image-scan`, `ci-success`); `scripts/check-workflows.mjs`;
`package.json` (`packageManager`); `docs/release/README.md`

## Context

The first image release, `images-v0.1.0` (run 36671864808), was stopped by the trivy gate
ADR-0086 D3 put in `infra/release/build-and-push.sh`, as designed: no tag was added. It scanned
only `web` (the script stops at the first failing image), and found, all fixable:

- the npm that the Node base image ships, with its bundled `tar`, `undici`, `brace-expansion` and
  `ip-address`;
- corepack's cached pnpm 11.9.0 (CVE-2026-82392, CVE-2026-82393, GHSA-vx52-2968-3vc6) and its
  bundled `tar` and `undici`, because the `web` and `runner` stages started from the build base;
- `libpcre2-8-0` in Debian 12.15;
- three Go binaries: two `esbuild` builds (Go 1.20.7 and 1.23.12) and the TypeScript 7 native
  compiler (Go 1.26.4, `golang.org/x/text` 0.38.0). None was referenced: `pnpm prune --prod` had
  unlinked them, but pnpm keeps an unlinked virtual-store entry until `modules-cache-max-age`
  expires, so they were still on disk;
- the Azure Storage emulator's well-known account key, which Next.js bundles into a server chunk
  from `@azure/storage-blob` (see D4).

The `runner` image, not reached by that run, also installed Debian's `docker.io`: the daemon,
containerd and runc, built with Go releases long out of support, of which the runner uses only the
client.

The gate ran only on a tag, so the first time anyone saw these findings was the release itself.

## Decision

### D1 — No npm and no corepack in a final stage; `npx` is served by `pnpm dlx`

Every image's final stage deletes npm, npx, corepack and Yarn (`/usr/local/lib/node_modules`,
`/opt/yarn-v*` and their `/usr/local/bin` entries) and starts from the pinned Node image, never
from the build base that prepared pnpm through corepack. npm stays absent because it cannot be
shipped clean: the release trivy gate showed that even the newest npm (12.1.0 on 2026-09-30)
bundles a `brace-expansion` and an `undici` with fixable HIGH findings, and npm's bundled tree is
not ours to patch. corepack is only a downloader for package managers, and nothing needs it at
run time.

`npx` is still what connectors use: it is the documented `command` of a `stdio` connector (spec
§8, the connectors guide), and the processes that launch connectors are the `runner` image (the
`local` driver runs engines in process) and every `runtime-<engine>` image. Those final stages
therefore install pnpm, at the `packageManager` version (11.28.2, patched), from its npm-registry
tarball verified by SHA-256 (no npm, no corepack), and put `infra/images/npx.mjs` on `PATH` as
`npx`. The shim maps `npx [-y|--yes] [-p|--package <pkg>]… [--] <pkg-or-cmd>[@version] [args…]`
onto `pnpm dlx --package <pkg>… node npx-run-bin.mjs --package <pkg>|--command <cmd> -- [args…]`.
It passes every argument after the command through untouched, inherits stdio (an MCP stdio server
talks through those pipes), forwards signals and the exit status, and refuses any other npx option
with exit status 2 and a message naming this ADR, rather than guessing at a meaning `pnpm dlx`
does not have.

The shim is built for the environment a connector is really launched in, not the image's:

- **A replaced environment.** Every engine launches a `stdio` connector with an environment it
  composes, not `process.env` (the runner's base environment is empty; the Mastra adapter sets
  `inheritDefaultEnv: false`; the Claude Agent SDK replaces `env`). So the shim reads nothing it
  needs from the environment: pnpm defaults to `/opt/pnpm/bin/pnpm.cjs`, the wrappers name
  `/usr/local/bin/node` by absolute path, the child gets a `PATH` when it has none, and `npx` is
  also linked into `/usr/bin`, where a spawn with no `PATH` looks.
- **A read-only root filesystem.** The Docker driver (`--read-only`, a tmpfs on `/tmp`),
  Kubernetes (`readOnlyRootFilesystem`) and the generated Compose runner (`read_only: true`)
  leave only `/tmp` and `/workspace` writable. For each `XDG_CACHE_HOME`, `XDG_DATA_HOME`,
  `XDG_STATE_HOME` and `XDG_CONFIG_HOME` the caller did not set, the shim points pnpm under
  `/tmp/pnpm`, so the cache and the store never touch the home directory.
- **A `noexec` `/tmp`.** Docker mounts that tmpfs `noexec`, so nothing in the dlx cache can be
  executed, and `pnpm dlx` executing a package's bin fails with EACCES. The shim therefore makes
  `pnpm dlx` run `node infra/images/npx-run-bin.mjs`, which resolves the package and its bin the
  way `pnpm dlx` itself does, and hands pnpm's bin script (a POSIX shell script that sets
  `NODE_PATH` and `exec`s `node <entry point>`) to `/bin/sh` to read, rather than executing it.
  The package is the first dependency of the dlx project's `package.json` (pnpm's `getPkgName`),
  so every spec form pnpm installs resolves: `name@range`, `alias@npm:name`, `github:org/repo`, a
  directory and a tarball URL. A relative directory (`./dir`, `../dir`, and any `file:` location
  that is not absolute, `file:dir` included) is made absolute against the working directory
  before pnpm sees it, because `pnpm dlx` installs from its own cache directory, where a relative
  path names nothing. Its bin is its only one, else the one named after the package without its
  scope, read from `bin` or, when there is none, from the files under `directories.bin` (pnpm's
  `getBinsFromPackageManifest`). pnpm checks a bin's path only lexically, so it still links a `bin`
  file or a `directories.bin` whose symbolic link leads out of the package; the shim judges real
  paths and refuses to run such a bin. In the `-p` form a command containing a `/` is a path run
  relative to the working directory, never looked up in `.bin`, and a command of `.` or `..` is
  refused. Built from the runtime stage's `npx` layers and run `--read-only` with a
  `noexec` `/tmp`, as uid 1000 and under `env -i`, `npx` ran a registry package, an alias, a
  tarball URL and a relative directory with `directories.bin` (#376). Two things still cannot run
  from a `noexec` cache: a bin that is itself a native binary, and a native addon (`.node`), which
  `dlopen` refuses to map from a `noexec` mount. Kubernetes' `emptyDir` is not mounted `noexec`.

Differences from npm's `npx` remain, by design:

- `pnpm dlx` allows the build of the package it was asked for when that package is named from the
  registry (`name@range`; pnpm adds the name to `allowBuilds`), so its own install scripts run.
  Its dependencies' install (build) scripts, and those of a package named by an alias, a git host,
  a directory or a tarball, are skipped. A connector package that relies on such a step (a
  dependency that builds a native addon or downloads a binary) does not get it.
- `pnpm dlx` reads the working directory's configuration: its `.npmrc` (a registry, for example)
  applies, as it does for npm. A `packageManager` field there does not switch pnpm: `dlx` is one of
  the commands pnpm 11 runs without its package-manager check or version switch
  (`skipPackageManagerCheck`), so dlx runs this image's pnpm. In the built image, with `pnpm@9.0.0`
  pinned in the working directory, a `-p` command reports `pnpm/11.28.2` as its user agent. The
  shim passes no setting for this; the `--config.manage-package-manager-versions=false` it first
  passed named a setting pnpm 11 does not have, and was dropped (#376). This relies on pnpm
  keeping `dlx` in that set; no automated test holds it (the shim tests do not run a real pnpm, and
  the release has no image smoke test for `npx`), so a pnpm bump must re-check it by hand: in the
  built image, a `-p` command in a directory pinning another pnpm must still report this pnpm.
- The dlx cache is shared. Every `npx` the shim serves caches under `/tmp/pnpm` unless the caller
  set the `XDG_*` directories. In the `runner` image the `local` driver runs every session's
  engine in one container as one uid, so sessions share that cache: a package one session
  installed is reused by the next within pnpm's `dlx-cache-max-age`, and a session that can write
  `/tmp` can alter what another session's `npx` runs. npm's `~/.npm/_npx` had the same exposure;
  the `local` driver is not an isolation boundary (the Docker and Kubernetes drivers give each
  session its own `/tmp`).
- `/tmp` is small. The Docker driver's tmpfs and the Kubernetes `emptyDir` are 256 MB
  (`packages/runtime/src/{docker,kubernetes}.ts`), and the dlx store and cache share them with
  everything else a session writes there. A connector with a large dependency tree can fail its
  install with ENOSPC; the connector then fails to start with pnpm's message.

pnpm's bundled tree is small and current (`tar` 7.5.22, `undici` 6.28.1 in 11.28.2), and the images
that carry it pass the same trivy gate as every other image, so a pnpm that falls behind fails
`image-scan` like any other finding. `web` and `gateway` launch no connector (ADR-0045) and carry
no pnpm.

Why `pnpm dlx` rather than a patched npm: pnpm is already the repository's package manager at a
version the gate covers, its release fixes its own bundled dependencies, and one version is
pinned in one place (`packageManager`, which a test holds the Dockerfiles to).

### D2 — A fresh production install, not a prune

Each build stage deletes every `node_modules` after building and installs the production tree
again with `pnpm install --frozen-lockfile --prod --offline` from the store the stage already
holds. Nothing can be orphaned in a tree that was never pruned. The root `Dockerfile`'s install and
build are filtered to `@agent-workspace/web...` and `@agent-workspace/runner...` like the other two
files, because pnpm 11.28 refuses an unfiltered frozen install when a lockfile importer's manifest
was not copied.

### D3 — A patched base, upgraded at build time, and only the Docker client

The Node base moves to `node:24.21.0-bookworm-slim`, pinned by its index digest. Each final stage
runs `apt-get upgrade`, so a rebuild applies the Debian security fixes published since that image
was built. The `runner` image takes only the `docker` client, from Docker's static release,
verified by SHA-256 per architecture, instead of `docker.io`.

### D4 — One gate script, run on every pull request

`infra/release/trivy-gate.sh` is the only place the gate's flags are written: `--severity
HIGH,CRITICAL --ignore-unfixed --exit-code 1`, plus `--ignorefile .trivyignore.yaml`.
`build-and-push.sh` calls it for every platform of every digest. CI's `image-scan` job
(`infra/release/scan-images.sh`) builds every image of the release plan for `linux/amd64` and
calls the same script, with the trivy version `images.yml` uses; `ci-success` requires the job, and
`scripts/check-workflows.mjs` requires `ci-success` to need it. It continues past a failing image,
so one run lists every finding.

`.trivyignore.yaml` holds only findings proven not to apply, each with a statement and an
`expired_at`, after which trivy stops honouring it. It has one entry: the secret rule
`azure-storage-account-key`, scoped to the Next.js server chunks and source maps of the core
storage module. The value is `devstoreaccount1`'s key, which Microsoft publishes for the Azurite
emulator and which grants nothing outside a local emulator. The expiry forces the question again.

### D5 — pnpm 11.28.2

`packageManager` moves from pnpm 11.9.0 to 11.28.2 (fixed in 11.11.0: CVE-2026-82392,
CVE-2026-82393, GHSA-vx52-2968-3vc6). The lockfile format is unchanged. CI's `pnpm/action-setup`
reads the version from `packageManager`, and the three Dockerfiles prepare the same version with
corepack in their build stages; the `runner` and runtime final stages install the same version
from its tarball for `npx` (D1).

## Consequences

- A pull request that adds a fixable HIGH or CRITICAL finding to any image fails `image-scan`,
  before a tag. A newly published advisory can also turn `image-scan` red on a pull request that
  did not cause it; the fix is the same one the release would need, so the gate is not relaxed
  for that case.
- `image-scan` builds seven images on every pull request, on its own 16 vCPU runner beside the other
  gates.
- `npx`-based `stdio` connectors keep working in the `runner` and runtime images, through `pnpm
  dlx` (D1). An npx option other than `-y`/`--yes`, `-p`/`--package` and `--` fails loudly with
  exit status 2. Bumping pnpm is one change across several pins, which
  `tests/release/platform-images.test.ts` holds together: `packageManager` in `package.json`, the
  `corepack prepare pnpm@<version>` line of each of the three Dockerfiles' build stages, and
  `PNPM_VERSION` with its tarball SHA-256 in `Dockerfile` and `runtime.Dockerfile`.
- `images-v0.1.0` can be cut again from the fixed commit: no `<name>:0.1.0` tag exists, so D6 of
  ADR-0086 treats every image as absent. The untagged digests the failed run pushed are never
  referenced by a tag or a manifest.
- Bumping the Docker client is one edit of the version and both checksums in `Dockerfile`.
