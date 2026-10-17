#!/bin/sh
set -eu

images=/etc/agent-workspace/images.env
[ "$(stat -c %U:%G "$images")" = root:root ] || { echo 'images.env must be root owned' >&2; exit 1; }
[ "$(stat -c %a "$images")" = 600 ] || { echo 'images.env must have mode 0600' >&2; exit 1; }
for key in WEB_IMAGE GATEWAY_IMAGE RUNNER_IMAGE RUNTIME_IMAGE POSTGRES_IMAGE PROXY_IMAGE; do
  value="$(sed -n "s/^$key=//p" "$images")"
  case "$value" in *@sha256:????????????????????????????????????????????????????????????????) ;; *) echo "$key is not digest pinned" >&2; exit 1 ;; esac
  case "$value" in *@sha256:0000000000000000000000000000000000000000000000000000000000000000) echo "$key is a placeholder" >&2; exit 1 ;; esac
done
for secret in /run/agent-workspace/secrets/*.env; do
  [ "$(stat -c %U:%G "$secret")" = root:root ] || { echo "$secret must be root owned" >&2; exit 1; }
  [ "$(stat -c %a "$secret")" = 600 ] || { echo "$secret must have mode 0600" >&2; exit 1; }
done
docker compose --env-file "$images" -f /etc/agent-workspace/compose.yaml config --quiet

# Only the TLS proxy may publish host ports. This parses the resolved model, not YAML text.
docker compose --env-file "$images" -f /etc/agent-workspace/compose.yaml config --format json |
python3 -c 'import json,sys; m=json.load(sys.stdin); bad=[n for n,s in m["services"].items() if n!="proxy" and s.get("ports")]; sys.exit("internal services publish ports: "+",".join(bad) if bad else 0)'

# The runtime driver refuses a runtime-control network without its label. A VM provisioned before
# the label keeps the old network when Compose finds it by its fixed name, so it is removed here and
# `up` recreates it labelled. `docker network rm` refuses while a container is attached: stop the
# stack and any leftover sandbox, then start again.
network=agent-workspace-runtime-control
if docker network inspect "$network" >/dev/null 2>&1 &&
  [ "$(docker network inspect -f '{{index .Labels "agent-workspace.runtime"}}' "$network")" != docker-network ]; then
  docker network rm "$network" >/dev/null ||
    { echo "$network predates its agent-workspace.runtime label and is in use: stop the stack and remove its containers, then start again" >&2; exit 1; }
fi
