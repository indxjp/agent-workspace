resource "google_project_service" "storage" {
  project            = var.project_id
  service            = "storage.googleapis.com"
  disable_on_destroy = false
}

resource "google_storage_bucket" "state" {
  name                        = var.state_bucket_name
  project                     = var.project_id
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  versioning { enabled = true }
  retention_policy {
    retention_period = 604800
    is_locked        = false
  }
  lifecycle_rule {
    condition {
      num_newer_versions = 30
      with_state         = "ARCHIVED"
    }
    action { type = "Delete" }
  }
  depends_on = [google_project_service.storage]
}

resource "google_storage_bucket_iam_binding" "admins" {
  bucket  = google_storage_bucket.state.name
  role    = "roles/storage.objectAdmin"
  members = var.terraform_admin_members
}

output "backend_config" {
  value = "terraform init -backend-config=bucket=${google_storage_bucket.state.name} -backend-config=prefix=agent-workspace/gcp-small"
}
