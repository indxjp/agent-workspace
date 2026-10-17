output "web_url" {
  value = google_cloud_run_v2_service.web.uri
}

output "gateway_url" {
  value = google_cloud_run_v2_service.gateway.uri
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
