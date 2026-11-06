data "google_project" "current" {}

locals {
  required_apis = toset([
    "run.googleapis.com",
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
    "compute.googleapis.com",
    "servicenetworking.googleapis.com",
    "dns.googleapis.com",
    "aiplatform.googleapis.com",
  ])
  # Only needed (and only enabled) when IAP fronts web, so the default stack is unchanged.
  iap_api = "iap.googleapis.com"
  common_labels = {
    application = "agent-workspace"
    managed-by  = "terraform"
  }
  # D-12: one size knob instead of per-resource tuning variables.
  size = {
    small = {
      db_tier            = "db-f1-micro"
      db_availability    = "ZONAL"
      gateway_min        = 0
      runner_manager_min = 0
      web_min            = 1
      sandbox_alert_cap  = 20
    }
    standard = {
      db_tier            = "db-custom-2-7680"
      db_availability    = "REGIONAL"
      gateway_min        = 1
      runner_manager_min = 1
      web_min            = 1
      sandbox_alert_cap  = 100
    }
  }[var.size]
  cloud_sql_proxy_image = "gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.14.0"
  # web's own public origin: the deterministic Cloud Run URL, because the web service's `uri` would
  # be a cycle (web depends on the gateway, which is told where web is).
  run_app_origin = "https://${var.name}-web-${data.google_project.current.number}.${var.region}.run.app"
  # With a custom domain the browser-facing origin (the OIDC redirect URI) is the domain.
  web_origin = var.domain == "" ? local.run_app_origin : "https://${var.domain}"
  # IAP fronts web only when there is a load balancer to put it on.
  iap_enabled = var.iap && var.domain != ""
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

# The runtime image is not always in that repository: `aw deploy` copies only images that are not
# already in Artifact Registry, and uses one that is (an operator's own repository, CI's staging
# repository) in place. The manager names var.images.runtime in every create, so it also reads the
# repository that image is in, and only that one. terraform_data.input_checks refuses a runtime
# image outside this project's Artifact Registry, which this module cannot grant on.
locals {
  runtime_image_repository = try(
    regex("^(?P<location>[a-z0-9-]+)-docker\\.pkg\\.dev/(?P<project>[a-z][a-z0-9-]*[a-z0-9])/(?P<repository>[a-z][a-z0-9-]*)/", var.images.runtime),
    null,
  )
  runtime_image_in_project = try(local.runtime_image_repository.project == var.project_id, false)
  runtime_image_elsewhere = local.runtime_image_in_project && !(
    local.runtime_image_repository.location == var.region &&
    local.runtime_image_repository.repository == var.name
  )
}

resource "google_artifact_registry_repository_iam_member" "runner_manager_runtime_image_reader" {
  count      = local.runtime_image_elsewhere ? 1 : 0
  project    = var.project_id
  location   = local.runtime_image_repository.location
  repository = local.runtime_image_repository.repository
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

# Earlier versions granted the project's default Compute Engine service account three roles for
# Cloud Build. Forget them without revoking: the grant may be shared with something outside this module.
removed {
  from = google_project_iam_member.cloudbuild_storage_viewer
  lifecycle {
    destroy = false
  }
}

removed {
  from = google_project_iam_member.cloudbuild_artifact_writer
  lifecycle {
    destroy = false
  }
}

removed {
  from = google_project_iam_member.cloudbuild_log_writer
  lifecycle {
    destroy = false
  }
}

# D-3: only the gateway calls Claude on Vertex AI; the web and runtime service accounts hold no Vertex role.
resource "google_project_iam_member" "gateway_aiplatform_user" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = google_service_account.gateway.member
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
  deletion_protection = var.data_protection
  settings {
    tier              = local.size.db_tier
    availability_type = local.size.db_availability
    edition           = "ENTERPRISE" # ENTERPRISE_PLUS, this org's project default, rejects shared-core tiers
    ip_configuration {
      ipv4_enabled    = false
      private_network = local.network_id
      ssl_mode        = "ENCRYPTED_ONLY"
    }
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = 14
        retention_unit   = "COUNT"
      }
    }
    # Sunday 18:00 UTC is Monday 03:00 in Tokyo.
    maintenance_window {
      day          = 7
      hour         = 18
      update_track = "stable"
    }
  }
  depends_on = [
    google_project_service.required,
    google_service_networking_connection.psa,
  ]
}

resource "google_sql_database" "main" {
  name     = "agent_workspace"
  instance = google_sql_database_instance.main.name
}

# The application's migrations make this role own the schema's tables, and Cloud SQL refuses to
# drop a PostgreSQL role that owns objects ("role cannot be dropped because some objects depend on
# it"), so a destroy that deletes the user fails. ABANDON removes it from state only: the role goes
# with the instance. The database keeps the default DELETE: it drops once the services are gone.
resource "google_sql_user" "main" {
  name            = "agent_workspace"
  instance        = google_sql_database_instance.main.name
  password        = random_password.db.result
  deletion_policy = "ABANDON"
}

# ── Object storage ────────────────────────────────────────────────────────────────────────────────

# Native GCS bucket the application's AW_STORAGE_URL names (the storage design, §04).
resource "google_storage_bucket" "objects" {
  name     = "${var.project_id}-${var.name}-objects"
  location = var.region
  # Workload identity authorizes through IAM. Legacy per-object ACLs are deliberately unavailable.
  uniform_bucket_level_access = true
  force_destroy               = !var.data_protection
  labels                      = local.common_labels
  versioning {
    enabled = true
  }
  soft_delete_policy {
    retention_duration_seconds = 604800
  }
  # Versioning must not grow without bound.
  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 30
    }
    action {
      type = "Delete"
    }
  }
  depends_on = [google_project_service.required]
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
  force_destroy               = !var.data_protection
  labels                      = local.common_labels
  versioning {
    enabled = true
  }
  soft_delete_policy {
    retention_duration_seconds = 604800
  }
  # Versioning must not grow without bound.
  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 30
    }
    action {
      type = "Delete"
    }
  }
  depends_on = [google_project_service.required]
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

# The Secret Manager service agent is created on the project's first request for it, and
# generateServiceIdentity returns its email before IAM can resolve it: a binding made at once fails
# with "Service account ... does not exist". Waiting once, on create, lets the new agent propagate;
# the binding reads the member through the wait, so the order needs no depends_on.
resource "time_sleep" "secret_manager_identity" {
  create_duration = "60s"
  triggers = {
    member = google_project_service_identity.secret_manager.member
  }
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
  member        = time_sleep.secret_manager_identity.triggers["member"]
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
# already written to use (packages/gateway/src/auth.ts) - not a GCP identity token. Sandboxes cannot
# present Google ID tokens, so the run token stays the gate. Its ingress is internal: web and the
# sandboxes reach it at the internal load balancer in network.tf (local.gateway_internal_url), the
# only address the sandbox firewall allows. Its own Direct VPC egress is its private route to Cloud SQL.

resource "google_cloud_run_v2_service" "gateway" {
  name                = local.gateway_service_name
  location            = var.region
  project             = var.project_id
  ingress             = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  deletion_protection = var.data_protection

  # Service-level scaling, declared to match what the API reads back. The google provider (6.50.0)
  # gives this block no Computed default, yet its read-back of a service fills it as
  # { min_instance_count = 0, manual_instance_count = 0 } (scaling_mode left unset), so leaving it
  # out plans a removal on every apply — a perpetual 3-to-change diff. Zeros are dropped by the
  # provider's expand (IsEmptyValue), so declaring them sends nothing new: the service keeps
  # AUTOMATIC scaling and the template-level min/max below. manual_instance_count only applies in
  # MANUAL mode; it is 0 here solely so the plan converges. scaling_mode is left unset on purpose:
  # the read-back leaves it empty, so declaring "AUTOMATIC" would risk trading one diff for another.
  # The per-size minimum lives on the template-level scaling block below, not here.
  scaling {
    min_instance_count    = 0
    manual_instance_count = 0
  }

  template {
    service_account = google_service_account.gateway.email
    vpc_access {
      network_interfaces {
        network    = local.network_id
        subnetwork = local.services_subnet_id
      }
      egress = "PRIVATE_RANGES_ONLY"
    }
    scaling {
      min_instance_count = local.size.gateway_min
      max_instance_count = 2
    }
    containers {
      name  = "gateway"
      image = var.images.gateway
      ports {
        container_port = 4000
      }
      resources {
        startup_cpu_boost = true
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
        # Opts the gateway in to keyless Vertex AI calls as its own service account, for this
        # project only; a connection naming any other project is refused.
        name  = "GATEWAY_VERTEX_PROJECT_ID"
        value = var.project_id
      }
      env {
        # aw-control MCP calls go to web at its deterministic Cloud Run URL: the web service's `uri`
        # would be a cycle, since web already depends on this service for MODEL_GATEWAY_URL.
        name = "GATEWAY_CONTROL_PLANE_ORIGIN"
        # Always the run.app URL, even with a domain: the gateway reaches web through the VPC, and
        # internal-and-load-balancer ingress accepts internal traffic, so it bypasses the domain.
        value = local.run_app_origin
      }
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.deployment["${var.name}-database-url"].secret_id
            version = google_secret_manager_secret_version.deployment["${var.name}-database-url"].version
          }
        }
      }
      env {
        name  = "MASTER_KEY_PROVIDER"
        value = "secret-manager"
      }
      env {
        name  = "GCP_MASTER_KEY_SECRET"
        value = "${google_secret_manager_secret.master_key.id}/versions/${google_secret_manager_secret_version.master_key.version}"
      }
      env {
        name = "GATEWAY_TOKEN_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.deployment["${var.name}-gateway-token-secret"].secret_id
            version = google_secret_manager_secret_version.deployment["${var.name}-gateway-token-secret"].version
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
        "--private-ip",
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
    # The gateway connects at start; without these it can start before its database user exists.
    google_sql_database.main,
    google_sql_user.main,
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
# Internal ingress, and no allUsers binding: only callers inside the project's network that Cloud Run
# IAM lets in can reach it. web is the one caller - it authenticates with a Google ID token for the
# manager's URL (sent in X-Serverless-Authorization, the audience is RUNNER_MANAGER_ID_TOKEN_AUDIENCE)
# plus RUNNER_MANAGER_TOKEN. The manager's own outbound calls into the ephemeral per-session
# services it creates carry a Google-signed identity token (RunnerManagerOptions.runtimeAuthHeaders),
# which it can mint because it runs as google_service_account.runner_manager. It has Direct VPC egress
# (private ranges only) so it reaches those internal services privately, the way web reaches it. The
# runtime service account they run as holds no role.

resource "google_cloud_run_v2_service" "runner_manager" {
  name                = "${var.name}-runner-mgr"
  location            = var.region
  project             = var.project_id
  ingress             = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  deletion_protection = var.data_protection

  # Service-level scaling: declared so the plan converges; see the gateway service for why.
  scaling {
    min_instance_count    = 0
    manual_instance_count = 0
  }

  template {
    service_account = google_service_account.runner_manager.email
    vpc_access {
      network_interfaces {
        network    = local.network_id
        subnetwork = local.services_subnet_id
      }
      egress = "PRIVATE_RANGES_ONLY"
    }
    scaling {
      min_instance_count = local.size.runner_manager_min
      max_instance_count = 3
    }
    containers {
      name  = "runner-manager"
      image = var.images.runner
      ports {
        container_port = 8090
      }
      resources {
        startup_cpu_boost = true
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
        name  = "RUNTIME_NETWORK"
        value = local.network_id
      }
      env {
        name  = "RUNTIME_SUBNETWORK"
        value = local.sandbox_subnet_id
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
            version = google_secret_manager_secret_version.deployment["${var.name}-runner-manager-token"].version
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

resource "google_cloud_run_v2_service_iam_member" "web_invokes_runner_manager" {
  name     = google_cloud_run_v2_service.runner_manager.name
  location = google_cloud_run_v2_service.runner_manager.location
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = google_service_account.web.member
}

# ── Cloud Run: web control plane ──────────────────────────────────────────────────────────────────
# Public: this is the application's own front door, gated by its session-cookie sign-in
# (BOOTSTRAP_ADMIN / BOOTSTRAP_ADMIN_PASSWORD), not by Cloud Run IAM.

resource "google_cloud_run_v2_service" "web" {
  name                = "${var.name}-web"
  location            = var.region
  project             = var.project_id
  ingress             = var.domain == "" ? "INGRESS_TRAFFIC_ALL" : "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  deletion_protection = var.data_protection

  # Service-level scaling: declared so the plan converges; see the gateway service for why.
  scaling {
    min_instance_count    = 0
    manual_instance_count = 0
  }

  template {
    service_account = google_service_account.web.email
    vpc_access {
      network_interfaces {
        network    = local.network_id
        subnetwork = local.services_subnet_id
      }
      egress = "PRIVATE_RANGES_ONLY"
    }
    scaling {
      min_instance_count = local.size.web_min
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
        startup_cpu_boost = true
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
        # ADR-0160 D5: the features this deployment installs. Absent when unset, so an existing
        # service gets no new revision and installs every feature.
        for_each = var.deployment_features == "" ? [] : [var.deployment_features]
        content {
          name  = "AW_DEPLOYMENT_FEATURES"
          value = env.value
        }
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
        # The gateway's internal load balancer, not its run.app URL: web hands this address to every
        # sandbox, whose firewall allows nothing else.
        name  = "MODEL_GATEWAY_URL"
        value = local.gateway_internal_url
      }
      env {
        # D-1: setup's default model connection is Claude on this install's own Vertex AI.
        name  = "AW_VERTEX_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "AW_VERTEX_LOCATION"
        value = var.vertex_location
      }
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.deployment["${var.name}-database-url"].secret_id
            version = google_secret_manager_secret_version.deployment["${var.name}-database-url"].version
          }
        }
      }
      env {
        name  = "MASTER_KEY_PROVIDER"
        value = "secret-manager"
      }
      env {
        name  = "GCP_MASTER_KEY_SECRET"
        value = "${google_secret_manager_secret.master_key.id}/versions/${google_secret_manager_secret_version.master_key.version}"
      }
      env {
        name = "GATEWAY_TOKEN_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.deployment["${var.name}-gateway-token-secret"].secret_id
            version = google_secret_manager_secret_version.deployment["${var.name}-gateway-token-secret"].version
          }
        }
      }
      env {
        name = "SESSION_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.deployment["${var.name}-session-secret"].secret_id
            version = google_secret_manager_secret_version.deployment["${var.name}-session-secret"].version
          }
        }
      }
      env {
        name = "BOOTSTRAP_ADMIN_PASSWORD"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.deployment["${var.name}-bootstrap-admin-password"].secret_id
            version = google_secret_manager_secret_version.deployment["${var.name}-bootstrap-admin-password"].version
          }
        }
      }
      env {
        name = "RUNNER_MANAGER_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.deployment["${var.name}-runner-manager-token"].secret_id
            version = google_secret_manager_secret_version.deployment["${var.name}-runner-manager-token"].version
          }
        }
      }
      env {
        # The audience of the Google ID token web sends to the internal runner manager.
        name  = "RUNNER_MANAGER_ID_TOKEN_AUDIENCE"
        value = google_cloud_run_v2_service.runner_manager.uri
      }
      # Single sign-on: absent when unset, so an existing service gets no new revision.
      dynamic "env" {
        for_each = var.oidc_issuer == "" ? [] : [1]
        content {
          name  = "OIDC_ISSUER_URL"
          value = var.oidc_issuer
        }
      }
      dynamic "env" {
        for_each = var.oidc_issuer == "" ? [] : [1]
        content {
          name  = "OIDC_CLIENT_ID"
          value = var.oidc_client_id
        }
      }
      dynamic "env" {
        for_each = var.oidc_issuer == "" ? [] : [1]
        content {
          name = "OIDC_CLIENT_SECRET"
          value_source {
            secret_key_ref {
              secret = google_secret_manager_secret.oidc_client_secret[0].secret_id
              # Rotation is a new secret version plus a deploy; the CLI adds OIDC versions with gcloud.
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = var.oidc_issuer == "" ? [] : [1]
        content {
          name  = "OIDC_REDIRECT_URI"
          value = "${local.web_origin}/api/auth/callback"
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
        "--private-ip",
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
    google_sql_database.main,
    google_sql_user.main,
    google_storage_bucket_iam_member.web_objects,
    google_storage_bucket_iam_member.web_objects_metadata,
    google_storage_bucket_iam_member.web_state,
    google_cloud_run_v2_service.gateway,
    google_cloud_run_v2_service.runner_manager,
    google_cloud_run_v2_service_iam_member.web_invokes_runner_manager,
    google_secret_manager_secret_iam_member.web_oidc_client_secret,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "web_public" {
  # Public at the Cloud Run level on purpose: with a domain, ingress is INTERNAL_LOAD_BALANCER, so
  # the only way in from the internet is the load balancer (where IAP sits when enabled).
  name     = google_cloud_run_v2_service.web.name
  location = google_cloud_run_v2_service.web.location
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ── Single sign-on client secret ──────────────────────────────────────────────────────────────────
# Only the secret container: the CLI adds the version through gcloud, so the value never enters
# Terraform state.

resource "google_secret_manager_secret" "oidc_client_secret" {
  count     = var.oidc_issuer == "" ? 0 : 1
  secret_id = "${var.name}-oidc-client-secret"
  labels    = local.common_labels
  replication {
    auto {}
  }
  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_iam_member" "web_oidc_client_secret" {
  count     = var.oidc_issuer == "" ? 0 : 1
  secret_id = google_secret_manager_secret.oidc_client_secret[0].id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.web.member
}

# ── Identity-Aware Proxy (only with a domain and iap = true) ──────────────────────────────────────

resource "google_project_service" "iap" {
  count              = local.iap_enabled ? 1 : 0
  project            = var.project_id
  service            = local.iap_api
  disable_on_destroy = false
}
