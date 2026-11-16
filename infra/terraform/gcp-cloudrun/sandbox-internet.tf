# ── Sandbox internet through an egress proxy (D-7 amendment) ──────────────────────────────────────
# Everything here exists only when var.sandbox_internet is true; with it false nothing in this file
# is created and no env of web, the gateway or the runner manager changes. The gateway.sandboxInternet
# setting (gcp.sandboxInternet in agent-workspace.yaml) is what aw deploy renders into it.
#
# A sandbox (tag aw-sandbox) may open tcp 3128 to the proxy's reserved internal address and nothing
# else outside the gateway (network.tf). The proxy is a Compute Engine VM in a managed instance
# group of one, with no external IP; it is the only VM behind a Cloud NAT gateway, so the proxy is
# the only way out to the internet. It runs the egress proxy image in shared mode: it checks the
# per-run credential the runner manager signs with the key in Secret Manager.

locals {
  # The same pattern as runtime_image_repository: <location>-docker.pkg.dev/<project>/<repository>/...
  # The fallback keeps the resources evaluable when the input check below refuses an empty or
  # foreign image, so the refusal is the one error.
  egress_proxy_repository = try(
    regex("^(?P<location>[a-z0-9-]+)-docker\\.pkg\\.dev/(?P<project>[a-z][a-z0-9-]*[a-z0-9])/(?P<repository>[a-z][a-z0-9-]*)/", var.images.egress_proxy),
    { location = "", project = "", repository = "" },
  )
  egress_proxy_in_project = local.egress_proxy_repository.project == var.project_id
  egress_proxy_port       = 3128
  # The ranges Google's health checkers probe from.
  health_check_ranges = ["35.191.0.0/16", "130.211.0.0/22"]
  # Private, shared, carrier-grade NAT and the Google VIP ranges: the proxy VM may not reach any of
  # them, so a request through the proxy cannot reach the VPC, Cloud SQL or a Google API.
  egress_proxy_denied_ranges = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "199.36.153.4/30", "199.36.153.8/30"]
  egress_proxy_key_secret    = "${var.name}-egress-credential-key"
}

# ── Identity and key ──────────────────────────────────────────────────────────────────────────────

resource "google_service_account" "egress_proxy" {
  count        = var.sandbox_internet ? 1 : 0
  account_id   = "${var.name}-egress"
  display_name = "Agent Workspace sandbox egress proxy VM"
  depends_on   = [google_project_service.required]
}

# The one project role: the VM's logging agent writes its logs as this account. Cloud Logging has no
# narrower grant for it: roles/logging.logWriter cannot be bound to a single log or bucket.
resource "google_project_iam_member" "egress_proxy_log_writer" {
  count   = var.sandbox_internet ? 1 : 0
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = google_service_account.egress_proxy[0].member
}

# Pulls its own image, from that repository only (the P3 pattern for the runtime image).
resource "google_artifact_registry_repository_iam_member" "egress_proxy_reader" {
  count      = var.sandbox_internet ? 1 : 0
  project    = var.project_id
  location   = local.egress_proxy_repository.location
  repository = local.egress_proxy_repository.repository
  role       = "roles/artifactregistry.reader"
  member     = google_service_account.egress_proxy[0].member
}

# The key that signs a run's proxy credential. The proxy verifies with it, the runner manager signs
# with it; nothing else reads it.
resource "random_password" "egress_credential_key" {
  count   = var.sandbox_internet ? 1 : 0
  length  = 64
  special = false
}

resource "google_secret_manager_secret" "egress_credential_key" {
  count     = var.sandbox_internet ? 1 : 0
  secret_id = local.egress_proxy_key_secret
  replication {
    user_managed {
      replicas {
        location = var.region
        customer_managed_encryption {
          kms_key_name = google_kms_crypto_key.secret_manager.id
        }
      }
    }
  }
  labels = local.common_labels
  depends_on = [
    google_kms_crypto_key_iam_member.secret_manager,
  ]
}

resource "google_secret_manager_secret_version" "egress_credential_key" {
  count       = var.sandbox_internet ? 1 : 0
  secret      = google_secret_manager_secret.egress_credential_key[0].id
  secret_data = random_password.egress_credential_key[0].result
}

resource "google_secret_manager_secret_iam_member" "egress_proxy_key_access" {
  count     = var.sandbox_internet ? 1 : 0
  project   = var.project_id
  secret_id = google_secret_manager_secret.egress_credential_key[0].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.egress_proxy[0].member
}

resource "google_secret_manager_secret_iam_member" "runner_manager_egress_key_access" {
  count     = var.sandbox_internet ? 1 : 0
  project   = var.project_id
  secret_id = google_secret_manager_secret.egress_credential_key[0].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.runner_manager.member
}

# ── The proxy VM ──────────────────────────────────────────────────────────────────────────────────

# The proxy VM's own subnet. The services subnet has Private Google Access, which would carry a
# request through the proxy to a public Google front-end address (*.run.app, *.googleapis.com) to
# Google over the VPC instead of Cloud NAT, so Cloud Run would count it as coming from inside this
# VPC. This subnet has it off, and is the only one the Cloud NAT gateway below serves.
resource "google_compute_subnetwork" "egress_proxy" {
  count                    = var.sandbox_internet ? 1 : 0
  name                     = "${var.name}-egress-proxy"
  project                  = var.project_id
  region                   = var.region
  network                  = local.network_id
  ip_cidr_range            = "10.10.10.0/28"
  private_ip_google_access = false
}

# The address sandboxes and the runner manager use. It is set as the instance template's network_ip,
# so the only VM the group (size one) ever creates takes it, across autohealing and template
# updates. Internal only: no external IP exists anywhere in this file.
resource "google_compute_address" "egress_proxy" {
  count        = var.sandbox_internet ? 1 : 0
  name         = "${var.name}-egress-proxy"
  project      = var.project_id
  region       = var.region
  address_type = "INTERNAL"
  subnetwork   = google_compute_subnetwork.egress_proxy[0].id
  depends_on   = [google_project_service.required]
}

locals {
  # Container-Optimized OS runs cloud-init from the user-data metadata key. The container startup
  # agent (gce-container-declaration) is deprecated, so a systemd unit runs the container instead.
  #
  # Container-Optimized OS specifics the unit relies on (https://cloud.google.com/container-optimized-os/docs):
  # - its host firewall drops every inbound connection except SSH, so the prepare script opens the
  #   proxy port in the INPUT chain itself; the container uses the host network, so the VPC firewall
  #   rules below are the only other gate and a health checker or sandbox reaches the listener directly;
  # - its root file system is read-only and it is not usr-merged: only /usr/bin/docker,
  #   /usr/bin/docker-credential-gcr and /bin/bash are called by absolute path, everything else is
  #   resolved through PATH inside the script, and systemd creates the writable HOME (StateDirectory)
  #   docker-credential-gcr writes its config to.
  # The key is fetched with the VM's own token into a tmpfs file nobody but uid 1000 can read and is
  # never printed. Each step is reported to the guest attributes under aw-egress/ (enabled below), so
  # a proxy that never listens can be diagnosed without SSH: they carry step names and exit codes only.
  egress_proxy_report  = <<-SH
    report() {
      curl -s -X PUT --data "$2" -H 'Metadata-Flavor: Google' \
        "http://metadata.google.internal/computeMetadata/v1/instance/guest-attributes/aw-egress/$1" >/dev/null || true
    }
  SH
  egress_proxy_prepare = <<-SH
    set -euo pipefail
    umask 077
    ${local.egress_proxy_report}
    step='start'
    trap 'report prepare "failed at $step"' ERR
    report prepare running
    step='open-port'
    iptables -w -C INPUT -p tcp --dport ${local.egress_proxy_port} -j ACCEPT 2>/dev/null \
      || iptables -w -A INPUT -p tcp --dport ${local.egress_proxy_port} -j ACCEPT
    step='registry-auth'
    docker-credential-gcr configure-docker --registries=${local.egress_proxy_repository.location}-docker.pkg.dev
    step='metadata-token'
    metadata=http://metadata.google.internal/computeMetadata/v1
    token=$(curl -sSf -H 'Metadata-Flavor: Google' "$metadata/instance/service-accounts/default/token" | sed -n 's/.*"access_token" *: *"\([^"]*\)".*/\1/p')
    test -n "$token"
    step='fetch-key'
    mkdir -p /run/aw-egress
    curl -sSf -H "Authorization: Bearer $token" "https://secretmanager.googleapis.com/v1/projects/${var.project_id}/secrets/${local.egress_proxy_key_secret}/versions/${try(google_secret_manager_secret_version.egress_credential_key[0].version, "")}:access" \
      | sed -n 's/.*"data" *: *"\([^"]*\)".*/\1/p' | base64 -d > /run/aw-egress/key.tmp
    test -s /run/aw-egress/key.tmp
    chown 1000:1000 /run/aw-egress/key.tmp
    chmod 0400 /run/aw-egress/key.tmp
    mv /run/aw-egress/key.tmp /run/aw-egress/key
    step='pull-image'
    docker pull ${var.images.egress_proxy} >/dev/null
    report prepare ok
  SH
  # systemd sets SERVICE_RESULT, EXIT_CODE and EXIT_STATUS for ExecStopPost.
  egress_proxy_report_exit = <<-SH
    ${local.egress_proxy_report}
    report last-exit "$SERVICE_RESULT $EXIT_CODE $EXIT_STATUS $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  SH
  egress_proxy_unit        = <<-UNIT
    [Unit]
    Description=Agent Workspace sandbox egress proxy
    Requires=docker.service
    After=docker.service network-online.target
    Wants=network-online.target
    StartLimitIntervalSec=0

    [Service]
    StateDirectory=aw-egress
    Environment=HOME=/var/lib/aw-egress
    ExecStartPre=/bin/bash /etc/aw-egress/prepare.sh
    ExecStartPre=-/usr/bin/docker rm -f egress-proxy
    ExecStart=/usr/bin/docker run --rm --name egress-proxy --network host --read-only --user 1000:1000 -v /run/aw-egress/key:/run/secrets/egress-credential-key:ro -e HOST=0.0.0.0 -e PORT=${local.egress_proxy_port} -e EGRESS_MODE=shared -e EGRESS_CREDENTIAL_KEY_FILE=/run/secrets/egress-credential-key ${var.images.egress_proxy}
    ExecStop=/usr/bin/docker stop egress-proxy
    ExecStopPost=/bin/bash /etc/aw-egress/report-exit.sh
    Restart=always
    RestartSec=5

    [Install]
    WantedBy=multi-user.target
  UNIT
  egress_proxy_cloud_init = join("\n", [
    "#cloud-config",
    "write_files:",
    "  - path: /etc/aw-egress/prepare.sh",
    "    permissions: \"0700\"",
    "    owner: root",
    "    encoding: b64",
    "    content: ${base64encode(local.egress_proxy_prepare)}",
    "  - path: /etc/aw-egress/report-exit.sh",
    "    permissions: \"0700\"",
    "    owner: root",
    "    encoding: b64",
    "    content: ${base64encode(local.egress_proxy_report_exit)}",
    "  - path: /etc/systemd/system/aw-egress-proxy.service",
    "    permissions: \"0644\"",
    "    owner: root",
    "    encoding: b64",
    "    content: ${base64encode(local.egress_proxy_unit)}",
    "runcmd:",
    "  - systemctl daemon-reload",
    "  - systemctl start --no-block aw-egress-proxy.service",
    "",
  ])
}

resource "google_compute_instance_template" "egress_proxy" {
  count        = var.sandbox_internet ? 1 : 0
  name_prefix  = "${var.name}-egress-"
  project      = var.project_id
  region       = var.region
  machine_type = "e2-small"
  tags         = ["aw-egress-proxy"]
  labels       = local.common_labels

  disk {
    source_image = "cos-cloud/cos-stable"
    boot         = true
    auto_delete  = true
  }

  # No access_config: the VM has no external IP; its way out is the Cloud NAT below.
  network_interface {
    subnetwork = google_compute_subnetwork.egress_proxy[0].id
    network_ip = google_compute_address.egress_proxy[0].address
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  service_account {
    email  = google_service_account.egress_proxy[0].email
    scopes = ["cloud-platform"]
  }

  metadata = {
    enable-oslogin         = "TRUE"
    block-project-ssh-keys = "TRUE"
    serial-port-enable     = "FALSE"
    google-logging-enabled = "true"
    # The prepare script's step reports (aw-egress/prepare, aw-egress/last-exit), read with
    # `gcloud compute instances get-guest-attributes`. They hold step names and exit codes, never the key.
    enable-guest-attributes = "TRUE"
    user-data               = local.egress_proxy_cloud_init
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [
    google_secret_manager_secret_iam_member.egress_proxy_key_access,
    google_artifact_registry_repository_iam_member.egress_proxy_reader,
  ]
}

data "google_compute_zones" "egress" {
  count   = var.sandbox_internet ? 1 : 0
  project = var.project_id
  region  = var.region
  status  = "UP"
}

# The checker probes from Google's ranges, allowed in by the ingress rule below.
resource "google_compute_health_check" "egress_proxy" {
  count               = var.sandbox_internet ? 1 : 0
  name                = "${var.name}-egress-proxy"
  project             = var.project_id
  check_interval_sec  = 10
  timeout_sec         = 5
  healthy_threshold   = 2
  unhealthy_threshold = 3
  http_health_check {
    port         = local.egress_proxy_port
    request_path = "/healthz"
  }
  depends_on = [google_project_service.required]
}

# One VM, replaced in place when it fails its health check. The template's fixed address means a
# second VM cannot exist beside it: no surge, one unavailable. The group is not stateful, so the
# default SUBSTITUTE replacement applies.
resource "google_compute_instance_group_manager" "egress_proxy" {
  count              = var.sandbox_internet ? 1 : 0
  name               = "${var.name}-egress"
  project            = var.project_id
  zone               = data.google_compute_zones.egress[0].names[0]
  base_instance_name = "${var.name}-egress"
  target_size        = 1

  version {
    instance_template = google_compute_instance_template.egress_proxy[0].id
  }

  auto_healing_policies {
    health_check      = google_compute_health_check.egress_proxy[0].id
    initial_delay_sec = 300
  }

  update_policy {
    type                  = "PROACTIVE"
    minimal_action        = "REPLACE"
    max_surge_fixed       = 0
    max_unavailable_fixed = 1
  }
}

# ── Cloud NAT ─────────────────────────────────────────────────────────────────────────────────────
# Cloud NAT cannot select single VMs ("You can't choose specific VMs to be served by a Cloud NAT
# gateway", https://docs.cloud.google.com/nat/docs/set-up-manage-network-address-translation). This
# gateway serves the primary range of the proxy's own subnet, whose only VM is the proxy. No other
# subnet is in this gateway's list: sandboxes are on the sandbox subnet and are firewalled, and web,
# the gateway and the runner manager send only private ranges into the VPC (PRIVATE_RANGES_ONLY).
resource "google_compute_router" "egress" {
  count   = var.sandbox_internet ? 1 : 0
  name    = "${var.name}-egress"
  project = var.project_id
  region  = var.region
  network = local.network_id
}

resource "google_compute_router_nat" "egress" {
  count                              = var.sandbox_internet ? 1 : 0
  name                               = "${var.name}-egress"
  project                            = var.project_id
  region                             = var.region
  router                             = google_compute_router.egress[0].name
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"
  subnetwork {
    name                    = google_compute_subnetwork.egress_proxy[0].id
    source_ip_ranges_to_nat = ["PRIMARY_IP_RANGE"]
  }
  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

# ── Firewall ──────────────────────────────────────────────────────────────────────────────────────

# Sandboxes reach the proxy on its port and nothing else of it. Priority 0 like the rest of D-6; the
# catch-all deny in network.tf leaves the proxy's /32 out, so the allow overlaps no deny.
resource "google_compute_firewall" "sandbox_allow_egress_proxy" {
  count              = var.sandbox_internet ? 1 : 0
  name               = "${var.name}-sandbox-allow-egress-proxy"
  project            = local.network_project
  network            = local.network_id
  direction          = "EGRESS"
  priority           = 0
  target_tags        = ["aw-sandbox"]
  destination_ranges = ["${google_compute_address.egress_proxy[0].address}/32"]
  allow {
    protocol = "tcp"
    ports    = [tostring(local.egress_proxy_port)]
  }
  depends_on = [google_project_service.required]
}

# Without it every other port and protocol to the proxy would match no rule and fall through to
# GCP's implied allow-egress rule.
resource "google_compute_firewall" "sandbox_deny_egress_proxy_other" {
  count              = var.sandbox_internet ? 1 : 0
  name               = "${var.name}-sandbox-deny-egress-proxy-other"
  project            = local.network_project
  network            = local.network_id
  direction          = "EGRESS"
  priority           = 0
  target_tags        = ["aw-sandbox"]
  destination_ranges = ["${google_compute_address.egress_proxy[0].address}/32"]
  deny {
    protocol = "tcp"
    ports    = ["0-${local.egress_proxy_port - 1}", "${local.egress_proxy_port + 1}-65535"]
  }
  deny {
    protocol = "udp"
  }
  deny {
    protocol = "icmp"
  }
  deny {
    protocol = "sctp"
  }
  deny {
    protocol = "esp"
  }
  deny {
    protocol = "ah"
  }
  depends_on = [google_project_service.required]
}

# Ingress to the proxy: only the sandbox subnet and Google's health checkers, on the proxy port. The
# sandbox subnet's range, not a tag: Cloud Run services cannot be ingress targets of a tag and
# source-tag matching for Direct VPC egress is not documented. The implied ingress deny covers the rest.
resource "google_compute_firewall" "egress_proxy_allow_sandboxes" {
  count         = var.sandbox_internet ? 1 : 0
  name          = "${var.name}-egress-proxy-allow-sandboxes"
  project       = local.network_project
  network       = local.network_id
  direction     = "INGRESS"
  priority      = 1000
  target_tags   = ["aw-egress-proxy"]
  source_ranges = [local.create_network ? google_compute_subnetwork.sandbox[0].ip_cidr_range : ""]
  allow {
    protocol = "tcp"
    ports    = [tostring(local.egress_proxy_port)]
  }
  depends_on = [google_project_service.required]
}

resource "google_compute_firewall" "egress_proxy_allow_health_checks" {
  count         = var.sandbox_internet ? 1 : 0
  name          = "${var.name}-egress-proxy-allow-health-checks"
  project       = local.network_project
  network       = local.network_id
  direction     = "INGRESS"
  priority      = 1000
  target_tags   = ["aw-egress-proxy"]
  source_ranges = local.health_check_ranges
  allow {
    protocol = "tcp"
    ports    = [tostring(local.egress_proxy_port)]
  }
  depends_on = [google_project_service.required]
}

# The proxy VM reaches the internet and nothing private. Firewall rules do not apply to traffic to
# the metadata server (https://docs.cloud.google.com/firewall/docs/firewalls), so DNS and the token
# the key fetch needs keep working.
resource "google_compute_firewall" "egress_proxy_deny_private" {
  count              = var.sandbox_internet ? 1 : 0
  name               = "${var.name}-egress-proxy-deny-private"
  project            = local.network_project
  network            = local.network_id
  direction          = "EGRESS"
  priority           = 0
  target_tags        = ["aw-egress-proxy"]
  destination_ranges = local.egress_proxy_denied_ranges
  deny {
    protocol = "all"
  }
  depends_on = [google_project_service.required]
}

# Firewall rules cannot mix address families.
resource "google_compute_firewall" "egress_proxy_deny_private_ipv6" {
  count              = var.sandbox_internet ? 1 : 0
  name               = "${var.name}-egress-proxy-deny-private-v6"
  project            = local.network_project
  network            = local.network_id
  direction          = "EGRESS"
  priority           = 0
  target_tags        = ["aw-egress-proxy"]
  destination_ranges = ["::/0"]
  deny {
    protocol = "all"
  }
  depends_on = [google_project_service.required]
}
