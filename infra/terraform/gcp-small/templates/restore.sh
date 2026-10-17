#!/bin/sh
set -eu
umask 077

[ "$#" -eq 2 ] && [ "$1" = "--from" ] || {
  echo 'usage: restore --from gs://bucket/application/TIMESTAMP' >&2
  exit 2
}
case "$2" in gs://*/application/*) ;; *) echo 'restore source must be an application backup URI' >&2; exit 2 ;; esac
exec 9>/run/lock/agent-workspace-restore.lock
flock -n 9 || { echo 'restore already running' >&2; exit 1; }
staging="$(mktemp -d /var/lib/agent-workspace/backups/.restore-XXXXXX)"
cleanup() { rm -rf "$staging"; }
trap cleanup EXIT INT TERM
gcloud storage cp --recursive "$2/*" "$staging/"
(cd "$staging" && sha256sum --check SHA256SUMS)

compose='docker compose --env-file /etc/agent-workspace/images.env -f /etc/agent-workspace/compose.yaml'
$compose stop proxy web gateway runner
$compose up --detach --wait postgres
cat "$staging/postgres.dump" | $compose exec -T postgres pg_restore \
  --username agent_workspace --dbname agent_workspace --clean --if-exists --no-owner

previous="/var/lib/agent-workspace/backups/pre-restore-$(date -u +%Y%m%dT%H%M%SZ)"
mv /var/lib/agent-workspace/workspace "$previous"
if ! tar --numeric-owner -C /var/lib/agent-workspace -xzf "$staging/workspace.tar.gz"; then
  rm -rf /var/lib/agent-workspace/workspace
  mv "$previous" /var/lib/agent-workspace/workspace
  exit 1
fi
$compose up --detach --wait --remove-orphans
echo 'restore completed; run the acceptance drill before deleting the pre-restore directory'
