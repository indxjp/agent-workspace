# INDX Nx remote cache — zero-dependency Node service (see README.md).
# Build context: infra/nx-cache
#   docker build -t nx-cache infra/nx-cache
FROM node:22.20.0-alpine3.22

ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY src/ ./src/

# Unprivileged runtime user; the image holds no secrets (tokens and the
# signing key arrive as env vars from Secret Manager at deploy time).
USER node
EXPOSE 8080
CMD ["node", "src/main.mjs"]
