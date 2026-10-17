#!/usr/bin/env sh
set -eu

mode="${1:-}"
: "${PROJECT_ID:?set PROJECT_ID}"
: "${ZONE:?set ZONE}"
: "${VM_NAME:=agent-workspace}"
: "${PUBLIC_URL:?set PUBLIC_URL to the configured https URL}"
evidence_dir="${EVIDENCE_DIR:-dist/drills/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$evidence_dir"

remote() {
  gcloud compute ssh "$VM_NAME" --project "$PROJECT_ID" --zone "$ZONE" \
    --tunnel-through-iap --quiet --command "$1"
}
smoke() {
  curl --fail --silent --show-error --proto '=https' --tlsv1.2 "$PUBLIC_URL/" >"$evidence_dir/home.html"
  remote 'sudo systemctl is-active agent-workspace && sudo docker compose --env-file /etc/agent-workspace/images.env -f /etc/agent-workspace/compose.yaml ps --format json' >"$evidence_dir/compose.json"
}

case "$mode" in
  smoke)
    smoke
    ;;
  backup)
    remote 'sudo systemctl start agent-workspace-backup.service && sudo journalctl -u agent-workspace-backup.service -n 100 --no-pager' >"$evidence_dir/backup.log"
    ;;
  restore)
    : "${BACKUP_URI:?set BACKUP_URI}"
    [ "${ALLOW_DESTRUCTIVE_RESTORE:-}" = "restore-$VM_NAME" ] || {
      echo "set ALLOW_DESTRUCTIVE_RESTORE=restore-$VM_NAME for this destructive drill" >&2
      exit 2
    }
    remote "sudo /usr/local/libexec/agent-workspace/restore --from '$BACKUP_URI'" >"$evidence_dir/restore.log"
    smoke
    ;;
  upgrade)
    : "${CANDIDATE_IMAGES:?set CANDIDATE_IMAGES to a local digest-pinned env file}"
    gcloud compute scp "$CANDIDATE_IMAGES" "$VM_NAME:/tmp/candidate-images.env" --project "$PROJECT_ID" --zone "$ZONE" --tunnel-through-iap --quiet
    remote 'sudo /usr/local/libexec/agent-workspace/upgrade /tmp/candidate-images.env' >"$evidence_dir/upgrade.log"
    smoke
    ;;
  rollback)
    remote 'sudo /usr/local/libexec/agent-workspace/rollback' >"$evidence_dir/rollback.log"
    smoke
    ;;
  rebuild)
    [ "${ALLOW_VM_REBUILD:-}" = "replace-$VM_NAME" ] || {
      echo "set ALLOW_VM_REBUILD=replace-$VM_NAME and temporarily disable deletion protection" >&2
      exit 2
    }
    terraform -chdir=infra/terraform/gcp-small apply -replace=google_compute_instance.main
    smoke
    ;;
  *)
    echo 'usage: gcp-small-drill.sh smoke|backup|restore|upgrade|rollback|rebuild' >&2
    exit 2
    ;;
esac

printf '{"schemaVersion":1,"mode":"%s","project":"%s","zone":"%s","vm":"%s","completedAt":"%s"}\n' \
  "$mode" "$PROJECT_ID" "$ZONE" "$VM_NAME" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$evidence_dir/result.json"
printf 'drill evidence: %s\n' "$evidence_dir"
