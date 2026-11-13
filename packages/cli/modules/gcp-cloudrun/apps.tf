# Apps and tool sandboxes, only on request: every resource here is gated on var.apps, so the default
# stack is unchanged. The counterpart of domain.tf and sandbox-internet.tf: one self-contained file
# for one optional capability.
#
# Per app (aw deploy renders var.apps from the project's apps list): a database role created by a
# one-shot Cloud Run job, two secrets of its own, a service account that holds almost nothing, and
# an always-on Cloud Run service next to web. The app image and its role SQL come from the CLI.

locals {
  apps_enabled = length(var.apps) > 0

  # PostgreSQL role of each app, as in compose-apps.ts (app_<snake_case_name>).
  app_pg_user = { for key, _ in var.apps : key => "app_${replace(key, "-", "_")}" }

  # Cloud Run names a job's execution <job name>-<run_execution_token> and refuses one of 64
  # characters or more, so the role job's name is the stack name, -r- and 5 hex of the app name's
  # sha256: at most 22 + 3 + 5 = 30 characters, and 30 + 1 + 32 = 63 for any valid name variable,
  # however long the app name. Its aw-app label names the app.
  app_role_job_token_length = 32
  app_role_job_name         = { for key, _ in var.apps : key => "${var.name}-r-${substr(sha256(key), 0, 5)}" }

  # The host each app's url names; with a domain the load balancer routes it to the app.
  app_hosts = { for key, app in var.apps : key => regex("^https://([^/:?#]+)", app.url)[0] }

  # The PostgreSQL client the role job runs: compose.yaml's pinned image, from Docker Hub (Cloud Run
  # pulls public images from there).
  role_job_image = "docker.io/library/postgres:18-alpine@sha256:898c60cb390d1085bc97bdd6a1ae968757421df394b071848b52b1c09c89d6a5"

  # Secret Manager secrets per app, named ${var.name}-<key>. The password secret is read by the role
  # job only; the app reads the database url (which holds the same password) and its identity secret.
  app_secret_values = merge(
    { for key, _ in var.apps : "app-${key}-db-password" => random_password.app[key].result },
    { for key, _ in var.apps : "app-${key}-identity-secret" => random_id.app_identity[key].hex },
    { for key, _ in var.apps : "app-${key}-database-url" => "postgres://${local.app_pg_user[key]}:${random_password.app[key].result}@127.0.0.1:5432/agent_workspace" },
  )

  app_secret_readers = merge(
    { for key, _ in var.apps : "${key}/database-url" => { app = key, secret = "app-${key}-database-url" } },
    { for key, _ in var.apps : "${key}/identity-secret" => { app = key, secret = "app-${key}-identity-secret" } },
  )
}

# Cross-variable checks: variable validation cannot read another variable before Terraform 1.9.
resource "terraform_data" "apps_checks" {
  lifecycle {
    precondition {
      condition     = alltrue([for key, _ in var.apps : length("${var.name}-app-${key}") <= 49])
      error_message = "A Cloud Run service name is at most 49 characters: ${var.name}-app-<name> is too long for an app. Use a shorter app name or a shorter name variable."
    }
    precondition {
      condition     = alltrue([for _, job in local.app_role_job_name : length(job) + 1 + local.app_role_job_token_length < 64])
      error_message = "A Cloud Run job execution name (<job name>-<run_execution_token>) must be under 64 characters: an app role job name is too long."
    }
    precondition {
      condition     = length(distinct(values(local.app_role_job_name))) == length(var.apps)
      error_message = "Two apps hash to the same role job name (${var.name}-r-<5 hex>). Rename one of them."
    }
    precondition {
      condition     = !local.has_domain || alltrue([for _, host in local.app_hosts : host != var.domain])
      error_message = "An app's url host must differ from domain: the domain is web's, and the load balancer routes each app by its own host."
    }
  }
}

# ── Identities ────────────────────────────────────────────────────────────────────────────────────

# account_id is limited to 30 characters, so it is a hash of the stack and app names.
resource "google_service_account" "app" {
  for_each     = var.apps
  account_id   = "app-${substr(sha256("${var.name}/${each.key}"), 0, 12)}"
  display_name = "Agent Workspace app ${each.key}"
  depends_on   = [google_project_service.required]
}

# Reads only the secrets the role job needs. It connects to Cloud SQL as the database owner, which no
# app may do, so it is a separate identity from every app.
resource "google_service_account" "app_roles" {
  count        = local.apps_enabled ? 1 : 0
  account_id   = "${var.name}-app-roles"
  display_name = "Agent Workspace app database roles (one-shot job)"
  depends_on   = [google_project_service.required]
}

# The only project role an app holds. Cloud SQL supports IAM conditions on resource.name
# (https://docs.cloud.google.com/iam/docs/conditions-resource-attributes), so it is limited to this
# stack's instance: an app cannot connect to any other instance in the project.
resource "google_project_iam_member" "app_cloudsql_client" {
  for_each = var.apps
  project  = var.project_id
  role     = "roles/cloudsql.client"
  member   = google_service_account.app[each.key].member
  condition {
    title      = "this-stack-instance-only"
    expression = "resource.type == \"sqladmin.googleapis.com/Instance\" && resource.name == \"projects/${var.project_id}/instances/${var.name}-pg\""
  }
}

# ── Secrets ───────────────────────────────────────────────────────────────────────────────────────

resource "random_password" "app" {
  for_each = var.apps
  length   = 32
  special  = false
}

resource "random_id" "app_identity" {
  for_each    = var.apps
  byte_length = 32
}

resource "google_secret_manager_secret" "app" {
  for_each  = local.app_secret_values
  secret_id = "${var.name}-${each.key}"
  replication {
    auto {}
  }
  labels     = local.common_labels
  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_version" "app" {
  for_each    = local.app_secret_values
  secret      = google_secret_manager_secret.app[each.key].id
  secret_data = each.value
}

resource "google_secret_manager_secret_iam_member" "app_access" {
  for_each  = local.app_secret_readers
  project   = var.project_id
  secret_id = google_secret_manager_secret.app[each.value.secret].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.app[each.value.app].member
}

# The database owner's password, for the role job only. A new secret (the existing database-url
# secret is read by web and the gateway and holds a url, not a password).
resource "google_secret_manager_secret" "db_password" {
  count     = local.apps_enabled ? 1 : 0
  secret_id = "${var.name}-db-password"
  replication {
    auto {}
  }
  labels     = local.common_labels
  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_version" "db_password" {
  count       = local.apps_enabled ? 1 : 0
  secret      = google_secret_manager_secret.db_password[0].id
  secret_data = random_password.db.result
}

resource "google_secret_manager_secret_iam_member" "app_roles_db_password" {
  count     = local.apps_enabled ? 1 : 0
  project   = var.project_id
  secret_id = google_secret_manager_secret.db_password[0].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.app_roles[0].member
}

resource "google_secret_manager_secret_iam_member" "app_roles_app_password" {
  for_each  = var.apps
  project   = var.project_id
  secret_id = google_secret_manager_secret.app["app-${each.key}-db-password"].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.app_roles[0].member
}

# ── The role job ──────────────────────────────────────────────────────────────────────────────────
# Creates or updates the app's database role and grants (role_sql, from the CLI) before the app
# starts. run_execution_token makes terraform apply run it to completion whenever the SQL or the
# password changes (and on create); a failed run fails the apply, and the app service waits for it.
# google-beta: the google provider (6.50.0) has no run_execution_token.

resource "google_cloud_run_v2_job" "app_role" {
  provider            = google-beta
  for_each            = var.apps
  name                = local.app_role_job_name[each.key]
  location            = var.region
  project             = var.project_id
  deletion_protection = var.data_protection
  labels              = merge(local.common_labels, { aw-app = each.key })

  run_execution_token = substr(sha256(join("/", [each.value.role_sql, google_secret_manager_secret_version.app["app-${each.key}-db-password"].id])), 0, local.app_role_job_token_length)

  template {
    template {
      service_account = google_service_account.app_roles[0].email
      max_retries     = 1
      timeout         = "300s"
      vpc_access {
        network_interfaces {
          network    = local.network_id
          subnetwork = local.services_subnet_id
        }
        egress = "PRIVATE_RANGES_ONLY"
      }
      containers {
        image = local.role_job_image
        # The same command as compose-apps.ts. In HCL a lone $ is literal ($${ is the escape).
        command = [
          "sh",
          "-c",
          "printf '%s\\n' \"$APP_SQL\" | psql -X -q -v ON_ERROR_STOP=1 -v APP_PASSWORD=\"$APP_PASSWORD\"",
        ]
        env {
          name  = "PGHOST"
          value = google_sql_database_instance.main.private_ip_address
        }
        env {
          name  = "PGSSLMODE"
          value = "require"
        }
        env {
          name  = "PGUSER"
          value = google_sql_user.main.name
        }
        env {
          name  = "PGDATABASE"
          value = google_sql_database.main.name
        }
        env {
          name = "PGPASSWORD"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.db_password[0].secret_id
              version = google_secret_manager_secret_version.db_password[0].version
            }
          }
        }
        env {
          name = "APP_PASSWORD"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app["app-${each.key}-db-password"].secret_id
              version = google_secret_manager_secret_version.app["app-${each.key}-db-password"].version
            }
          }
        }
        env {
          name  = "APP_SQL"
          value = each.value.role_sql
        }
        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }
      }
    }
  }
  depends_on = [
    google_secret_manager_secret_iam_member.app_roles_db_password,
    google_secret_manager_secret_iam_member.app_roles_app_password,
    google_sql_database.main,
    google_sql_user.main,
  ]
}

# ── The app services ──────────────────────────────────────────────────────────────────────────────
# Each depends on its role job and never on web, so the app chain runs beside web once Cloud SQL is
# up and adds nothing to the first deploy's critical path.
#
# Always on (min 1, CPU always allocated): the CLI cannot see schedule() inside an image, so every
# app is treated as one that may run background work. One instance at most, so migrations
# (AW_APP_MIGRATE_ON_START) and schedules never run twice.

resource "google_cloud_run_v2_service" "app" {
  for_each            = var.apps
  name                = "${var.name}-app-${each.key}"
  location            = var.region
  project             = var.project_id
  ingress             = local.has_domain ? "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER" : "INGRESS_TRAFFIC_INTERNAL_ONLY"
  deletion_protection = var.data_protection

  # Service-level scaling, as web's (see the gateway service); the minimum matches the template's.
  scaling {
    min_instance_count    = 1
    manual_instance_count = 0
  }

  template {
    service_account = google_service_account.app[each.key].email
    vpc_access {
      network_interfaces {
        network    = local.network_id
        subnetwork = local.services_subnet_id
      }
      egress = "PRIVATE_RANGES_ONLY"
    }
    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }
    containers {
      name  = "app"
      image = each.value.image
      ports {
        container_port = 3000
      }
      resources {
        cpu_idle          = false
        startup_cpu_boost = true
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
      }
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["app-${each.key}-database-url"].secret_id
            version = google_secret_manager_secret_version.app["app-${each.key}-database-url"].version
          }
        }
      }
      env {
        name  = "AW_URL"
        value = local.web_origin
      }
      env {
        name  = "AW_APP_NAME"
        value = each.key
      }
      env {
        name  = "AW_APP_MIGRATE_ON_START"
        value = "1"
      }
      env {
        name = "AW_APP_IDENTITY_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["app-${each.key}-identity-secret"].secret_id
            version = google_secret_manager_secret_version.app["app-${each.key}-identity-secret"].version
          }
        }
      }
      env {
        name  = "HOSTNAME"
        value = "0.0.0.0"
      }
      # Migrations run before the server listens (D-9), so allow up to ten minutes.
      startup_probe {
        http_get {
          path = "/api/health"
          port = 3000
        }
        initial_delay_seconds = 0
        period_seconds        = 10
        timeout_seconds       = 5
        failure_threshold     = 60
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
    google_cloud_run_v2_job.app_role,
    google_secret_manager_secret_iam_member.app_access,
    google_project_iam_member.app_cloudsql_client,
    terraform_data.apps_checks,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "app_public" {
  # Public at the Cloud Run IAM level on purpose. Ingress is the gate: internal only, or internal
  # plus the load balancer when there is a domain. Neither the load balancer (without IAP) nor an
  # MCP or HTTP client can attach a Google ID token, so IAM could not admit them. The app
  # authenticates every request itself. Sandboxes cannot reach it: the aw-sandbox firewall allows
  # only the gateway's internal load balancer.
  for_each = var.apps
  name     = google_cloud_run_v2_service.app[each.key].name
  location = google_cloud_run_v2_service.app[each.key].location
  project  = var.project_id
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ── Domain routing (only with a domain) ───────────────────────────────────────────────────────────
# Each app has its own host (its url), its own backend and its own certificate. The certificates are
# separate resources so web's is never replaced when an app is added; web stays the url map default.

resource "google_compute_region_network_endpoint_group" "app" {
  for_each              = local.has_domain ? var.apps : {}
  name                  = "${var.name}-app-${each.key}-neg"
  project               = var.project_id
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = google_cloud_run_v2_service.app[each.key].name
  }
}

resource "google_compute_backend_service" "app" {
  for_each              = local.has_domain ? var.apps : {}
  name                  = "${var.name}-app-${each.key}"
  project               = var.project_id
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  security_policy       = var.armor ? google_compute_security_policy.armor[0].id : null

  backend {
    group = google_compute_region_network_endpoint_group.app[each.key].id
  }
}

resource "google_compute_managed_ssl_certificate" "app" {
  for_each = local.has_domain ? var.apps : {}
  name     = "${var.name}-app-${each.key}"
  project  = var.project_id
  managed {
    domains = [local.app_hosts[each.key]]
  }
}
