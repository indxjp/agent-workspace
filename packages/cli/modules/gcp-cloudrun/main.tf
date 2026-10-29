locals {
  required_apis = toset([
    "run.googleapis.com",
    "cloudbuild.googleapis.com",
    "sqladmin.googleapis.com",
    "sql-component.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudkms.googleapis.com",
    "artifactregistry.googleapis.com",
    "storage.googleapis.com",
    "iam.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
  ])
  common_labels = {
    application = "agent-workspace"
    managed-by  = "terraform"
  }
  cloud_sql_proxy_image = "gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.14.0"
}

resource "google_project_service" "required" {
  for_each           = local.required_apis
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

# ── Service accounts ──────────────────────────────────────────────────────────────────────────────

resource "google_service_account" "web" {
  account_id   = "${var.name}-web"
  display_name = "Agent Workspace web control plane"
  depends_on   = [google_project_service.required]
}

resource "google_service_account" "gateway" {
  account_id   = "${var.name}-gateway"
  display_name = "Agent Workspace model gateway"
  depends_on   = [google_project_service.required]
}

resource "google_service_account" "runner_manager" {
  account_id   = "${var.name}-runner-mgr"
  display_name = "Agent Workspace runner manager (Cloud Run driver)"
  depends_on   = [google_project_service.required]
}

# The identity every ephemeral per-session Cloud Run runtime service runs as. Deliberately narrow:
# it holds no project role at all (see docs/adr/ADR-cloud-run-service-driver.md) — it reaches the
# gateway with a short-lived, run-scoped bearer token delivered in the request body, the same way
# the docker and kubernetes drivers already work, not through GCP IAM.
resource "google_service_account" "runtime" {
  account_id   = "${var.name}-runtime"
  display_name = "Agent Workspace per-session runtime (cloud-run-service driver)"
  depends_on   = [google_project_service.required]
}

# ── The runner manager needs to create/delete Cloud Run services (the driver's create()/destroy())
# and to deploy them running as the runtime service account, plus invoke the private ones it stood
# up. `run.developer` deliberately does not include setIamPolicy — this driver never calls it; the
# invoker grant below is what authorizes the manager instead. ────────────────────────────────────

#
# Both grants are conditioned to the services the driver creates, which it always names `rt-<id>`
# (packages/runtime/src/cloud-run.ts). Without the condition a leaked RUNNER_MANAGER_TOKEN could
# redeploy or delete web, the gateway and the manager itself, and call every private service.
# Non-service resources (locations, operations, revisions) stay unconditioned so a create, whose
# check may be made against the parent location, still succeeds.

locals {
  runtime_services_only = <<-CEL
    resource.type != "run.googleapis.com/Service" ||
    resource.name.extract("/services/{service}").startsWith("rt-")
  CEL
}

resource "google_project_iam_member" "runner_manager_run_developer" {
  project = var.project_id
  role    = "roles/run.developer"
  member  = google_service_account.runner_manager.member
  condition {
    title      = "runtime-services-only"
    expression = local.runtime_services_only
  }
}

resource "google_project_iam_member" "runner_manager_run_invoker" {
  project = var.project_id
  role    = "roles/run.invoker"
  member  = google_service_account.runner_manager.member
  condition {
    title      = "runtime-services-only"
    expression = local.runtime_services_only
  }
}

resource "google_service_account_iam_member" "runner_manager_acts_as_runtime" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.runner_manager.member
}

# Cloud Run's create-service API validates the *deploying* principal's access to the referenced
# image at request time, separately from the runtime pull the Cloud Run service agent performs —
# without this, `cloud-run.ts`'s create() fails with `artifactregistry.repositories.downloadArtifacts
# denied` even though the same repo already serves the three Terraform-deployed services fine.
resource "google_artifact_registry_repository_iam_member" "runner_manager_artifact_reader" {
  project    = var.project_id
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.repository_id
  role       = "roles/artifactregistry.reader"
  member     = google_service_account.runner_manager.member
}

resource "google_project_iam_member" "web_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = google_service_account.web.member
}

resource "google_project_iam_member" "gateway_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = google_service_account.gateway.member
}

# ── Cloud Build ───────────────────────────────────────────────────────────────────────────────────
# Projects created after Google stopped auto-granting `roles/editor` to the default Compute Engine
# service account start with that account holding no project roles at all. `gcloud builds submit`
# with no `serviceAccount:` in its build config runs as exactly that account (the dedicated
# `<project-number>@cloudbuild.gserviceaccount.com` identity cannot be set via `build.service_account`
# — Cloud Build rejects it as not "user-managed"), so it is this account, not the Cloud Build service
# agent, that needs to read its own staged source, push to Artifact Registry, and write build logs.

data "google_project" "current" {}

resource "google_project_iam_member" "cloudbuild_storage_viewer" {
  project = var.project_id
  role    = "roles/storage.objectViewer"
  member  = "serviceAccount:${data.google_project.current.number}-compute@developer.gserviceaccount.com"
}

resource "google_project_iam_member" "cloudbuild_artifact_writer" {
  project = var.project_id
  role    = "roles/artifactregistry.writer"
  member  = "serviceAccount:${data.google_project.current.number}-compute@developer.gserviceaccount.com"
}

resource "google_project_iam_member" "cloudbuild_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${data.google_project.current.number}-compute@developer.gserviceaccount.com"
}

# ── Cloud SQL ─────────────────────────────────────────────────────────────────────────────────────

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "google_sql_database_instance" "main" {
  name                = "${var.name}-pg"
  database_version    = "POSTGRES_16"
  region              = var.region
  deletion_protection = true
  settings {
    tier    = var.db_tier
    edition = "ENTERPRISE" # ENTERPRISE_PLUS, this org's project default, rejects shared-core tiers
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }
  }
  depends_on = [google_project_service.required]
}

resource "google_sql_database" "main" {
  name     = "agent_workspace"
  instance = google_sql_database_instance.main.name
}

resource "google_sql_user" "main" {
  name     = "agent_workspace"
  instance = google_sql_database_instance.main.name
  password = random_password.db.result
}

# ── Object storage ────────────────────────────────────────────────────────────────────────────────

# Native GCS bucket the application's AW_STORAGE_URL names (the storage design, §04).
resource "google_storage_bucket" "objects" {
  name     = "${var.project_id}-${var.name}-objects"
  location = var.region
  # Workload identity authorizes through IAM. Legacy per-object ACLs are deliberately unavailable.
  uniform_bucket_level_access = true
  force_destroy               = true # test/demo deployment; tighten before any real data lands
  labels                      = local.common_labels
  depends_on                  = [google_project_service.required]
}

resource "google_storage_bucket_iam_member" "web_objects" {
  bucket = google_storage_bucket.objects.name
  role   = "roles/storage.objectAdmin"
  member = google_service_account.web.member
}

# The provider's startup readiness probe reads bucket metadata. objectAdmin deliberately grants
# object operations only, so this legacy bucket role supplies storage.buckets.get without adding
# project-wide bucket visibility.
resource "google_storage_bucket_iam_member" "web_objects_metadata" {
  bucket = google_storage_bucket.objects.name
  role   = "roles/storage.legacyBucketReader"
  member = google_service_account.web.member
}

# Mounted via Cloud Storage FUSE straight into the web container for AW_*_ROOT (session files,
# skills, transcripts, runtime-verification state) — Cloud Run's own filesystem is ephemeral.
resource "google_storage_bucket" "state" {
  name                        = "${var.project_id}-${var.name}-state"
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = true
  labels                      = local.common_labels
  depends_on                  = [google_project_service.required]
}

resource "google_storage_bucket_iam_member" "web_state" {
  bucket = google_storage_bucket.state.name
  role   = "roles/storage.objectAdmin"
  member = google_service_account.web.member
}

# ── Artifact Registry ─────────────────────────────────────────────────────────────────────────────

resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = var.name
  description   = "Agent Workspace Cloud Run deployment images"
  format        = "DOCKER"
  depends_on    = [google_project_service.required]
}

# ── Secrets ───────────────────────────────────────────────────────────────────────────────────────
# Spec §37's minimal set, generated here rather than typed by an operator: this is a from-scratch
# test/demo stack, not gcp-small's "bring your own numbered secret versions" flow.

resource "random_id" "master_encryption_key" {
  byte_length = 32
}

resource "random_id" "session_secret" {
  byte_length = 32
}

resource "random_id" "gateway_token_secret" {
  byte_length = 32
}

resource "random_password" "runner_manager_token" {
  length  = 48
  special = false
}

resource "random_password" "bootstrap_admin_password" {
  length  = 24
  special = true
}

locals {
  secret_values = {
    "${var.name}-database-url"             = "postgres://agent_workspace:${random_password.db.result}@127.0.0.1:5432/agent_workspace"
    "${var.name}-gateway-token-secret"     = random_id.gateway_token_secret.hex
    "${var.name}-session-secret"           = random_id.session_secret.hex
    "${var.name}-runner-manager-token"     = random_password.runner_manager_token.result
    "${var.name}-bootstrap-admin-password" = random_password.bootstrap_admin_password.result
  }
}

# Secret Manager encrypts the application master key under a dedicated regional Cloud KMS key.
# Rotating the primary KMS version changes the wrapping key for new secret versions without
# changing the application's 32-byte plaintext or its persisted fingerprint (ADR-0059).
resource "google_project_service_identity" "secret_manager" {
  provider   = google-beta
  project    = var.project_id
  service    = "secretmanager.googleapis.com"
  depends_on = [google_project_service.required]
}

resource "google_kms_key_ring" "secrets" {
  name     = "${var.name}-secrets"
  location = var.region
  project  = var.project_id
  depends_on = [
    google_project_service.required,
  ]
}

resource "google_kms_crypto_key" "secret_manager" {
  name            = "master-key-cmek"
  key_ring        = google_kms_key_ring.secrets.id
  rotation_period = "7776000s"
}

resource "google_kms_crypto_key_iam_member" "secret_manager" {
  crypto_key_id = google_kms_crypto_key.secret_manager.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_project_service_identity.secret_manager.email}"
}

resource "google_secret_manager_secret" "master_key" {
  secret_id = "${var.name}-master-encryption-key"
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

resource "google_secret_manager_secret_version" "master_key" {
  secret      = google_secret_manager_secret.master_key.id
  secret_data = random_id.master_encryption_key.hex
}

resource "google_secret_manager_secret" "deployment" {
  for_each  = local.secret_values
  secret_id = each.key
  replication {
    auto {}
  }
  labels     = local.common_labels
  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_version" "deployment" {
  for_each    = local.secret_values
  secret      = google_secret_manager_secret.deployment[each.key].id
  secret_data = each.value
}

resource "google_secret_manager_secret_iam_member" "web_access" {
  for_each = toset([
    "${var.name}-database-url",
    "${var.name}-gateway-token-secret",
    "${var.name}-session-secret",
    "${var.name}-bootstrap-admin-password",
    "${var.name}-runner-manager-token",
  ])
  project   = var.project_id
  secret_id = google_secret_manager_secret.deployment[each.value].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.web.member
}

resource "google_secret_manager_secret_iam_member" "gateway_access" {
  for_each = toset([
    "${var.name}-database-url",
    "${var.name}-gateway-token-secret",
  ])
  project   = var.project_id
  secret_id = google_secret_manager_secret.deployment[each.value].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.gateway.member
}

resource "google_secret_manager_secret_iam_member" "web_master_key_access" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.master_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.web.member
}

resource "google_secret_manager_secret_iam_member" "gateway_master_key_access" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.master_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.gateway.member
}

resource "google_secret_manager_secret_iam_member" "runner_manager_access" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.deployment["${var.name}-runner-manager-token"].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.runner_manager.member
}

# ── Cloud Run: gateway ────────────────────────────────────────────────────────────────────────────
# `--allow-unauthenticated` at the Cloud Run IAM layer, deliberately: apps/web and the runtime
# containers authenticate to it with GATEWAY_TOKEN_SECRET, an application-level bearer the app was
# already written to use (packages/gateway/src/auth.ts) — not a GCP identity token. The application
# layer is the real gate here, the same way it is for `docker`/`kubernetes` deployments; see
# docs/adr/ADR-cloud-run-service-driver.md for why this driver does not attempt VPC-level isolation
# on Cloud Run for these two long-lived services.

resource "google_cloud_run_v2_service" "gateway" {
  name                = "${var.name}-gateway"
  location            = var.region
  project             = var.project_id
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account = google_service_account.gateway.email
    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }
    containers {
      name  = "gateway"
      image = var.images.gateway
      ports {
        container_port = 4000
      }
      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
      env {
        name  = "GATEWAY_PRICING_JSON"
        value = var.gateway_pricing_json
      }
      env {
        # aw-control MCP calls go to web at its deterministic Cloud Run URL: the web service's `uri`
        # would be a cycle, since web already depends on this service for MODEL_GATEWAY_URL.
        name  = "GATEWAY_CONTROL_PLANE_ORIGIN"
        value = "https://${var.name}-web-${data.google_project.current.number}.${var.region}.run.app"
      }
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.deployment["${var.name}-database-url"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "MASTER_KEY_PROVIDER"
        value = "secret-manager"
      }
      env {
        name  = "GCP_MASTER_KEY_SECRET"
        value = "${google_secret_manager_secret.master_key.id}/versions/latest"
      }
      env {
        name = "GATEWAY_TOKEN_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.deployment["${var.name}-gateway-token-secret"].secret_id
            version = "latest"
          }
        }
      }
      depends_on = ["cloud-sql-proxy"]
    }
    containers {
      name  = "cloud-sql-proxy"
      image = local.cloud_sql_proxy_image
      args = [
        "--structured-logs",
        "--address=0.0.0.0",
        "--port=5432",
        google_sql_database_instance.main.connection_name,
      ]
      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
      # Required by the API whenever another container's `depends_on` names this one — Cloud Run
      # has no way to know the proxy is ready to accept connections otherwise.
      startup_probe {
        tcp_socket {
          port = 5432
        }
        initial_delay_seconds = 0
        period_seconds        = 1
        failure_threshold     = 20
      }
    }
  }
  depends_on = [
    google_secret_manager_secret_iam_member.gateway_access,
    google_secret_manager_secret_iam_member.gateway_master_key_access,
    google_project_iam_member.gateway_cloudsql_client,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "gateway_public" {
  name     = google_cloud_run_v2_service.gateway.name
  location = google_cloud_run_v2_service.gateway.location
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ── Cloud Run: runner manager ─────────────────────────────────────────────────────────────────────
# Same `--allow-unauthenticated` reasoning as the gateway: apps/web authenticates with
# RUNNER_MANAGER_TOKEN, not a GCP identity token. What Cloud Run IAM *does* gate here is the
# manager's own outbound calls into the ephemeral per-session services it creates — those carry a
# real Google-signed identity token (RunnerManagerOptions.runtimeAuthHeaders), which the manager can
# mint because it runs as google_service_account.runner_manager.

resource "google_cloud_run_v2_service" "runner_manager" {
  name                = "${var.name}-runner-mgr"
  location            = var.region
  project             = var.project_id
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account = google_service_account.runner_manager.email
    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }
    containers {
      name  = "runner-manager"
      image = var.images.runner
      ports {
        container_port = 8090
      }
      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "RUNTIME_DRIVER"
        value = "cloud-run-service"
      }
      env {
        # ENG-07 (ADR-0073): one runtime image per engine, keyed by engine id.
        name  = "AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK"
        value = var.images.runtime
      }
      env {
        name  = "GCP_PROJECT"
        value = var.project_id
      }
      env {
        name  = "GCP_REGION"
        value = var.region
      }
      env {
        name  = "RUNTIME_SERVICE_ACCOUNT"
        value = google_service_account.runtime.email
      }
      env {
        # A brand-new Cloud Run service's default URL needs longer than the 30s default to become
        # reachable end-to-end (routing/DNS, not just the revision reporting ready) — unlike
        # docker/kubernetes, where the manager reaches an address on a network it is already on.
        name  = "RUNTIME_VERIFICATION_TIMEOUT_MS"
        value = "150000"
      }
      env {
        name = "RUNNER_MANAGER_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.deployment["${var.name}-runner-manager-token"].secret_id
            version = "latest"
          }
        }
      }
    }
  }
  depends_on = [
    google_secret_manager_secret_iam_member.runner_manager_access,
    google_project_iam_member.runner_manager_run_developer,
    google_project_iam_member.runner_manager_run_invoker,
    google_service_account_iam_member.runner_manager_acts_as_runtime,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "runner_manager_public" {
  name     = google_cloud_run_v2_service.runner_manager.name
  location = google_cloud_run_v2_service.runner_manager.location
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ── Cloud Run: web control plane ──────────────────────────────────────────────────────────────────
# Public: this is the application's own front door, gated by its session-cookie sign-in
# (BOOTSTRAP_ADMIN / BOOTSTRAP_ADMIN_PASSWORD), not by Cloud Run IAM.

resource "google_cloud_run_v2_service" "web" {
  name                = "${var.name}-web"
  location            = var.region
  project             = var.project_id
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account = google_service_account.web.email
    scaling {
      min_instance_count = 0
      max_instance_count = var.web_max_instance_count
    }
    volumes {
      name = "state"
      gcs {
        bucket    = google_storage_bucket.state.name
        read_only = false
      }
    }
    containers {
      name  = "web"
      image = var.images.web
      ports {
        container_port = 3000
      }
      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
      }
      volume_mounts {
        name       = "state"
        mount_path = "/var/lib/agent-workspace"
      }
      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        # ENG-07 (ADR-0073): the control plane reports an engine installed, and accepts a run on
        # it, only when it has that engine's runtime image — the same map the runner manager reads.
        name  = "AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK"
        value = var.images.runtime
      }
      env {
        name  = "BOOTSTRAP_ADMIN"
        value = var.bootstrap_admin_email
      }
      env {
        # The project's policy ceiling; its promotion.minEvalScore gates promotion to production
        # (issue #797). Blank means no ceiling.
        name  = "AW_DEPLOYMENT_POLICY"
        value = var.deployment_policy
      }
      dynamic "env" {
        # ADR-0135: the origin A2A agent cards advertise. Absent when unset, so an existing service
        # gets no new revision.
        for_each = var.public_url == "" ? [] : [var.public_url]
        content {
          name  = "AW_PUBLIC_URL"
          value = env.value
        }
      }
      env {
        # One setting for where files, skills and session transcripts live (the storage design, §04).
        name  = "AW_STORAGE_URL"
        value = "gcs://${google_storage_bucket.objects.name}?project=${var.project_id}"
      }
      dynamic "env" {
        # Absent when unset, so the server default applies and an existing service gets no new revision.
        for_each = var.storage_signed_upload_max_bytes == null ? [] : [var.storage_signed_upload_max_bytes]
        content {
          name  = "AW_STORAGE_SIGNED_UPLOAD_MAX_BYTES"
          value = tostring(env.value)
        }
      }
      env {
        name  = "AW_RUNTIME_VERIFICATION_FILE"
        value = "/var/lib/agent-workspace/runtime-verifications.json"
      }
      env {
        name  = "RUNNER_MANAGER_URL"
        value = google_cloud_run_v2_service.runner_manager.uri
      }
      env {
        name  = "RUNTIME_DRIVER"
        value = "cloud-run-service"
      }
      env {
        name  = "MODEL_GATEWAY_URL"
        value = google_cloud_run_v2_service.gateway.uri
      }
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.deployment["${var.name}-database-url"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "MASTER_KEY_PROVIDER"
        value = "secret-manager"
      }
      env {
        name  = "GCP_MASTER_KEY_SECRET"
        value = "${google_secret_manager_secret.master_key.id}/versions/latest"
      }
      env {
        name = "GATEWAY_TOKEN_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.deployment["${var.name}-gateway-token-secret"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "SESSION_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.deployment["${var.name}-session-secret"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "BOOTSTRAP_ADMIN_PASSWORD"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.deployment["${var.name}-bootstrap-admin-password"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "RUNNER_MANAGER_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.deployment["${var.name}-runner-manager-token"].secret_id
            version = "latest"
          }
        }
      }
      depends_on = ["cloud-sql-proxy"]
    }
    containers {
      name  = "cloud-sql-proxy"
      image = local.cloud_sql_proxy_image
      args = [
        "--structured-logs",
        "--address=0.0.0.0",
        "--port=5432",
        google_sql_database_instance.main.connection_name,
      ]
      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
      # Required by the API whenever another container's `depends_on` names this one — Cloud Run
      # has no way to know the proxy is ready to accept connections otherwise.
      startup_probe {
        tcp_socket {
          port = 5432
        }
        initial_delay_seconds = 0
        period_seconds        = 1
        failure_threshold     = 20
      }
    }
  }
  depends_on = [
    google_secret_manager_secret_iam_member.web_access,
    google_secret_manager_secret_iam_member.web_master_key_access,
    google_project_iam_member.web_cloudsql_client,
    google_storage_bucket_iam_member.web_objects,
    google_storage_bucket_iam_member.web_objects_metadata,
    google_storage_bucket_iam_member.web_state,
    google_cloud_run_v2_service.gateway,
    google_cloud_run_v2_service.runner_manager,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "web_public" {
  name     = google_cloud_run_v2_service.web.name
  location = google_cloud_run_v2_service.web.location
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = "allUsers"
}
