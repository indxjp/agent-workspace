#!/bin/sh
set -eu
umask 077

release_dir=/var/lib/agent-workspace/releases
candidate="${1:-$(find "$release_dir" -maxdepth 1 -name '*-previous.env' -type f | sort | tail -n 1)}"
[ -f "$candidate" ] || { echo 'no rollback image set found' >&2; exit 1; }
exec 9>/run/lock/agent-workspace-upgrade.lock
flock -n 9 || { echo 'upgrade or rollback already running' >&2; exit 1; }
install -m 0600 "$candidate" /etc/agent-workspace/images.env
docker compose --env-file /etc/agent-workspace/images.env -f /etc/agent-workspace/compose.yaml pull
docker compose --env-file /etc/agent-workspace/images.env -f /etc/agent-workspace/compose.yaml up --detach --wait --remove-orphans
echo "rolled back to $candidate"
