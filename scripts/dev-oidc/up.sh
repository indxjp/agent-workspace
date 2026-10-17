#!/usr/bin/env sh
set -eu

name="${OIDC_DEV_CONTAINER:-agent-workspace-oidc}"
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" -p 127.0.0.1:38080:8080 \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin \
  -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
  -v "$script_dir/agent-workspace-realm.json:/opt/keycloak/data/import/agent-workspace-realm.json:ro" \
  quay.io/keycloak/keycloak:26.4 start-dev --import-realm >/dev/null
until curl -fsS http://127.0.0.1:38080/realms/agent-workspace/.well-known/openid-configuration >/dev/null; do sleep 2; done
echo 'OIDC_ISSUER_URL=http://127.0.0.1:38080/realms/agent-workspace'
echo 'OIDC_CLIENT_ID=agent-workspace'
echo 'OIDC_CLIENT_SECRET=agent-workspace-dev-secret'
echo 'OIDC_REDIRECT_URI=http://localhost:3000/p/oidc-transactions/messages'
echo 'Development user: owner@example.com / owner-password'
