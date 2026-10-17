variable "subscription_id" {
  description = "Azure subscription containing the bootstrap resource group."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F-]{36}$", var.subscription_id))
    error_message = "subscription_id must be an Azure subscription UUID."
  }
}

variable "resource_group_name" {
  description = "Resource group created by bootstrap."
  type        = string
}

variable "container_registry_name" {
  description = "Azure Container Registry created by bootstrap."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9]{5,50}$", var.container_registry_name))
    error_message = "container_registry_name must be a valid ACR name."
  }
}

variable "container_registry_resource_group_name" {
  description = "Protected bootstrap resource group containing Azure Container Registry."
  type        = string
}

variable "name" {
  description = "Lowercase deployment prefix."
  type        = string
  default     = "agent-workspace"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,18}[a-z0-9]$", var.name))
    error_message = "name must be 3-20 lowercase letters, digits, or hyphens, beginning with a letter and ending with a letter or digit."
  }
}

variable "bootstrap_admin_email" {
  description = "Initial workspace owner's sign-in identity."
  type        = string

  validation {
    condition     = can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.bootstrap_admin_email))
    error_message = "bootstrap_admin_email must be a valid email address."
  }
}

variable "object_container_name" {
  description = "Azure Blob container used by the native ObjectStore backend."
  type        = string

  validation {
    condition = (
      can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.object_container_name)) &&
      !strcontains(var.object_container_name, "--")
    )
    error_message = "object_container_name must be 3-63 lowercase letters, digits or hyphens without consecutive hyphens."
  }
}

variable "public_url" {
  description = "web's AW_PUBLIC_URL: the https origin (no path) A2A agent cards (ADR-0135) and the OAuth issuer use, rendered by agent-workspace render. Empty leaves it unset."
  type        = string
  default     = ""
  validation {
    condition     = var.public_url == "" || can(regex("^https://[^/?#@]+$", var.public_url))
    error_message = "public_url must be empty or an https origin with no path, query or credentials."
  }
}

variable "images" {
  description = "Web, gateway, runner-manager, and sandbox images pinned by immutable OCI digest."
  type = object({
    web     = string
    gateway = string
    runner  = string
    runtime = string
  })

  validation {
    condition = alltrue([
      for reference in values(var.images) :
      can(regex("@sha256:[0-9a-f]{64}$", reference)) &&
      !endswith(reference, "sha256:0000000000000000000000000000000000000000000000000000000000000000")
    ])
    error_message = "all images must be non-placeholder sha256 digest references; mutable tags are refused."
  }
}

variable "database_sku_name" {
  description = "PostgreSQL Flexible Server SKU. B_Standard_B1ms is intended for preview use, not sustained production load."
  type        = string
  default     = "B_Standard_B1ms"
}

variable "database_storage_mb" {
  description = "PostgreSQL storage in MiB."
  type        = number
  default     = 32768

  validation {
    condition     = var.database_storage_mb >= 32768
    error_message = "database_storage_mb must be at least 32768."
  }
}

variable "web_max_replicas" {
  description = "Maximum web replicas. Keep one while migrations run in the web entrypoint."
  type        = number
  default     = 1

  validation {
    condition     = var.web_max_replicas == 1
    error_message = "web_max_replicas must remain 1 until migrations are moved out of the web entrypoint."
  }
}

variable "enable_dynamic_sessions" {
  description = "Create the separately isolated ACA Dynamic Sessions sandbox pool. Disable only in regions/subscriptions where the feature is unavailable."
  type        = bool
  default     = true
}

variable "session_pool_generation" {
  description = "Optional lowercase generation token appended to the Dynamic Sessions pool name. Bump it to replace a stuck immutable runtime rollout without renaming other resources."
  type        = string
  default     = ""

  validation {
    condition     = var.session_pool_generation == "" || can(regex("^[a-z0-9]{1,8}$", var.session_pool_generation))
    error_message = "session_pool_generation must be empty or 1-8 lowercase letters and digits."
  }
}

variable "session_pool_network_status" {
  description = "Dynamic Sessions exposes only an all-or-nothing egress switch. EgressEnabled is the honest default because the runtime must reach the gateway and model provider."
  type        = string
  default     = "EgressEnabled"

  validation {
    condition     = contains(["EgressEnabled", "EgressDisabled"], var.session_pool_network_status)
    error_message = "session_pool_network_status must be EgressEnabled or EgressDisabled."
  }
}

variable "session_pool_ready_instances" {
  description = "Warm sandbox instances. Azure custom-container Dynamic Sessions currently requires at least one and fewer than max_concurrent_sessions."
  type        = number
  default     = 1

  validation {
    condition     = var.session_pool_ready_instances >= 1 && var.session_pool_ready_instances < var.session_pool_max_concurrent_sessions
    error_message = "session_pool_ready_instances must be at least one and less than session_pool_max_concurrent_sessions, as required by Azure."
  }
}

variable "session_pool_max_concurrent_sessions" {
  type    = number
  default = 4

  validation {
    condition     = var.session_pool_max_concurrent_sessions >= 1 && var.session_pool_max_concurrent_sessions <= 20
    error_message = "session_pool_max_concurrent_sessions must be between 1 and 20."
  }
}

variable "session_pool_cooldown_seconds" {
  description = "Idle period before a timed sandbox session is ended."
  type        = number
  default     = 600

  validation {
    condition     = var.session_pool_cooldown_seconds >= 300 && var.session_pool_cooldown_seconds <= 3600
    error_message = "session_pool_cooldown_seconds must be between 300 and 3600."
  }
}

variable "gateway_pricing_json" {
  description = "Immutable versioned provider:model price catalogue consumed by the gateway."
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

variable "tags" {
  description = "Additional tags applied to stack resources."
  type        = map(string)
  default     = {}
}
