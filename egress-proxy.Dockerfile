ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

FROM ${NODE_IMAGE} AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=1
RUN corepack enable && corepack prepare pnpm@11.28.2 --activate

WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/egress-proxy/package.json packages/egress-proxy/tsconfig.json packages/egress-proxy/tsconfig.build.json packages/egress-proxy/
RUN pnpm install --frozen-lockfile --filter @agent-workspace/egress-proxy...

COPY packages/egress-proxy packages/egress-proxy
RUN pnpm --filter @agent-workspace/egress-proxy build

# The package has no runtime dependency, so the image holds its compiled output and nothing else:
# no node_modules, no package manager (ADR-0087), no shell scripts. It writes nothing to disk, so
# it runs with a read-only root file system, and it runs as a numeric non-root user so that
# `runAsNonRoot` can be verified without resolving a name.
FROM ${NODE_IMAGE} AS egress-proxy
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules /opt/yarn-v* /root/.npm /root/.cache \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
             /usr/local/bin/yarn /usr/local/bin/yarnpkg
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="Agent Workspace egress proxy" \
      org.opencontainers.image.source="https://github.com/indxdev/agent-workspace" \
      org.opencontainers.image.revision="$VCS_REF"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3128
WORKDIR /app
COPY --from=build /workspace/packages/egress-proxy/package.json ./package.json
COPY --from=build /workspace/packages/egress-proxy/dist ./dist
USER 1000:1000
EXPOSE 3128
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3128)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
