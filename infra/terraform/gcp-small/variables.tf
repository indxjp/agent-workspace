variable "project_id" {
  description = "Existing GCP project in which the stack is created."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a valid GCP project id."
  }
}

variable "region" {
  type    = string
  default = "asia-northeast1"
}

variable "zone" {
  type    = string
  default = "asia-northeast1-b"
  validation {
    condition     = startswith(var.zone, "${var.region}-")
    error_message = "zone must belong to region."
  }
}

variable "name" {
  type    = string
  default = "agent-workspace"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}[a-z0-9]$", var.name))
    error_message = "name must be a short lowercase resource prefix."
  }
}

variable "domain" {
  description = "Production DNS name pointed at the reserved address. Localhost and raw IPs are refused."
  type        = string
  validation {
    condition     = length(var.domain) >= 4 && length(var.domain) <= 253 && can(regex("^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", var.domain)) && !endswith(var.domain, ".localhost")
    error_message = "domain must be a public lower-case DNS name."
  }
}

variable "tls_email" {
  description = "ACME account email used by Caddy."
  type        = string
  validation {
    condition     = can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.tls_email))
    error_message = "tls_email must be a valid email address."
  }
}

variable "bootstrap_admin_email" {
  type = string
  validation {
    condition     = can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.bootstrap_admin_email))
    error_message = "bootstrap_admin_email must be a valid email address."
  }
}

variable "machine_type" {
  type    = string
  default = "e2-standard-2"
}

variable "data_disk_size_gb" {
  type    = number
  default = 50
  validation {
    condition     = var.data_disk_size_gb >= 50
    error_message = "data_disk_size_gb must be at least 50."
  }
}

variable "data_disk_type" {
  type    = string
  default = "pd-balanced"
  validation {
    condition     = contains(["pd-balanced", "pd-ssd"], var.data_disk_type)
    error_message = "data_disk_type must be pd-balanced or pd-ssd."
  }
}

variable "subnet_cidr" {
  type    = string
  default = "10.42.0.0/24"
}

variable "operator_members" {
  description = "Explicit user:/group: principals allowed to use IAP TCP forwarding."
  type        = set(string)
  default     = []
  validation {
    condition     = alltrue([for member in var.operator_members : can(regex("^(user|group):[^@[:space:]]+@[^@[:space:]]+$", member))])
    error_message = "operator_members must contain explicit user: or group: principals."
  }
}

variable "enable_iap_ssh" {
  type    = bool
  default = false
}

variable "deletion_protection" {
  description = "Disable deliberately before a planned terraform destroy."
  type        = bool
  default     = true
}

variable "backup_retention_days" {
  type    = number
  default = 35
  validation {
    condition     = var.backup_retention_days >= 7 && var.backup_retention_days <= 3650
    error_message = "backup_retention_days must be between 7 and 3650."
  }
}

variable "snapshot_retention_days" {
  type    = number
  default = 14
  validation {
    condition     = var.snapshot_retention_days >= 7 && var.snapshot_retention_days <= 365
    error_message = "snapshot_retention_days must be between 7 and 365."
  }
}

variable "docker_ce_version" {
  description = "Exact Docker CE/CLI apt version installed by bootstrap."
  type        = string
  default     = "5:28.4.0-1~debian.12~bookworm"
  validation {
    condition     = can(regex("^[0-9]+:[0-9]+\\.[0-9]+\\.[0-9]+[-+~.A-Za-z0-9]+$", var.docker_ce_version))
    error_message = "docker_ce_version must be an exact Debian package version."
  }
}

variable "docker_compose_version" {
  description = "Exact docker-compose-plugin apt version installed by bootstrap."
  type        = string
  default     = "2.39.4-1~debian.12~bookworm"
}

variable "images" {
  description = "Every shipped process and third-party service, pinned by immutable OCI digest."
  type = object({
    web      = string
    gateway  = string
    runner   = string
    runtime  = string
    postgres = string
    proxy    = string
  })
  validation {
    condition = alltrue([
      for reference in values(var.images) :
      can(regex("@sha256:[0-9a-f]{64}$", reference)) && !endswith(reference, "sha256:${strrep("0", 64)}")
    ])
    error_message = "all images must be non-placeholder sha256 digest references; mutable tags are refused."
  }
}

variable "secret_versions" {
  description = "Numbered Secret Manager versions. Terraform creates containers, never values."
  type = object({
    postgres_password        = string
    session_secret           = string
    master_encryption_key    = string
    gateway_token_secret     = string
    runner_manager_token     = string
    bootstrap_admin_password = string
  })
  validation {
    condition     = alltrue([for version in values(var.secret_versions) : can(regex("^[1-9][0-9]*$", version))])
    error_message = "secret_versions must contain numbered versions; latest is deliberately refused."
  }
}

variable "gateway_pricing_json" {
  description = "Immutable versioned provider:model price catalogue consumed by the gateway."
  type        = string
  validation {
    condition = (
      can(jsondecode(var.gateway_pricing_json)) &&
      can(jsondecode(var.gateway_pricing_json).version) &&
      can(jsondecode(var.gateway_pricing_json).models)
    )
    error_message = "gateway_pricing_json must be JSON with version and models fields."
  }
}
