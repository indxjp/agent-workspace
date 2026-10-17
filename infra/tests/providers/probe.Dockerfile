# The sandbox image of the provider live lane (.github/workflows/providers-live.yml). It is the
# production base (same digest as runtime.Dockerfile, `USER node`) with probe.mjs where every
# provider starts the runner server: Cloudflare runs the CMD, Vercel and E2B start
# /srv/apps/runner/dist/index.js themselves with /workspace as the working directory. The non-root check
# therefore measures the provider on the production user, not a value the test sets.
#
#   docker build -f infra/tests/providers/probe.Dockerfile infra/tests/providers
ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
FROM ${NODE_IMAGE}
RUN mkdir -p /srv/apps/runner/dist /workspace \
 && chown node:node /workspace \
 && echo '{"type":"module"}' > /srv/apps/runner/dist/package.json
COPY probe.mjs /srv/apps/runner/dist/index.js
USER node
WORKDIR /workspace
EXPOSE 8080
CMD ["node", "/srv/apps/runner/dist/index.js"]
