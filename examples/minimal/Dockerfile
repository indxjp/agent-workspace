# The minimal app's image. `npm run image` builds it; push it and `aw deploy` runs it by the
# pushed digest (environments.production.apps.minimal.image). Next.js's standalone output holds
# the server and only the files it imports, so the image carries no development dependencies.
#
# The base image is pinned by digest. To update it, pull the newer node:24-bookworm-slim and put
# its tag and digest on both FROM lines.
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && mkdir -p public

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/db/migrations ./db/migrations
USER node
EXPOSE 3000
CMD ["node", "server.js"]
