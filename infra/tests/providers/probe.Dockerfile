# The sandbox image of the provider live lane (.github/workflows/providers-live.yml). It is the
# production base (same digest as runtime.Dockerfile, `USER node`) with probe.mjs where every
# provider starts the runner server: Cloudflare runs the CMD, Vercel and E2B start
# /srv/apps/runner/dist/index.js themselves with /workspace as the working directory. The non-root check
# therefore measures the provider on the production user, not a value the test sets.
#
#   docker build -f infra/tests/providers/probe.Dockerfile infra/tests/providers
ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
FROM ${NODE_IMAGE}
RUN mkdir -p /srv/apps/runner/dist /workspace \
 && chown node:node /workspace \
 && echo '{"type":"module"}' > /srv/apps/runner/dist/package.json
COPY probe.mjs /srv/apps/runner/dist/index.js
USER node
WORKDIR /workspace
EXPOSE 8080
CMD ["node", "/srv/apps/runner/dist/index.js"]
