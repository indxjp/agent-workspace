# ADR-0139 — Engines and cloud SDKs are optional peers of the local runtime

Status: accepted
Date: 2026-10-14
Decided by: issue #691 (FH-04, PR 2)
Scope: `packages/embedded/src/packaging/**`, `packages/sdk/src/project/dependencies.ts`, `packages/sdk/src/project/render.ts`, `packages/aw/src/commands/init.ts`, `packages/aw/src/commands/dev.ts`, `packages/aw/src/local-runtime/engine-packages.ts`, `packages/runtime/src/{kubernetes,gcp-auth}.ts`, `packages/cli/package.json`, `packages/cli/src/validate.ts`, `scripts/release/pack-packages.mjs`

## Context

`npm create @indx-workspace` installed 1248 MB in 583 packages (62,726 files) for a project that runs
one agent on one engine (0.6.7, measured on Windows, npm 11). `@indx-workspace/embedded` declared
every third-party package its bundle imports as a dependency: all four engines' SDKs (the Claude
Agent SDK alone carries a 237 MB native binary), the AWS, Azure and GCP SDKs of the KMS, object
storage and runtime drivers, and the Kubernetes client. A local project uses one engine and no
cloud. The bundle was one file, so ESM hoisted every external of a lazily initialised module to its
top: leaving a package out of the install made the runtime fail to start.

## Decision

- **The bundle splits at every `import()`** (`esbuild --splitting`, chunks under `dist/chunks/`).
  An engine adapter or cloud driver's imports stay in its own chunk and load only when a run or a
  profile reaches it.
- **The build classifies each external by when it loads.** Required: imported eagerly by a module
  a start reaches (the entry, what it `import()`s, and their eager imports), or imported in any way
  by the runtime's own `src/` (`embedded-postgres` is deferred for its exit hook, not optional).
  Everything else is on demand. Required packages stay `dependencies`; on-demand ones, with their
  required peers and pinned family, become exact-version optional `peerDependencies`. The rule is
  mechanical, so a new engine or driver needs no list edit.
- **The Kubernetes and Cloud Run drivers load their SDK on first use** (`@kubernetes/client-node`,
  `google-auth-library`), as the KMS and storage drivers already did. The ACA driver's
  `@azure/identity` stays a static import, so it stays a dependency (45 MB): `apps/web` bundles
  `packages/core`'s Azure blob store, and making that import lazy regroups Turbopack's chunks so
  Azurite's published development key moves out of the chunk `.trivyignore.yaml` excepts by path.
  Widening that exception to hash-named shared chunks would hide real findings.
- **A project names its engine's packages.** `ENGINE_PACKAGES` in `@indx-workspace/sdk/project`
  is the table; `npm create` writes the chosen engine's set into `package.json` and `aw init`
  prints it in its install line. The embedded build derives each engine's set from the imports
  under `packages/engine-<id>/` and fails (`engine_packages_drift`) on any difference, printing the
  table to paste, so the table cannot drift from what the bundle loads.
- **`aw dev` refuses an engine the project has not installed**, before it starts the runtime:
  `engine pi is not installed`, fixed by the one `npm install` line that adds the missing packages.
- **The CLI's bucket probes are optional peers too** (`@aws-sdk/client-s3`,
  `@google-cloud/storage`, caret ranges), loaded through one helper that turns a missing module into
  the install line.

## Alternatives considered

- **Separately published adapter packages** (`@indx-workspace/engine-openai-agents`), as #691
  first proposed. One install name per engine reads well, but it is four more packages to version,
  release and trust-publish, each re-bundling the engine port and contracts, for what an optional
  peer and one table already give. The install line names several packages for some engines; it is
  printed, never typed from memory.
- **`optionalDependencies`.** npm installs them by default; only a failed install is tolerated, so
  nothing would get lighter.
- **The default engine as a hard dependency.** It keeps the 237 MB Claude binary in every project,
  including those that chose another engine.

## Consequences

- The default install (`@indx-workspace/{aw,embedded,sdk}` with no engine) measured 550 MB in 176
  packages (25,559 files), down from 1248 MB in 583 (`npm create`: 1254 MB, 62,726 files). With an
  engine, add that engine's own tree (pi: +164 MB). `next` with `@next/swc-*` and `sharp` is now most of the rest; #691's
  "Not doing" keeps splitting Next out of scope here.
- An agent moved to another engine needs that engine's packages before `aw dev` runs it; the
  refusal says which.
- A deployment that selects a cloud driver installs that cloud's SDK itself, at the version the
  optional peer names.
