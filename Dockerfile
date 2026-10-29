# syntax=docker/dockerfile:1
#
# `agent-workspace/control-plane` — spec A.2's first image.
#
# A.2 says the project ships exactly two images, and that this one contains *"Next.js web, model
# gateway, runner manager"*. It has two build targets today, `web` and `runner`, because those are
# two of §33's five services and they are two processes rather than two images. The gateway is not
# a target here: nothing in `packages/gateway` serves anything yet, and a target that built an
# empty package would look like a shipped gateway. `compose.yaml` runs an unmistakable placeholder
# instead. When Wave 4 lands the real one, it becomes a third target in this file.
#
# The sandbox image is `runtime.Dockerfile`, and it is a separate file for the reason recorded in
# docs/adr/W1-INF-01-two-images-one-runner-server.md: the same §14.3 server ships in both, with a
# different posture, and the difference has to be visible rather than a flag.
#
# ## What this file does not do
#
# **Multi-architecture.** Every stage here is single-arch — whatever the host builds. Spec A.2
# makes `linux/arm64` mandatory for the runtime image (Bedrock AgentCore is Graviton-only and
# rejects `amd64` at deploy time), and `docker buildx` is W3-RT-05's task. Half-doing it here —
# a `--platform` argument that is not exercised by anything — would produce a file that claims a
# capability nobody has run. See ADR-0015.
#
# **`output: 'standalone'`.** Next.js can emit a self-contained server that needs no `node_modules`,
# which would cut this image substantially. Turning it on is a one-line edit to
# `apps/web/next.config.ts`, which is W1-UI-01's file and not this task's. Declared as a gap.

# Current release contract (the historical notes above describe the earlier two-image topology):
# this file is built only with an explicit `web` or `runner` target. The gateway is the explicit
# `gateway` target in gateway.Dockerfile and the sandbox is `runtime` in runtime.Dockerfile.
# infra/release/build-and-push.sh publishes all four for amd64/arm64 with SBOM and provenance.
ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

# pnpm for `npx` through `pnpm dlx` (ADR-0087 D1), installed by the final stage below. From pnpm 12
# a release is a native executable per platform, `@pnpm/exe.linux-<x64|arm64>` on the npm registry,
# so each architecture has its own checksum-verified tarball and the build's TARGETARCH picks one:
# only that stage is built, and the final stage bind-mounts its tarball rather than copying it into
# a layer. Bump PNPM_VERSION with `packageManager`, the `corepack prepare` lines and both SHA-256s
# together (`https://registry.npmjs.org/@pnpm/exe.linux-<arch>/-/exe.linux-<arch>-<version>.tgz`).
ARG PNPM_VERSION=12.15.0
ARG PNPM_SHA256_AMD64=402f7045b1e0587acb1542f18d38afbccb6babf3c7451394e6fb3d9f0160c6ca
ARG PNPM_SHA256_ARM64=8117d65f28e627e949d5fc65d63342266326826a56fa374317bf13fe1166a50e

FROM scratch AS pnpm-amd64
ARG PNPM_VERSION
ARG PNPM_SHA256_AMD64
ADD --checksum=sha256:${PNPM_SHA256_AMD64} \
    https://registry.npmjs.org/@pnpm/exe.linux-x64/-/exe.linux-x64-${PNPM_VERSION}.tgz /pnpm.tgz

FROM scratch AS pnpm-arm64
ARG PNPM_VERSION
ARG PNPM_SHA256_ARM64
ADD --checksum=sha256:${PNPM_SHA256_ARM64} \
    https://registry.npmjs.org/@pnpm/exe.linux-arm64/-/exe.linux-arm64-${PNPM_VERSION}.tgz /pnpm.tgz

FROM pnpm-${TARGETARCH} AS pnpm

# ── base ────────────────────────────────────────────────────────────────────────────────────────
# Debian `bookworm-slim`, not Alpine, and the reason is glibc. The Agent SDK resolves a
# platform-specific binary through its `optionalDependencies` — `@anthropic-ai/claude-agent-sdk-
# linux-x64` on glibc, `…-linux-x64-musl` on Alpine. Both exist, so both would install; only one
# of them is the build this task actually ran a Claude turn through, and a runtime that has never
# executed the binary it ships is a capability asserted rather than demonstrated. Node 24 is
# ADR-0006's floor and `engine-strict=true` in `.npmrc` makes `pnpm install` refuse anything older,
# so the tag is pinned to an exact patch rather than to `24`.
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1
RUN corepack enable && corepack prepare pnpm@12.15.0 --activate
WORKDIR /srv

# ── runtime-base ────────────────────────────────────────────────────────────────────────────────
# What the `web` and `runner` stages start from, and it carries no package manager (ADR-0087; the
# `runner` stage adds pnpm back for `npx` through `pnpm dlx`, below). The
# Node image ships npm (with its own bundled `tar`, `undici`, `brace-expansion` and `ip-address`),
# corepack and Yarn; no process in these images runs any of them, and each is a HIGH or CRITICAL
# finding for the release trivy gate whenever a bundled copy falls behind. `base` above keeps
# corepack and pnpm for the build stages only; nothing from it reaches an image. `apt-get upgrade`
# applies the Debian security fixes published since the pinned Node image was built.
FROM ${NODE_IMAGE} AS runtime-base
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules /opt/yarn-v* /root/.npm /root/.cache \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
             /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /srv

# ── deps ────────────────────────────────────────────────────────────────────────────────────────
# Manifests only, so that editing a source file does not re-resolve the dependency graph. Every
# workspace member's `package.json` is listed by name: a `COPY apps apps` here would pull the
# sources in and defeat the layer entirely, and a glob would silently stop covering a member added
# later without anyone noticing the cache had gone.
#
# `apps/web/server/auth/package.json` is in this list and is *not* a workspace member — it is the
# three-line `{"type":"module"}` marker W1-CP-06 needs (see its header). It is copied here so that
# the tree the install sees matches the tree the build sees.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json             apps/web/package.json
COPY apps/web/server/auth/package.json apps/web/server/auth/package.json
COPY apps/runner/package.json          apps/runner/package.json
COPY packages/contracts/package.json   packages/contracts/package.json
COPY packages/core/package.json        packages/core/package.json
# ENG-04 (#303): the Claude Agent SDK is declared by its adapter package, so the manifest that
# brings it (and its platform-specific native binary) into this install is this one.
COPY packages/engine/package.json      packages/engine/package.json
COPY packages/engine-claude-agent-sdk/package.json packages/engine-claude-agent-sdk/package.json
COPY packages/gateway/package.json     packages/gateway/package.json
COPY packages/platforms/package.json   packages/platforms/package.json
COPY packages/run-protocol/package.json packages/run-protocol/package.json
COPY packages/runtime/package.json     packages/runtime/package.json
COPY packages/sdk/package.json         packages/sdk/package.json
COPY packages/aw/package.json          packages/aw/package.json
# Filtered to the two processes this file builds and what they depend on: pnpm (11.28 and later)
# refuses a frozen install of the whole workspace when a lockfile importer's manifest was not
# copied (#373).
RUN pnpm install --frozen-lockfile --filter "@agent-workspace/web..." --filter "@agent-workspace/runner..."

# ── build ───────────────────────────────────────────────────────────────────────────────────────
# A filtered `pnpm build`, in topological order: `packages/core` emits `dist/`, `apps/runner`
# compiles against it, `apps/web` runs `next build`.
#
# Then the production tree. The earlier two-step prune (`pnpm install --prod`, then `pnpm prune
# --prod`) was not enough: it unlinked TypeScript, ESLint, Vitest, Tailwind and Drizzle Kit, but
# pnpm keeps an unlinked virtual-store entry until its `modules-cache-max-age` expires, so they
# stayed on disk (#373). Drizzle Kit mattering specifically: R-15 §3 and `pnpm-workspace.yaml`
# both record that it is the only route by which `esbuild` enters this tree, its install script is
# denied, and it must never reach a runtime image.
FROM deps AS build
COPY . .
RUN pnpm --filter "@agent-workspace/web..." --filter "@agent-workspace/runner..." build
# Every `node_modules` is deleted and the production tree installed again from the store this stage
# already holds (`--offline`), so nothing is left to orphan. The orphans were two `esbuild` builds
# and the TypeScript 7 native compiler, whose Go standard libraries trivy reported as HIGH and
# CRITICAL findings. `.next` is skipped: `next build` writes `.next/node_modules`, the links through
# which the server chunks load their external packages (`pg`, …), and it is build output, not an
# install; without it `next start` fails with ERR_MODULE_NOT_FOUND.
RUN find . -path '*/.next' -prune -o -name node_modules -type d -prune -exec rm -rf {} + \
    && pnpm install --frozen-lockfile --prod --offline --filter "@agent-workspace/web..." --filter "@agent-workspace/runner..."

# ── web ─────────────────────────────────────────────────────────────────────────────────────────
# §33's `web`: the Next.js control plane.
FROM runtime-base AS web
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="Agent Workspace web" \
      org.opencontainers.image.source="https://github.com/indxjp/agent-workspace" \
      org.opencontainers.image.revision="$VCS_REF"
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    MIGRATIONS_DIR=/srv/migrations
COPY --from=build --chown=node:node /srv /srv
# `workspace-data` is mounted over this path by Compose. Docker initialises a new named volume
# from the image's mountpoint, including its ownership, so the directory must exist as `node`
# before the first mount. Without this, Docker creates a root:root 0755 mountpoint and the web
# process cannot create `files`, `skills`, or `sessions`; transcript mirroring then fails with an
# opaque HTTP 500 and `EACCES: mkdir '/var/lib/agent-workspace/sessions'` in the container log.
RUN install -d -o node -g node \
    /var/lib/agent-workspace \
    /var/lib/agent-workspace/files \
    /var/lib/agent-workspace/skills \
    /var/lib/agent-workspace/sessions
WORKDIR /srv/apps/web
# The `node` user ships with the base image, uid 1000. Running as root would be the default and
# there is no reason for it: persistent writes land under the node-owned mountpoint above.
USER node
EXPOSE 3000
# Node 24 has `fetch`, so liveness needs no `curl` and no `wget` in the image. `/` is the home chat
# screen; a 200 from it means Next.js is serving, which is all a healthcheck should claim.
HEALTHCHECK --interval=10s --timeout=5s --start-period=40s --retries=12 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# Migrate, seed, then serve — in that order, `&&`-chained so that a failure at any step stops the
# container instead of starting a web server in front of a schema that is not there. Both steps are
# idempotent (`migrate` keeps a ledger and takes a Postgres advisory lock; `seed` is one transaction
# of `onConflictDoNothing`), so a restart re-runs them harmlessly. This is what makes §46's
# `docker compose up -d` true on a clean machine without a sixth service to run migrations, and it
# is correct for exactly one `web` replica — see
# docs/adr/W1-INF-01-migrations-run-in-the-web-entrypoint.md for the multi-replica consequence.
CMD ["sh", "-c", "node /srv/packages/core/dist/db/migrate.js && node /srv/packages/core/dist/db/seed.js && exec node /srv/apps/web/node_modules/next/dist/bin/next start"]

# ── runner ──────────────────────────────────────────────────────────────────────────────────────
# §33's `runner`: the §14.3 HTTP contract, serving runs through the `local` driver.
FROM runtime-base AS runner
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="Agent Workspace runner manager" \
      org.opencontainers.image.source="https://github.com/indxjp/agent-workspace" \
      org.opencontainers.image.revision="$VCS_REF"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8090
# The Docker driver invokes the CLI with an argument vector. Mounting the daemon socket supplies
# transport only; without the client binary every allocation fails with spawn docker ENOENT.
#
# Only the client, from Docker's static release, verified by checksum (#373). Debian's `docker.io`
# package also brought the daemon, containerd and runc, built with a Go toolchain long out of
# support, and the runner runs none of them. Bump the version and both checksums together, from
# https://download.docker.com/linux/static/stable/<x86_64|aarch64>/docker-<version>.tgz.
ARG DOCKER_CLI_VERSION=29.9.2
ARG DOCKER_CLI_SHA256_AMD64=9ac225999fd5e863f7694c728ef23d480616b1e5639328fa309befd4243d69eb
ARG DOCKER_CLI_SHA256_ARM64=873b3e0207857c3b2f28392fb922f3ea6efe37620c16d4d4aaf2fef409c90b73
ARG TARGETARCH
ADD --checksum=sha256:${DOCKER_CLI_SHA256_AMD64} \
    https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_CLI_VERSION}.tgz /tmp/docker-amd64.tgz
ADD --checksum=sha256:${DOCKER_CLI_SHA256_ARM64} \
    https://download.docker.com/linux/static/stable/aarch64/docker-${DOCKER_CLI_VERSION}.tgz /tmp/docker-arm64.tgz
RUN tar -xzf "/tmp/docker-${TARGETARCH}.tgz" -C /usr/local/bin --strip-components=1 docker/docker \
    && rm -f /tmp/docker-*.tgz \
    && docker --version
# `npx` through `pnpm dlx` (ADR-0087 D1). A `stdio` connector's documented command is `npx`, and
# this process launches connectors, so the image carries pnpm (the patched release's native
# executable, from the checksum-verified `pnpm` stage above) and `infra/images/npx.mjs` as `npx`.
# It still carries no npm and no corepack.
#
# Engines launch a connector with a replaced environment, often without PATH, and on a read-only
# root filesystem. So the wrappers name Node by absolute path, the shim needs no variable (it
# defaults PNPM_CLI and puts pnpm's directories under /tmp), and `npx` is also linked into
# /usr/bin, which is where a spawn with no PATH looks (libuv's default is /usr/bin:/bin).
COPY infra/images/npx.mjs infra/images/npx-run-bin.mjs /opt/npx/
RUN --mount=type=bind,from=pnpm,source=/pnpm.tgz,target=/tmp/pnpm.tgz \
    mkdir -p /opt/pnpm \
    && tar -xzf /tmp/pnpm.tgz -C /opt/pnpm --strip-components=1 --no-same-owner \
    && ln -s /opt/pnpm/pnpm /usr/local/bin/pnpm \
    && printf '#!/bin/sh\nexec /usr/local/bin/node /opt/npx/npx.mjs "$@"\n' > /usr/local/bin/npx \
    && chmod 0755 /usr/local/bin/npx \
    && ln -s /usr/local/bin/npx /usr/bin/npx \
    && pnpm --version
ENV PNPM_CLI=/opt/pnpm/pnpm
COPY --from=build --chown=node:node /srv /srv
# The same `/workspace` `runtime.Dockerfile` already creates, and for the same reason it gives
# there: it is the SDK's `cwd` for a run and the only path in the image the process writes to.
# This target did not have it, because nothing had ever sent this container a run — W1-COMP-01
# did, and `apps/web/server/compose/run-request.ts` composes the `cwd` as
# `${RUNNER_WORKSPACE_ROOT:-/workspace}/<workspace id>`, one directory per tenant (§25).
RUN mkdir -p /workspace && chown node:node /workspace
WORKDIR /srv/apps/runner
USER node
EXPOSE 8090
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8090)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# `apps/runner/src/index.ts` is a real entry point as of W1-COMP-01, so the inline `node -e`
# command this line used to carry is gone. That was W1-INF-01's declared smell and its record ends
# with the instruction this line follows: *"The correct end state is a two-line `index.ts` that
# imports `startRunnerServer` and calls it, `package.json`'s `start` script pointing at it, and
# both `CMD`s reduced to `[\"node\", \"dist/index.js\"]`. That is a small change, in one task's
# file, and the first task to touch `apps/runner/src/index.ts` should make it."* See
# docs/adr/W1-INF-01-the-runner-has-no-committed-entry-point.md and
# docs/adr/W1-COMP-01-the-runner-supplies-the-base-environment.md — the entry point does two
# things this command did not, and running a run through the old one is what found them.
CMD ["node", "dist/manager-start.js"]
