output "web_url" {
  value = var.domain == "" ? google_cloud_run_v2_service.web.uri : "https://${var.domain}"
}

# The address to point the domain's A record at; empty without a domain.
output "load_balancer_ip" {
  value = var.domain == "" ? "" : google_compute_global_address.lb[0].address
}

output "gateway_url" {
  value = google_cloud_run_v2_service.gateway.uri
}

# The address sandboxes (and web) reach the gateway at: its internal load balancer.
output "gateway_internal_url" {
  value = local.gateway_internal_url
}

output "runner_manager_url" {
  value = google_cloud_run_v2_service.runner_manager.uri
}

output "artifact_repository" {
  value = google_artifact_registry_repository.images.name
}

# The registry host and path `aw deploy` copies the release images into, by digest.
output "image_registry" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}

output "objects_bucket" {
  value = google_storage_bucket.objects.name
}

output "state_bucket" {
  value = google_storage_bucket.state.name
}

output "cloud_sql_connection_name" {
  value = google_sql_database_instance.main.connection_name
}

output "runtime_service_account" {
  value = google_service_account.runtime.email
}

output "bootstrap_admin_password" {
  value     = random_password.bootstrap_admin_password.result
  sensitive = true
}

output "runner_manager_token" {
  value     = random_password.runner_manager_token.result
  sensitive = true
}

output "network" {
  description = "The VPC network the services and Cloud SQL use (created or adopted)."
  value       = local.network_id
}

output "oidc_client_secret_id" {
  description = "The Secret Manager secret that holds the single sign-on client secret, or empty when single sign-on is off."
  value       = var.oidc_issuer == "" ? "" : google_secret_manager_secret.oidc_client_secret[0].secret_id
}

# The Cloud Monitoring dashboard id (always created).
output "dashboard_id" {
  value = google_monitoring_dashboard.main.id
}

# Whether alert policies, the notification channel and the uptime check exist.
output "alerts_enabled" {
  value = var.alerts_email != ""
}
