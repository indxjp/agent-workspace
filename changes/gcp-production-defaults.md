---
changelog: platform
section: Changed
---

- The Google Cloud install (`aw deploy production` with a `gcp` block) now has production defaults
  (BYOC Google Cloud, phase P6). Data protection is on by default (`gcp.dataProtection`): Cloud SQL
  has deletion protection, the buckets are versioned (noncurrent versions are deleted after 30 days)
  with a 7-day soft delete and cannot be emptied by a destroy, and the web, gateway and runner
  manager services have deletion protection. This changes behaviour for disposable stacks:
  `aw deploy destroy production` now refuses while any of it is on. Set `dataProtection: false`,
  run `aw deploy production --yes`, then destroy. A deleted bucket stays restorable, and billed,
  for 7 days.
- New `gcp.size`: `small` (the default; shared-core Cloud SQL, one web instance always warm, the
  gateway and runner manager scale to zero) or `standard` (`db-custom-2-7680` with regional high
  availability, at least one instance of every service). Both start with CPU boost and keep 14
  backups with point-in-time recovery (7 days of logs); the maintenance window is Sunday 18:00 UTC.
- Four log-based metrics and a dashboard are created always. New `gcp.alertsEmail` adds an email
  channel, alert policies (web and gateway 5xx, gateway upstream errors, runner manager failures,
  Cloud SQL CPU and disk, live sandboxes over the size's cap) and an uptime check of `/api/readyz`
  (none with `iap`). The live-sandboxes alert counts services with an active instance, not metric
  series. The deploy needs the logging and dashboard roles always, and the alerting roles only
  with `gcp.alertsEmail`; the permission check names them.
- New `aw deploy status production` reports versions, revision health, data protection and drift,
  and exits 3 when the plan has changes.
- The Cloud Build grants and API are no longer part of the install. Secrets are pinned to the
  version the module wrote; the single sign-on client secret stays at `latest`. On an existing
  stack the three Cloud Build grants on the default Compute Engine service account are kept, not
  revoked: Terraform only forgets them (`removed` blocks), so revoke them by hand if unwanted.
- New operator runbook: `docs/operations/gcp-cloudrun-runbook.md` (upgrade, rollback, restore,
  key and secret rotation, budgets, alerts).
