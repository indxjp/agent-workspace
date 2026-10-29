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

variable "name" {
  description = "Short lowercase resource prefix. Kept distinct from any other stack sharing this project."
  type        = string
  default     = "agent-workspace"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}[a-z0-9]$", var.name))
    error_message = "name must be a short lowercase resource prefix."
  }
}

variable "bootstrap_admin_email" {
  description = "The first workspace owner's sign-in identity (spec §37 BOOTSTRAP_ADMIN)."
  type        = string
  validation {
    condition     = can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.bootstrap_admin_email))
    error_message = "bootstrap_admin_email must be a valid email address."
  }
}

variable "images" {
  description = "The four images this stack runs, pinned by immutable OCI digest. See docs/deploy/gcp-cloudrun.md for how each is built."
  type = object({
    web     = string
    gateway = string
    runner  = string
    runtime = string
  })
  validation {
    condition = alltrue([
      for reference in values(var.images) :
      can(regex("@sha256:[0-9a-f]{64}$", reference)) && !endswith(reference, "sha256:0000000000000000000000000000000000000000000000000000000000000000")
    ])
    error_message = "all images must be non-placeholder sha256 digest references; mutable tags are refused."
  }
}

variable "deployment_policy" {
  description = "The project's policy ceiling as JSON (web's AW_DEPLOYMENT_POLICY), rendered by aw deploy from agent-workspace.yaml. Empty means no ceiling."
  type        = string
  default     = ""
  validation {
    condition     = var.deployment_policy == "" || can(jsondecode(var.deployment_policy))
    error_message = "deployment_policy must be empty or JSON."
  }
}

variable "public_url" {
  description = "web's AW_PUBLIC_URL: the https origin (no path) A2A agent cards (ADR-0135) and the OAuth issuer use, rendered by aw deploy. Empty leaves it unset."
  type        = string
  default     = ""
  validation {
    condition     = var.public_url == "" || can(regex("^https://[^/?#@]+$", var.public_url))
    error_message = "public_url must be empty or an https origin with no path, query or credentials."
  }
}

variable "storage_signed_upload_max_bytes" {
  description = "web's AW_STORAGE_SIGNED_UPLOAD_MAX_BYTES: the largest signed upload in bytes. Null leaves it unset and the server default applies."
  type        = number
  default     = null
  validation {
    # A conditional, not ||: Terraform before 1.12 evaluates both sides of ||, and floor(null) fails.
    condition     = var.storage_signed_upload_max_bytes == null ? true : (var.storage_signed_upload_max_bytes >= 1 && floor(var.storage_signed_upload_max_bytes) == var.storage_signed_upload_max_bytes)
    error_message = "storage_signed_upload_max_bytes must be null or a whole number of bytes of at least 1."
  }
}

variable "db_tier" {
  description = "Cloud SQL machine tier. db-f1-micro is a shared-core tier suitable for a test/demo deployment, not sustained production load."
  type        = string
  default     = "db-f1-micro"
}

variable "web_max_instance_count" {
  type    = number
  default = 3
}

variable "runtime_timeout_seconds" {
  description = "Per-session Cloud Run runtime service request timeout ceiling (also this driver's maxSessionSeconds)."
  type        = number
  default     = 3600
}

variable "gateway_pricing_json" {
  description = "Immutable versioned provider:model price catalogue consumed by the gateway (spec §37 GATEWAY_PRICING_JSON)."
  type        = string
  default     = <<-JSON
    {"version":"2026-09-10","models":{
      "anthropic:claude-sonnet-5":{"inputUsdPerMillion":"2.00","outputUsdPerMillion":"10.00","cacheReadUsdPerMillion":"0.20","cacheCreationUsdPerMillion":"2.50"},
      "anthropic:claude-opus-5":{"inputUsdPerMillion":"5.00","outputUsdPerMillion":"25.00","cacheReadUsdPerMillion":"0.50","cacheCreationUsdPerMillion":"6.25"}
    }}
  JSON
  validation {
    condition = (
      can(jsondecode(var.gateway_pricing_json)) &&
      can(jsondecode(var.gateway_pricing_json).version) &&
      can(jsondecode(var.gateway_pricing_json).models)
    )
    error_message = "gateway_pricing_json must be JSON with version and models fields."
  }
}
