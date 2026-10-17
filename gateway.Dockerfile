ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

FROM ${NODE_IMAGE} AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Without CI=1, `pnpm install --prod` below prompts before purging node_modules and a Docker RUN
# step has no TTY to answer it: ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY. Matches the CI=1 the
# other two Dockerfiles' base stages already set for the same reason.
ENV CI=1
RUN corepack enable && corepack prepare pnpm@11.28.2 --activate

WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/contracts/package.json packages/contracts/tsconfig.json packages/contracts/tsconfig.build.json packages/contracts/
COPY packages/engine/package.json packages/engine/tsconfig.json packages/engine/tsconfig.build.json packages/engine/
COPY packages/core/package.json packages/core/tsconfig.json packages/core/tsconfig.build.json packages/core/
COPY packages/gateway/package.json packages/gateway/tsconfig.json packages/gateway/tsconfig.build.json packages/gateway/
RUN pnpm install --frozen-lockfile --filter @agent-workspace/core... --filter @agent-workspace/gateway...

COPY packages/contracts packages/contracts
COPY packages/engine packages/engine
COPY packages/core packages/core
COPY packages/gateway packages/gateway
RUN pnpm --filter @indx-workspace/contracts build \
    && pnpm --filter @agent-workspace/engine build \
    && pnpm --filter @agent-workspace/core build \
    && pnpm --filter @agent-workspace/gateway build
# The production tree, installed fresh from the store this stage holds: a prune leaves unlinked
# virtual-store entries (and their Go binaries) on disk until pnpm's modules cache expires (#373).
RUN find . -name node_modules -type d -prune -exec rm -rf {} + \
    && pnpm install --frozen-lockfile --prod --offline --filter @agent-workspace/gateway...

# No package manager in the image (ADR-0087): the gateway process runs none, and npm, corepack and
# Yarn from the Node image are HIGH or CRITICAL trivy findings whenever their bundled copies fall
# behind. `apt-get upgrade` applies the Debian security fixes published since the base was built.
FROM ${NODE_IMAGE} AS gateway
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules /opt/yarn-v* /root/.npm /root/.cache \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
             /usr/local/bin/yarn /usr/local/bin/yarnpkg
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="Agent Workspace model gateway" \
      org.opencontainers.image.source="https://github.com/indxdev/agent-workspace" \
      org.opencontainers.image.revision="$VCS_REF"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000
WORKDIR /workspace
COPY --from=build --chown=node:node /workspace /workspace
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "packages/gateway/dist/index.js"]
