# syntax=docker/dockerfile:1
#
# `agent-workspace/runtime` — spec A.2's second image: *"Node, Claude Agent SDK, the HTTP contract
# in section 14.3"*.
#
# This is the **sandbox** image. It is what the `docker` and `kubernetes` drivers of §14.4 launch,
# one container per run or per session, and it is not a `compose.yaml` service: spec A.4 is explicit
# that runtimes are *"created on demand by the docker driver, not declared in compose"*. Wave 1 has
# no `docker` driver — `apps/runner` serves §14.3 with the `local` driver in its own process — so
# nothing in this repository launches this image yet. It is built and health-checked in this task's
# acceptance run so that it is a thing that works rather than a file that compiles.
#
# ## Why this is a separate file from `Dockerfile`
#
# Both images run the same server, `apps/runner/dist/server.js`. They are separate images because
# they have opposite postures, and a posture expressed as a runtime flag is a posture one
# environment variable away from being wrong:
#
# | | `Dockerfile` target `runner` | this file |
# | --- | --- | --- |
# | What it is | §33's long-lived `runner` service | one throwaway sandbox per run |
# | Contains | the whole workspace, including `apps/web` | the runner and `packages/core` only |
# | Working directory | the repository | `/workspace`, empty and writable |
# | Credentials | none | none — A.2, and A.11 injects a per-run gateway token |
#
# See docs/adr/W1-INF-01-two-images-one-runner-server.md.
#
# ## What this file does not do
#
# **Multi-architecture — proven, not carried.** A.2 makes `linux/arm64` mandatory for *this* image
# specifically, because Bedrock AgentCore Runtime is Graviton-only and rejects an `amd64` image at
# deploy time. Nothing in this Dockerfile is arch-specific — no `ARG TARGETARCH` branch, no
# architecture-conditional package — so the mandate is satisfied by the build invocation, not by a
# change to this file:
#
#     docker buildx build --platform linux/amd64,linux/arm64 --provenance=false \
#       -f runtime.Dockerfile --output type=image,name=<registry>/<repo>:<tag>,push=true .
#
# Run against this exact file, on this commit:
#
#     $ docker buildx build --builder w3rt05-builder --platform linux/amd64,linux/arm64 \
#         --provenance=false -f runtime.Dockerfile \
#         --output type=image,name=localhost:5449/w3rt05-runtime:test,push=true,registry.insecure=true .
#     ...
#     #50 pushing manifest for localhost:5449/w3rt05-runtime:test@sha256:8f18019f...
#     #50 DONE 8.5s
#     $ docker buildx imagetools inspect localhost:5449/w3rt05-runtime:test
#     Platform:  linux/amd64
#     Platform:  linux/arm64
#
# Publishing that image to a real, non-local cloud registry (as opposed to the local one above) is
# out of scope for this task — a declared gap, not a limitation of this file.
#
# **Tools for the agent.** No `git`, no `ripgrep`, no compilers. The image is the §14.3 server and
# nothing else; what an agent is allowed to reach for is a runtime-profile question (§15) and the
# sandbox's tool surface belongs to Wave 3. Declared as a gap rather than guessed at here.
#
# ## One image per engine (ENG-07, #306)
#
# `ARG ENGINE` selects which adapter this image carries, and it carries **exactly one**: the image
# is published as `agent-workspace/runtime-<engine>` and holds the engine-neutral runner,
# `packages/engine`'s port and `packages/engine-<engine>`. See
# docs/adr/0073-one-runtime-image-per-engine.md.
#
# The selection mechanism is the one this file already documents below: pnpm's `--filter
# "@agent-workspace/runner..."` walks the workspace graph, so an adapter reaches the production
# `node_modules` only if its manifest was copied into the build stage. Copying one engine's
# manifest is the same lever the `deps` comment describes, with the engine as a parameter.
#
# **The runner depends on no adapter (ENG-09, #308; ADR-0074 "images").** ADR-0073 left one open
# item: `apps/runner/package.json` listed the Claude adapter as a production dependency, so a second
# engine's build would fail at `pnpm install` on a workspace package it did not copy. The runner's
# manifest now names no adapter. The selected adapter enters the install through its **own**
# filter (`--filter "@agent-workspace/engine-${ENGINE}..."`), which also brings its SDK's tree, and
# the `adapter link` step below links it into the runner's `node_modules`, where
# `apps/runner/src/engines.ts`'s literal `import()` resolves it. The runner's emit build
# type-checks the registry's imports against `apps/runner/types/engine-modules.d.ts`, so the
# adapters this image does not carry never have to be present.
#
# `ENGINE_VERSION` exists so the image can *say* what it carries in its labels. It is **verified
# against the copied manifests during the build** (the `label check` step below) rather than trusted:
# a label is the only thing an operator can read off a pulled image, and a label that was merely
# passed in is a claim nothing checks. The defaults are the Claude engine's, so the acceptance
# command
#
#     docker build --build-arg ENGINE=claude-agent-sdk -f runtime.Dockerfile .
#
# needs no other argument; `node scripts/engine-images.mjs --json` prints the full argument set for
# every engine and is what CI and `infra/release/build-and-push.sh` use.
#
# `NODE_IMAGE` stays glibc bookworm for `claude-agent-sdk`, and ADR-0073 D4 is the rule for the next
# engine: the Claude Agent SDK ships a platform-specific native CLI binary through its
# `optionalDependencies` and musl is not one of the platforms it publishes, so an engine whose SDK
# has no native binary **may** select a smaller base and every other engine may not. Which base an
# image used is read off the image itself rather than from a comment here.
#
# `NODE_IMAGE` is pinned by digest, as the root `Dockerfile` and `gateway.Dockerfile` are: the
# digest is the multi-arch index of the `node:24.22.1-bookworm-slim` tag (#373 moved it from
# 24.19.0, whose base failed the release trivy gate; 24.22.1 is the October 2026 security release,
# which also distrusts the compromised eMudhra intermediates).
#
# **No npm and no corepack in the image (ADR-0087).** The `runtime` stage deletes npm, npx,
# corepack and Yarn: their bundled dependencies are HIGH or CRITICAL trivy findings whenever they
# fall behind, and even the newest npm bundles vulnerable ones. `npx` stays available for `stdio`
# connectors, served by `pnpm dlx`: the stage installs the patched pnpm and the
# `infra/images/npx.mjs` shim, which the release trivy gate scans like everything else.

ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ARG ENGINE=claude-agent-sdk
ARG ENGINE_VERSION=0.0.0+0.3.310

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1
RUN corepack enable && corepack prepare pnpm@11.28.8 --activate
WORKDIR /srv

# ── build ───────────────────────────────────────────────────────────────────────────────────────
# `--filter @agent-workspace/runner...` — the runner and everything it depends on, and nothing
# else. The trailing `...` is pnpm's "and its dependencies" suffix. That is what keeps Next.js,
# React and Tailwind out of a sandbox image: they are never installed here, rather than installed
# and then deleted, which would leave them in a lower layer for anyone who pulls it.
FROM base AS build
ARG ENGINE
ARG ENGINE_VERSION
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# The root `tsconfig.json` is not optional here even though this file compiles nothing at the
# root: every member's `tsconfig.json` says `"extends": "../../tsconfig.json"`, so leaving it out
# does not fail loudly — `tsc` silently falls back to its own defaults, and `packages/core` then
# fails with six unrelated-looking errors about ES6 regular-expression flags and `import.meta`.
# That is exactly the ADR-0015 shape and it cost one build to find, so it is written down here.
COPY tsconfig.json              tsconfig.json
COPY apps/runner/package.json      apps/runner/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/core/package.json    packages/core/package.json
# ENG-04 (#303): the Claude Agent SDK is a dependency of its **adapter** package, not of
# `apps/runner`. `--filter "@agent-workspace/runner..."` follows the workspace graph, so the SDK
# and its platform-specific native binary still reach this image's production `node_modules` —
# but only because the adapter's manifest is copied here. Leaving it out makes the install
# succeed and the runtime fail at its first `/run` with `engine_not_installed`, which is the
# honest answer to an image that really does not carry the engine and the wrong answer to this one.
COPY packages/engine/package.json  packages/engine/package.json
# ENG-07 (#306): one engine's manifest, chosen by `ENGINE`. The adapter package directory is
# `packages/engine-<id>` by construction — `scripts/engine-images.mjs` derives the engine list from
# exactly that naming and a unit test holds it to `ENGINE_IDS`, so there is no second table here to
# fall out of step with the contracts.
COPY packages/engine-${ENGINE}/package.json packages/engine-${ENGINE}/package.json
COPY packages/run-protocol/package.json packages/run-protocol/package.json
COPY packages/runtime/package.json packages/runtime/package.json
RUN pnpm install --frozen-lockfile --filter "@agent-workspace/runner..." --filter "@agent-workspace/engine-${ENGINE}..."
COPY packages/contracts packages/contracts
COPY packages/core    packages/core
COPY packages/engine  packages/engine
COPY packages/engine-${ENGINE} packages/engine-${ENGINE}
COPY packages/run-protocol packages/run-protocol
COPY packages/runtime packages/runtime
COPY apps/runner      apps/runner
RUN pnpm --filter "@agent-workspace/runner..." --filter "@agent-workspace/engine-${ENGINE}..." build
# label check — the label values are *derived from the manifests that were actually copied* and
# compared against the build arguments, so a build that would mislabel its own contents fails here
# instead of publishing a lie. `<adapter>+<sdk>`: the adapter package's own version and the
# third-party SDK it was built against, because both move independently and neither answers "which
# SDK is in production?" alone. `node scripts/engine-images.mjs` prints the right arguments.
COPY scripts/engine-images.mjs scripts/engine-images.mjs
RUN node scripts/engine-images.mjs --verify-label "${ENGINE}" "${ENGINE_VERSION}"
# The production tree. `pnpm install --prod` re-links each package's own `node_modules` without its
# `devDependencies` but leaves the virtual store `node_modules/.pnpm` as it was, and `pnpm prune
# --prod` still keeps an unlinked entry until pnpm's `modules-cache-max-age` expires, so
# `drizzle-kit`, `esbuild`, `vitest` and `typescript` stayed on disk (#373: trivy reported the Go
# standard libraries of the orphaned `esbuild` and TypeScript 7 binaries). So every `node_modules`
# is deleted and the production tree installed again, offline, from the store this stage holds.
# `esbuild` mattering specifically: R-15 §3 and `pnpm-workspace.yaml` record that `drizzle-kit` is
# the only route by which it enters this tree, that its install script is denied, and that it must
# never reach a runtime image.
RUN find . -name node_modules -type d -prune -exec rm -rf {} + \
    && pnpm install --frozen-lockfile --prod --offline --filter "@agent-workspace/runner..." --filter "@agent-workspace/engine-${ENGINE}..."
# adapter link — the one adapter this image carries, where the runner's registry imports it from.
# A symlink rather than a manifest edit: rewriting `apps/runner/package.json` here would make the
# frozen lockfile disagree with the manifest it is installing. The link is relative, so it survives
# the `COPY --from=build` into the runtime stage, and the `node -e` check fails the build if the
# adapter does not resolve from the runner — the same failure a run would otherwise report as
# `engine_not_installed` on its first request.
RUN mkdir -p apps/runner/node_modules/@agent-workspace \
 && ln -sfn ../../../../packages/engine-${ENGINE} apps/runner/node_modules/@agent-workspace/engine-${ENGINE} \
 && cd apps/runner \
 && node --input-type=module -e "await import('@agent-workspace/engine-${ENGINE}')"

# ── runtime ─────────────────────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
ARG ENGINE
ARG ENGINE_VERSION
# No npm and no corepack (see the header): npm, npx, corepack and Yarn are deleted, and `apt-get
# upgrade` applies the Debian security fixes published since the pinned base was built.
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules /opt/yarn-v* /root/.npm /root/.cache \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
             /usr/local/bin/yarn /usr/local/bin/yarnpkg
# `npx` through `pnpm dlx` (ADR-0087 D1). A `stdio` connector's documented command is `npx`, and
# this process launches connectors, so the image carries pnpm (the patched release, from the npm
# registry tarball, checksum-verified) and `infra/images/npx.mjs` as `npx`. It still carries no
# npm and no corepack. Bump PNPM_VERSION with `packageManager`, the `corepack prepare` lines and
# the SHA-256 together (`https://registry.npmjs.org/pnpm/-/pnpm-<version>.tgz`).
#
# Engines launch a connector with a replaced environment, often without PATH, and on a read-only
# root filesystem. So the wrappers name Node by absolute path, the shim needs no variable (it
# defaults PNPM_CLI and puts pnpm's directories under /tmp), and `npx` is also linked into
# /usr/bin, which is where a spawn with no PATH looks (libuv's default is /usr/bin:/bin).
ARG PNPM_VERSION=11.28.8
ARG PNPM_TARBALL_SHA256=02bf6cec47fe28f30a224204f924175c2d8750c60e84e315a25cba57ce84da6a
ADD --checksum=sha256:${PNPM_TARBALL_SHA256} \
    https://registry.npmjs.org/pnpm/-/pnpm-${PNPM_VERSION}.tgz /tmp/pnpm.tgz
COPY infra/images/npx.mjs infra/images/npx-run-bin.mjs /opt/npx/
RUN mkdir -p /opt/pnpm \
    && tar -xzf /tmp/pnpm.tgz -C /opt/pnpm --strip-components=1 --no-same-owner \
    && rm -f /tmp/pnpm.tgz \
    && printf '#!/bin/sh\nexec /usr/local/bin/node /opt/pnpm/bin/pnpm.cjs "$@"\n' > /usr/local/bin/pnpm \
    && printf '#!/bin/sh\nexec /usr/local/bin/node /opt/npx/npx.mjs "$@"\n' > /usr/local/bin/npx \
    && chmod 0755 /usr/local/bin/pnpm /usr/local/bin/npx \
    && ln -s /usr/local/bin/npx /usr/bin/npx \
    && pnpm --version
ENV PNPM_CLI=/opt/pnpm/bin/pnpm.cjs
# What this image carries, readable off a pulled image with `docker inspect`. ADR-0073 D3: the
# `engine → image` map is keyed by the same id this label holds, and a driver starts a run only in
# the image its map holds for that run's engine. That the label describes the *bytes* is the
# declared hypothesis of formal/AgentWorkspace/Behaviour/EngineImages.lean — Lean cannot prove what
# an image contains, and the `label check` step above is what enforces it.
LABEL io.agent-workspace.engine="${ENGINE}" \
      io.agent-workspace.engine-version="${ENGINE_VERSION}"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080
# Only the five things the server needs to resolve its imports. `node_modules/` carries pnpm's
# symlink farm and the three package directories carry the links into it, so all of them must be
# copied together or none of them resolves.
COPY --from=build --chown=node:node /srv/node_modules     /srv/node_modules
COPY --from=build --chown=node:node /srv/package.json     /srv/package.json
COPY --from=build --chown=node:node /srv/packages/contracts /srv/packages/contracts
COPY --from=build --chown=node:node /srv/packages/core    /srv/packages/core
COPY --from=build --chown=node:node /srv/packages/engine  /srv/packages/engine
COPY --from=build --chown=node:node /srv/packages/engine-${ENGINE} /srv/packages/engine-${ENGINE}
COPY --from=build --chown=node:node /srv/packages/run-protocol /srv/packages/run-protocol
COPY --from=build --chown=node:node /srv/packages/runtime /srv/packages/runtime
COPY --from=build --chown=node:node /srv/apps/runner      /srv/apps/runner
COPY --chown=node:node LICENSE /srv/LICENSE

# §14.3: *"The runtime process must be able to run as a non-root user."* Not "may" — a sandbox
# whose process is root is a sandbox one container escape away from being nothing at all. `/workspace`
# is the SDK's `cwd` for a run and is the only path in the image the process is expected to write to.
RUN mkdir -p /workspace && chown node:node /workspace
WORKDIR /workspace
USER node

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# The same change as `Dockerfile`'s `runner` target: `apps/runner/src/index.ts` is a real entry
# point as of W1-COMP-01, which is the end state
# docs/adr/W1-INF-01-the-runner-has-no-committed-entry-point.md asks the first task to touch that
# file to reach. The path is absolute because this image's WORKDIR is `/workspace`, not the app.
CMD ["node", "/srv/apps/runner/dist/index.js"]
