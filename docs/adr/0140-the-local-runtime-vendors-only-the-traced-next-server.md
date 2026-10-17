# ADR-0140 — The local runtime vendors only the traced Next server

Status: accepted
Date: 2026-10-14
Decided by: issue #691 (FH-04, follow-up to ADR-0139)
Scope: `packages/embedded/src/packaging/vendor-next.ts`, `packages/embedded/src/packaging/next-build.ts`, `packages/embedded/src/packaging/main.ts`, `packages/embedded/src/next-config.ts`, `packages/embedded/src/launch.ts`

## Context

After ADR-0139 the base install of `@indx-workspace/embedded` was 550 MB in 25,559 files, and
317 MB of it was the web server's packages: `next` (196 MB), `@next/swc-*` (102 MB) and
`@img/sharp-*` (19 MB). The last two are optional dependencies of `next` that npm installs by
default: a build-time compiler and an image optimiser. The runtime only serves a finished
production build (`dist/web`) and the app does not use `next/image`. Next's own build traces
(`*.nft.json`) list what a production server reads, which is a small part of the `next` package.

## Decision

- **The build vendors the traced files of `next`, `react` and `react-dom` into
  `dist/node_modules/`**, and the published manifest no longer depends on them. A file is vendored
  when Next's build traces list it (`next-server.js` and every server page) or an nft trace of
  `next/dist/server/next.js` reaches it. That file is the programmatic entry `startWeb` imports.
  It must also belong to the dependency closure of those three packages (`dependencies` and
  required peers, never `optionalDependencies`). Source maps and Next's `*.runtime.dev.js`
  runtimes are left out: a `dev: false` server never reads them. The chunks under `dist/chunks/`
  resolve `next` from `dist/node_modules/` with Node's own lookup, with no path rewriting.
- **`@next/swc-*` and `sharp` are not shipped.** They are optional dependencies, outside the
  closure. They are also native binaries of one platform, so shipping the build machine's copy
  would break every other platform. A future `next/image` use needs this decision revisited.
- **The runtime hands Next the resolved config of its build.** `next/dist/server/config.js` loads
  a webpack hook from files the trace does not include, unless
  `__NEXT_PRIVATE_STANDALONE_CONFIG` holds the config. Next's own standalone server sets that
  variable from `required-server-files.json`, and `runLocalRuntime` does the same. With it set,
  Next does not read `dist/web/next.config.mjs` at all.
- **One version per vendored package.** The build fails (`external_version_conflict`) when the
  closure needs one package at two versions, since `dist/node_modules` holds one copy.

## The private contract, and what guards it

`__NEXT_PRIVATE_STANDALONE_CONFIG` and the `config` field of `required-server-files.json` are
Next internals, not public API, so a Next upgrade can change them. Three checks fail if one does:

- `src/bundle.test.ts` starts `next()` on `dist/web` in a child process that resolves `next` from
  a bundle chunk. It requires that resolution to land in `dist/node_modules`, a static asset to
  answer 200, and `/signin` to render HTML.
- `src/local-launcher.integration.test.ts` forks the built `dist/bin.js` with the embedded
  PostgreSQL and runs agents through it.
- The release boot smoke (`node scripts/release/pack-packages.mjs --smoke`, CI's heavy checks)
  installs the packed tarball into a fresh consumer, forks its `./launch` export and requires
  `GET /api/me` to answer 200.

The vendored files are also scanned for the private workspace scope, like the bundle.

## Consequences

- Base install, Windows, npm 11, `--ignore-scripts`: 550 MB / 25,559 files / 176 packages before,
  255 MB / 17,389 files / 157 packages after. The tarball grows by about 1,950 files and 36 MB
  unpacked, which `npm install` extracts instead of resolving and downloading ~300 MB.
- A Dependabot bump of `next` or `react` needs nothing more: the build re-traces every time.
- A dynamic `require` the trace cannot see would surface as a missing module at run time. The
  three checks above exercise the paths the local runtime uses.

## Alternatives considered

- **`output: 'standalone'`** copies the same traced files, but under a monorepo layout with its own
  `server.js`, and needs `apps/web/next.config.ts` to change. Reading the traces the build already
  writes keeps `apps/web` untouched.
- **Keep `next` as a dependency**: leaves 317 MB, well over half of the base install.
