ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

FROM ${NODE_IMAGE} AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Without CI=1, `pnpm install --prod` below prompts before purging node_modules and a Docker RUN
# step has no TTY to answer it (the same reason gateway.Dockerfile sets it).
ENV CI=1
RUN corepack enable && corepack prepare pnpm@12.15.0 --activate

WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/contracts/package.json packages/contracts/tsconfig.json packages/contracts/tsconfig.build.json packages/contracts/
COPY packages/platforms/package.json packages/platforms/tsconfig.json packages/platforms/tsconfig.build.json packages/platforms/
COPY packages/sdk/package.json packages/sdk/tsconfig.json packages/sdk/tsconfig.build.json packages/sdk/
COPY packages/cli/package.json packages/cli/tsconfig.json packages/cli/tsconfig.build.json packages/cli/
COPY packages/aw/package.json packages/aw/tsconfig.json packages/aw/tsconfig.build.json packages/aw/
COPY packages/tool-host/package.json packages/tool-host/tsconfig.json packages/tool-host/tsconfig.build.json packages/tool-host/
RUN pnpm install --frozen-lockfile --network-concurrency=4 --child-concurrency=1 --filter @agent-workspace/tool-host...

# `aw` is built from source here only for the tool host it ships (ADR-0118 TS7); the image never
# contains `@agent-workspace/core` or the database layer (TS9). The CLI is a build-time input of
# `aw`'s type-check and is dropped with the other dev dependencies below.
COPY packages/contracts packages/contracts
COPY packages/platforms packages/platforms
COPY packages/sdk packages/sdk
COPY packages/cli packages/cli
COPY packages/aw packages/aw
COPY packages/tool-host packages/tool-host
RUN pnpm --filter @indx-workspace/contracts build \
    && pnpm --filter @indx-workspace/platforms build \
    && pnpm --filter @indx-workspace/sdk build \
    && pnpm --filter @indx-workspace/cli build \
    && pnpm --filter @indx-workspace/aw build \
    && pnpm --filter @agent-workspace/tool-host build
# The production tree, installed fresh from the store this stage holds (see gateway.Dockerfile).
RUN find . -name node_modules -type d -prune -exec rm -rf {} + \
    && pnpm install --frozen-lockfile --prod --offline --filter @agent-workspace/tool-host...

# No package manager in the image (ADR-0087). The root file system is read-only at run time: the
# tool host writes only into `/workspace` and `/tmp`, which the driver mounts. It keeps `sh`
# because the runner writes the session's files with `docker exec`. It runs as a numeric non-root
# user so that `runAsNonRoot` can be verified without resolving a name.
FROM ${NODE_IMAGE} AS tool-host
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules /opt/yarn-v* /root/.npm /root/.cache \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
             /usr/local/bin/yarn /usr/local/bin/yarnpkg
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="Agent Workspace tool host" \
      org.opencontainers.image.source="https://github.com/indxjp/agent-workspace" \
      org.opencontainers.image.revision="$VCS_REF"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8788
WORKDIR /app
COPY --from=build /workspace /app
USER 1000:1000
EXPOSE 8788
CMD ["node", "/app/packages/tool-host/dist/main.js"]
