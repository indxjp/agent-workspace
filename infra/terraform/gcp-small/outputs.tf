output "public_ip" {
  value       = google_compute_address.main.address
  description = "Create an A record for the configured domain with this address."
}

output "url" {
  value = "https://${var.domain}"
}

output "vm_service_account" {
  value = google_service_account.vm.email
}

output "backup_bucket" {
  value = google_storage_bucket.backups.name
}

output "artifact_repository" {
  value = google_artifact_registry_repository.images.name
}

output "secret_resource_names" {
  value = { for name, secret in google_secret_manager_secret.deployment : name => secret.id }
}
