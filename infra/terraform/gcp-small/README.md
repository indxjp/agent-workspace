# GCP small deployment

This stack creates the production-shaped single-zone baseline: a custom VPC/subnet, static IPv4,
only `80/443` public, optional IAP-only SSH, a hardened Compute Engine VM and service account, a
separate balanced data disk, daily snapshots, Artifact Registry, exact Secret Manager bindings, a
versioned backup bucket, uptime monitoring, alerts, SLO, and dashboard.

## Apply from an empty project

1. Apply `bootstrap/` once and initialize this module with its printed GCS backend arguments.
2. Copy `terraform.tfvars.example` and replace every image with a real OCI digest. Tags and the
   all-zero placeholder are validation errors.
3. Apply this stack. Terraform creates secret containers but never secret versions or values.
4. Upload base64url-safe PostgreSQL and administrator values plus at least 32-character session,
   master-encryption, and gateway-token secrets. Put their numbered versions in the variables and
   apply again.
5. Point the configured DNS name at `public_ip`. Caddy refuses to serve production traffic until it
   obtains a valid certificate for that name.

The VM fetches only numbered secret versions into `/run/agent-workspace`, which is volatile and
root-only. Web, gateway, runner, and PostgreSQL receive separate environment files. Only the proxy
publishes ports; the database/control network is internal, and provider egress is attached only to
the gateway and explicitly launched runtimes.

## Operate and recover

- `systemctl status agent-workspace` includes real Compose health readiness.
- `systemctl start agent-workspace-backup` creates a PostgreSQL custom dump, workspace archive,
  checksums, and metadata before uploading to the versioned bucket.
- `/usr/local/libexec/agent-workspace/restore --from gs://.../application/TIMESTAMP` verifies all
  checksums and retains the pre-restore workspace for manual rollback.
- `/usr/local/libexec/agent-workspace/upgrade /root/new-images.env` refuses tags, preserves the
  previous image set, pulls first, waits for health, and automatically rolls back on failure.
- `/usr/local/libexec/agent-workspace/rollback [previous.env]` performs an explicit rollback.
- The `agent-workspace-runtime-control` network carries the `agent-workspace.runtime=docker-network`
  label the Docker runtime driver requires. On a VM provisioned before that label, the service's
  `validate` step removes the unlabelled network so `up` recreates it; if a leftover sandbox is
  still attached, it stops with a message: remove that container and start the service again.

Use `infra/drills/gcp-small-drill.sh` to capture repeatable smoke, backup, restore, upgrade,
rollback, and VM-replacement evidence. A single VM is deliberately not highly available; the
recovery model is Terraform replacement plus application restore. Set `deletion_protection=false`
only during an approved replacement/destroy operation, then restore it immediately.

The optional OpenTelemetry collector overlay is in `infra/observability/`. Alert notification
channels are organization-specific and intentionally not guessed by this module.
