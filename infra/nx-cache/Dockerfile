# INDX Nx remote cache — zero-dependency Node service (see README.md).
# Build context: infra/nx-cache
#   docker build -t nx-cache infra/nx-cache
FROM node:24.22.1-alpine3.23@sha256:0468540aa58203ff9e40c2aab3907c52644ab818af6176b1c70a026137dc92a2

ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY src/ ./src/

# Unprivileged runtime user; the image holds no secrets (tokens and the
# signing key arrive as env vars from Secret Manager at deploy time).
USER node
EXPOSE 8080
CMD ["node", "src/main.mjs"]
