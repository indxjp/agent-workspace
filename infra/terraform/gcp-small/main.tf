locals {
  required_apis = toset([
    "artifactregistry.googleapis.com",
    "compute.googleapis.com",
    "iam.googleapis.com",
    "iap.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "secretmanager.googleapis.com",
    "storage.googleapis.com",
  ])
  secret_ids = toset([
    "postgres-password",
    "session-secret",
    "master-encryption-key",
    "gateway-token-secret",
    "runner-manager-token",
    "bootstrap-admin-password",
  ])
  common_labels = {
    application = "agent-workspace"
    managed-by  = "terraform"
  }
  deployment_files = {
    compose        = base64encode(file("${path.module}/templates/compose.yaml"))
    caddy          = base64encode(templatefile("${path.module}/templates/Caddyfile.tftpl", { domain = var.domain, tls_email = var.tls_email }))
    fetch          = base64encode(templatefile("${path.module}/templates/fetch-secrets.sh.tftpl", { project_id = var.project_id, bootstrap_admin_email = var.bootstrap_admin_email, secret_versions = var.secret_versions, gateway_pricing_json_base64 = base64encode(var.gateway_pricing_json) }))
    backup         = base64encode(templatefile("${path.module}/templates/backup.sh.tftpl", { backup_bucket = google_storage_bucket.backups.name }))
    restore        = base64encode(file("${path.module}/templates/restore.sh"))
    upgrade        = base64encode(file("${path.module}/templates/upgrade.sh"))
    rollback       = base64encode(file("${path.module}/templates/rollback.sh"))
    validate       = base64encode(file("${path.module}/templates/validate.sh"))
    service        = base64encode(file("${path.module}/templates/agent-workspace.service"))
    backup_service = base64encode(file("${path.module}/templates/agent-workspace-backup.service"))
    backup_timer   = base64encode(file("${path.module}/templates/agent-workspace-backup.timer"))
  }
}

resource "google_project_service" "required" {
  for_each           = local.required_apis
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_compute_network" "main" {
  name                    = "${var.name}-vpc"
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
  depends_on              = [google_project_service.required]
}

resource "google_compute_subnetwork" "main" {
  name                     = "${var.name}-subnet"
  ip_cidr_range            = var.subnet_cidr
  region                   = var.region
  network                  = google_compute_network.main.id
  private_ip_google_access = true
}

resource "google_compute_address" "main" {
  name       = "${var.name}-ipv4"
  region     = var.region
  depends_on = [google_project_service.required]
}

resource "google_compute_firewall" "https" {
  name      = "${var.name}-public-web"
  network   = google_compute_network.main.name
  direction = "INGRESS"
  priority  = 1000
  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["${var.name}-web"]
}

resource "google_compute_firewall" "iap_ssh" {
  count     = var.enable_iap_ssh ? 1 : 0
  name      = "${var.name}-iap-ssh"
  network   = google_compute_network.main.name
  direction = "INGRESS"
  priority  = 1000
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["${var.name}-iap-ssh"]
}

resource "google_service_account" "vm" {
  account_id   = "${substr(var.name, 0, 22)}-vm"
  display_name = "Agent Workspace small deployment VM"
  depends_on   = [google_project_service.required]
}

resource "google_project_iam_member" "vm_project_roles" {
  for_each = toset([
    "roles/artifactregistry.reader",
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
  ])
  project = var.project_id
  role    = each.value
  member  = google_service_account.vm.member
}

resource "google_project_iam_member" "iap_operators" {
  for_each = var.enable_iap_ssh ? var.operator_members : toset([])
  project  = var.project_id
  role     = "roles/iap.tunnelResourceAccessor"
  member   = each.value
}

resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = var.name
  description   = "Digest-pinned Agent Workspace release images"
  format        = "DOCKER"
  depends_on    = [google_project_service.required]
}

resource "google_secret_manager_secret" "deployment" {
  for_each  = local.secret_ids
  secret_id = "${var.name}-${each.value}"
  replication {
    user_managed {
      replicas { location = var.region }
    }
  }
  labels     = local.common_labels
  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_iam_member" "vm_access" {
  for_each  = google_secret_manager_secret.deployment
  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.vm.member
}

resource "google_storage_bucket" "backups" {
  name                        = "${var.project_id}-${var.name}-backups"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  versioning { enabled = true }
  retention_policy {
    retention_period = var.backup_retention_days * 86400
    is_locked        = false
  }
  lifecycle_rule {
    condition { age = var.backup_retention_days }
    action { type = "Delete" }
  }
  labels     = local.common_labels
  depends_on = [google_project_service.required]
}

resource "google_storage_bucket_iam_member" "vm_backups" {
  bucket = google_storage_bucket.backups.name
  role   = "roles/storage.objectUser"
  member = google_service_account.vm.member
}

resource "google_compute_disk" "data" {
  name                      = "${var.name}-data"
  type                      = var.data_disk_type
  zone                      = var.zone
  size                      = var.data_disk_size_gb
  physical_block_size_bytes = 4096
  labels                    = local.common_labels
}

resource "google_compute_resource_policy" "snapshots" {
  name   = "${var.name}-daily-snapshots"
  region = var.region
  snapshot_schedule_policy {
    schedule {
      daily_schedule {
        days_in_cycle = 1
        start_time    = "03:00"
      }
    }
    retention_policy {
      max_retention_days    = var.snapshot_retention_days
      on_source_disk_delete = "KEEP_AUTO_SNAPSHOTS"
    }
    snapshot_properties {
      guest_flush       = true
      storage_locations = [var.region]
      labels            = local.common_labels
    }
  }
}

resource "google_compute_disk_resource_policy_attachment" "snapshots" {
  name = google_compute_resource_policy.snapshots.name
  disk = google_compute_disk.data.name
  zone = var.zone
}

data "google_compute_image" "debian" {
  family  = "debian-12"
  project = "debian-cloud"
}

resource "google_compute_instance" "main" {
  name                      = var.name
  zone                      = var.zone
  machine_type              = var.machine_type
  can_ip_forward            = false
  allow_stopping_for_update = true
  deletion_protection       = var.deletion_protection
  tags                      = compact(["${var.name}-web", var.enable_iap_ssh ? "${var.name}-iap-ssh" : ""])
  labels                    = local.common_labels

  boot_disk {
    auto_delete = true
    initialize_params {
      image = data.google_compute_image.debian.self_link
      size  = 30
      type  = "pd-balanced"
    }
  }
  attached_disk {
    source      = google_compute_disk.data.id
    device_name = "agent-workspace-data"
  }
  network_interface {
    subnetwork = google_compute_subnetwork.main.id
    access_config { nat_ip = google_compute_address.main.address }
  }
  service_account {
    email  = google_service_account.vm.email
    scopes = ["https://www.googleapis.com/auth/cloud-platform"]
  }
  metadata = {
    block-project-ssh-keys = "true"
    enable-oslogin         = "true"
    startup-script = templatefile("${path.module}/templates/startup.sh.tftpl", {
      docker_ce_version      = var.docker_ce_version
      docker_compose_version = var.docker_compose_version
      web_image              = var.images.web
      gateway_image          = var.images.gateway
      runner_image           = var.images.runner
      runtime_image          = var.images.runtime
      postgres_image         = var.images.postgres
      proxy_image            = var.images.proxy
      files                  = local.deployment_files
    })
  }
  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }
  scheduling {
    automatic_restart   = true
    on_host_maintenance = "MIGRATE"
    provisioning_model  = "STANDARD"
  }
  depends_on = [
    google_compute_disk_resource_policy_attachment.snapshots,
    google_project_iam_member.vm_project_roles,
    google_secret_manager_secret_iam_member.vm_access,
    google_storage_bucket_iam_member.vm_backups,
  ]
}

resource "google_monitoring_uptime_check_config" "https" {
  display_name = "${var.name} HTTPS"
  timeout      = "10s"
  period       = "60s"
  checker_type = "STATIC_IP_CHECKERS"
  monitored_resource {
    type = "uptime_url"
    labels = {
      host       = var.domain
      project_id = var.project_id
    }
  }
  http_check {
    path         = "/"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }
  depends_on = [google_project_service.required]
}

resource "google_monitoring_alert_policy" "availability" {
  display_name = "${var.name}: HTTPS availability below 99.5%"
  combiner     = "OR"
  severity     = "CRITICAL"
  documentation {
    content   = "The public endpoint is failing. Check agent-workspace.service, Docker health, disk space, and the rollback runbook."
    mime_type = "text/markdown"
  }
  conditions {
    display_name = "Uptime check failures"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\""
      comparison      = "COMPARISON_LT"
      threshold_value = 0.995
      duration        = "300s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_FRACTION_TRUE"
        cross_series_reducer = "REDUCE_MEAN"
        group_by_fields      = ["resource.label.host"]
      }
      trigger { count = 1 }
    }
  }
}

resource "google_monitoring_alert_policy" "cpu" {
  display_name = "${var.name}: VM CPU saturation"
  combiner     = "OR"
  severity     = "WARNING"
  documentation {
    content   = "CPU utilization exceeded 85% for 15 minutes on the single production VM."
    mime_type = "text/markdown"
  }
  conditions {
    display_name = "CPU > 85%"
    condition_threshold {
      filter          = "metric.type=\"compute.googleapis.com/instance/cpu/utilization\" AND resource.type=\"gce_instance\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.85
      duration        = "900s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }
      trigger { count = 1 }
    }
  }
}

resource "google_monitoring_service" "main" {
  service_id   = replace(var.name, "-", "_")
  display_name = "Agent Workspace"
  basic_service {
    service_type   = "custom"
    service_labels = { location = var.zone }
  }
}

resource "google_monitoring_slo" "availability" {
  service             = google_monitoring_service.main.service_id
  slo_id              = "https-availability"
  display_name        = "30-day HTTPS availability"
  goal                = 0.995
  rolling_period_days = 30
  basic_sli {
    availability {}
  }
}

resource "google_monitoring_dashboard" "operations" {
  dashboard_json = templatefile("${path.module}/../../observability/cloud-monitoring-dashboard.json.tftpl", {
    project_id = var.project_id
    vm_name    = google_compute_instance.main.name
    zone       = var.zone
    domain     = var.domain
  })
}
