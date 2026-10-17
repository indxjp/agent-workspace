#!/bin/sh
set -eu
umask 077

candidate="${1:-}"
[ -f "$candidate" ] || { echo 'usage: upgrade /path/to/digest-pinned-images.env' >&2; exit 2; }
exec 9>/run/lock/agent-workspace-upgrade.lock
flock -n 9 || { echo 'upgrade already running' >&2; exit 1; }

for key in WEB_IMAGE GATEWAY_IMAGE RUNNER_IMAGE RUNTIME_IMAGE POSTGRES_IMAGE PROXY_IMAGE; do
  value="$(sed -n "s/^$key=//p" "$candidate")"
  case "$value" in *@sha256:????????????????????????????????????????????????????????????????) ;; *) echo "$key is not digest pinned" >&2; exit 2 ;; esac
done

current=/etc/agent-workspace/images.env
release_dir=/var/lib/agent-workspace/releases
mkdir -p "$release_dir"
previous="$release_dir/$(date -u +%Y%m%dT%H%M%SZ)-previous.env"
cp "$current" "$previous"
if [ "$(readlink -f "$candidate")" != "$(readlink -f "$current")" ]; then
  install -m 0600 "$candidate" "$current"
fi
compose='docker compose --env-file /etc/agent-workspace/images.env -f /etc/agent-workspace/compose.yaml'
if ! $compose pull || ! $compose up --detach --wait --remove-orphans; then
  install -m 0600 "$previous" "$current"
  $compose pull
  $compose up --detach --wait --remove-orphans
  echo "upgrade failed and rolled back to $previous" >&2
  exit 1
fi
echo "upgrade completed; rollback asset: $previous"
