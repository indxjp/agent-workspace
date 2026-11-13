# The stand-in app tests/generated-project/compose-apps.mjs boots from compose.apps.yaml (issue
# #1512): it answers /api/health and nothing else. The base is the Node.js image the platform's images pin.
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
WORKDIR /app
COPY server.mjs ./
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
