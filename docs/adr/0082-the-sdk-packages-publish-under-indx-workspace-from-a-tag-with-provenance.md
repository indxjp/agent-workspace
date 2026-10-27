# ADR-0082 — The SDK packages publish under @indx-workspace, from a tag, with provenance once the repository is public

Status: accepted
Superseded in part by: [ADR-0109](0109-the-local-runtime-publishes-as-one-bundled-package-that-aw-dev-runs-from-the-project.md) (four clauses of the amendment, for the bundled local runtime only: the rejection of publishing the server, the private clone-only `packages/embedded`, the generated project's "cli and nothing else" rule, now limited to `--cloud`, and the five-package list, now six)
Date: 2026-09-30
Decided by: the implementer of SDK migration unit 14 (issue #246), on the Owner's decisions of
2026-09-29 recorded on #246 and #332, and the Owner's decision of 2026-09-30 to publish without
provenance while the repository is internal (D5)
Scope: `packages/{contracts,sdk,aw}/package.json`; `packages/sdk/src/testing.ts`;
`scripts/release/{pack,publish}-packages.mjs`; `.github/workflows/publish-packages.yml`; CI heavy-checks;
every in-repo import of the three packages

## Context

P-1, P-2 and P-3 (issue #246) publish `contracts` and `sdk`, ship the SDK's test double as a public
subpath, and make `aw` installable. The packages were `"private": true` under the workspace names
`@agent-workspace/*` (ADR W0-INF-01 kept every member unpublished and said a publish is a new
decision; this is it for three members).

The `@agent-workspace` scope on npm belongs to a third party that already publishes six packages
there, including `@agent-workspace/cli`. The Owner created `@indx-workspace` instead and decided
that publishing authenticates with npm trusted publishing (GitHub Actions OIDC) with provenance,
with no long-lived `NPM_TOKEN`. On 2026-09-30 the Owner decided that, while this repository is
internal, the packages publish without provenance rather than wait for the repository to go
public (D5). Whether the internal workspace names are renamed or only the
published names change was left to this unit.

## Decision

### D1 — The three published packages take their npm names inside the workspace too

`packages/contracts`, `packages/sdk` and `packages/aw` are renamed to `@indx-workspace/contracts`,
`@indx-workspace/sdk` and `@indx-workspace/aw`, and every import, `--filter`, Nx project name,
alias, path mapping and document that names them follows, mechanically. Members that are not
published keep `@agent-workspace/*` and stay private.

Keeping the internal names and changing only the published ones was rejected because the name is
not only in the manifest. The compiled `dist/` of the SDK imports `@agent-workspace/contracts`, and
`aw`'s imports the SDK, so a publish-time rename would have to rewrite emitted JavaScript and
declaration files as well as manifests. A missed specifier would resolve, on a customer's machine,
to the third party's package. With one name everywhere, what is built is what is published, and
`scripts/release/pack-packages.mjs` refuses any tarball whose manifest or compiled `dist/` names
`@agent-workspace/*`.
Historical ADRs keep the names they were written with.

The project CLI (`packages/cli`, bins `agent-workspace` and `create-agent-workspace`) and the
`npm create` initializer are slice 0b of the developer platform (#332). They map to
`@indx-workspace/cli` and `@indx-workspace/create` (so the quickstart is
`npm create @indx-workspace@latest <dir>`), by the same rule, when that slice publishes them: add
the directory to `PUBLISHED_PACKAGES` and give it the manifest shape below. Until then
`packages/cli` keeps its name, and `release.yml` still references it.

### D2 — The manifest shape

`private` is removed. `files` is `dist` without source maps (their sources are not shipped) plus
`CHANGELOG.md`; npm adds `package.json`, `README.md` and `LICENSE`, a copy of the repository's
Apache-2.0 licence in each package. `publishConfig` makes the package public and points every
`types` condition at `dist/*.d.ts`: inside the workspace `types` stays on `src/*.ts` so
type-checking needs no build, and `pnpm pack` applies `publishConfig` and turns `workspace:*` into
the exact sibling version. `repository` names this repository and the package directory, which
provenance requires. `engines.node` is `>=24`, as at the root.

### D3 — Lock-step at the contracts version

All three carry `CONTRACTS_VERSION` and depend on each other at exactly that version, so an `aw`
or SDK of minor `x.y` is always a client of contracts `x.y` (ADR-0078's served range is stated in
those terms). `packages/aw/src/version.test.ts` pins the versions and pins
`AW_PUBLISHED_PACKAGE` to `packages/aw/package.json`'s name; the pack script refuses a tarball off
the version, and the workflow refuses a tag that does not name it.

### D4 — One command packs, verifies and smoke-tests; CI and the release both run it

`pnpm release:pack --smoke` packs the three with `pnpm pack`, refuses anything but `dist/` and the
manifests, a `workspace:` specifier, a sibling off lock-step, an entry point outside `dist/` or a
bin without a shebang, then installs the tarballs from `file:` into an empty project, imports every
subpath each manifest exports and every one the developer site imports, type-checks a strict
consumer of `@indx-workspace/sdk/testing` against the published declarations, and runs
`npx aw --version`. CI's heavy-checks runs it after the full build on every change, so a change
that breaks the published shape fails before a tag is ever pushed.

### D5 — The release workflow publishes from a `packages-v*` tag with trusted publishing

`.github/workflows/publish-packages.yml` runs on a `packages-v<version>` tag, a namespace apart from
the platform's `v*` release, in the `npm-publish` environment, with `id-token: write` and no
secret. It builds the three, runs D4 with the tag, and publishes contracts, then the SDK, then
`aw`, each with `npm publish --access public --provenance=<switch>`, through
`scripts/release/publish-packages.mjs`. The job first refuses a tag whose commit is not on `main`,
installs with `--ignore-scripts` (building the three needs no dependency install script), and
builds with the Nx Cloud cache off, so the bytes published are built from the tagged source in
that job. `setup-node` gets no `registry-url`, which would write an `.npmrc` expecting a token.

The script skips a version only when `npm view <name>@<version> version` prints exactly that
version, so a re-run completes a partial release; npm prints nothing, and can exit 0, for a
missing version of an existing package, so neither the exit status nor the output alone is
trusted. After the loop it fails unless npm serves all three at the version.

npm registers a trusted publisher per existing package, so each package's first version is
published by hand by the Owner (or a placeholder is), after which the trusted publisher is
configured on npmjs.com and every later version comes from the workflow.

**Provenance is one switch, off while the repository is internal (Owner decision, 2026-09-30).**
npm's registry accepts a provenance bundle only from a public source repository, and it refuses one
after the CLI has already signed it into the public Sigstore transparency log, which would publish
the internal repository's name, workflow and commit. Rather than block the first release on the
repository going public, the Owner decided to publish without provenance for now, keeping trusted
publishing. The workflow's `NPM_PROVENANCE` environment variable is `'false'`, which passes
`--provenance=false`; setting it to `'true'` when the repository becomes public is the whole change,
and the script refuses `'true'` on a non-public repository before anything is signed. Until then a
consumer can trust the packages by their npm scope and trusted publisher, not by a provenance
attestation.

### D6 — The testing subpath is the SDK's own double

`src/testing.ts` is no longer excluded from the build: it is `@indx-workspace/sdk/testing`. It keeps
the double the SDK's suites use (`fetchDouble`, the response builders, `drain`) and adds
`fixtures.agent`, `fixtures.run` and `fixtures.session`, which fill every required field, apply
overrides last and parse the result with the contracts schema. It depends on no test runner.
`packages/aw/src/testing.ts` stays internal.

## Consequences

- `npm install @indx-workspace/sdk` and `npx @indx-workspace/aw` work from the first
  `packages-v0.1.0` release; the developer site documents that path, not "build it yourself".
- Open pull requests that import `@agent-workspace/{contracts,sdk,aw}` must rename on rebase; the
  rename is a mechanical search and replace.
- Versions published before the switch is turned on carry no provenance attestation, and cannot be
  given one later; only versions published after the repository is public have it.
- A package never republishes a version. A fix is a new patch version, and a change to the
  contracts version moves all three.

## Amendment — the project CLI and `npm create` (issue #364, 2026-09-30)

Slice 0b applies D1–D5 to `packages/cli` and a new `packages/create`, as D1 anticipated:

- `packages/cli` is renamed `@indx-workspace/cli` (bins `create-agent-workspace` and
  `agent-workspace`, subpath `./create`) and `packages/create` is `@indx-workspace/create`, whose one
  bin runs the CLI's generator, so `npm create @indx-workspace@latest <dir>` works. Both take the D2
  manifest shape (the CLI also ships `templates/`), are lock-step at `CONTRACTS_VERSION` (D3), and
  join `PUBLISHED_PACKAGES` in publish order contracts, sdk, aw, cli, create. `CLI_PUBLISHED_PACKAGE`
  is pinned to the manifest name by a test, like `AW_PUBLISHED_PACKAGE`.
- **The published CLI depends on the SDK and the contracts only.** It imported the server
  (`core`, `gateway`, `runner`, `runtime`, `web`), which is private and keeps the third party's
  scope, so its `dist/` would have named that scope. Publishing the server, or bundling it into the
  CLI, was rejected: the server is not a library and ships as images. (Superseded in part by
  ADR-0109: the local runtime alone publishes as one bundled package, `@indx-workspace/embedded`,
  that `aw dev` forks from the project's dependencies; bundling into the CLI stays rejected, and
  `packages/embedded` is no longer private.) Instead the development-only embedded workspace
  (`start --embedded`, embedded PostgreSQL) moves to the private `packages/embedded` and runs from a
  clone as `pnpm start:embedded`; the published `start` runs the generated Compose project only and
  refuses `--embedded` with that command. Host-capability detection moves from `packages/runtime`
  into the CLI (its only callers); the GCS bucket probe asks `@google-cloud/storage` directly
  instead of `packages/core`; and the CLI restates two runtime facts (`RuntimeDriverId`, the Claude
  engine's image variable), which `packages/embedded/src/runtime-pins.test.ts` holds equal to the
  runtime's. `dependency-cruiser` enforces `cli-depends-only-on-sdk-and-contracts` and
  `create-depends-only-on-cli`.
- A generated `local` project depends on `@indx-workspace/cli` at the generator's own version and on
  nothing else (since ADR-0109, only the v1 project of `create --cloud local`); the pack check also
  scans `templates/`, and the smoke runs `npx agent-workspace --help` and
  `npm create @indx-workspace` offline against the tarballs.
- `publish-packages.yml` builds and publishes all five, and `publish-packages.mjs` refuses a tarball
  list that is not exactly the five in order at one version (six since ADR-0109, with `embedded`
  before `create`). `release.yml` no longer publishes the CLI with a token.

## Amendment — `@indx-workspace/react` (issue #623, 2026-10-04)

`packages/react` (`@indx-workspace/react`: `Chat` and `useConversation`) joins `PUBLISHED_PACKAGES`
right after `sdk`, so the list is seven — contracts, sdk, react, aw, cli, embedded, create — under
D1–D5 unchanged: the D2 manifest shape, lock-step at `CONTRACTS_VERSION` (D3), dependencies
contracts, sdk and zod only (`react-depends-only-on-sdk-and-contracts`), and `react` a peer
dependency; its first version is an Owner-published placeholder, as D5 requires for a new name.

## Amendment — publish from the public repository, with provenance (2026-10-26)

Owner decision, 2026-10-26: the releases run in the public repository `indxjp/agent-workspace`,
on free GitHub-hosted runners, not in the development repository. Every job of
`publish-packages.yml` starts with `if: github.repository == 'indxjp/agent-workspace'` and runs on
`ubuntu-latest`; `scripts/check-workflows.mjs` requires the guard. The `packages-v<version>` tag is
pushed to the public repository on the snapshot commit of the release (docs/release/README.md,
"Where releases run").

D5's provenance switch is now `'true'`: npm accepts a provenance bundle from a public repository,
so each tarball records the public repository, the workflow and the commit. The trusted publisher
of every package names `indxjp/agent-workspace`, `publish-packages.yml` and `npm-publish`; the
Owner moves each one on npmjs.com and creates the `npm-publish` environment in the public
repository before the first release from there. Until then the publish job is refused by npm and
publishes nothing, which is the intended failure.
