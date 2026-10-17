variable "subscription_id" {
  description = "Azure subscription in which the preview environment will be created."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F-]{36}$", var.subscription_id))
    error_message = "subscription_id must be an Azure subscription UUID."
  }
}

variable "location" {
  description = "Azure region for bootstrap resources. Dynamic Sessions availability varies by region."
  type        = string
  default     = "japaneast"
}

variable "name" {
  description = "Lowercase deployment prefix. A random suffix is added to globally unique resources."
  type        = string
  default     = "agent-workspace"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,18}[a-z0-9]$", var.name))
    error_message = "name must be 3-20 lowercase letters, digits, or hyphens, beginning with a letter and ending with a letter or digit."
  }
}

variable "github_repository" {
  description = "Optional GitHub owner/repository allowed to exchange an Actions OIDC token for the deployment identity."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.github_repository == null || can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must use owner/repository form when set."
  }
}

variable "github_environment" {
  description = "GitHub Actions environment trusted by the optional GitHub OIDC credential."
  type        = string
  default     = "azure-preview"

  validation {
    condition     = can(regex("^[A-Za-z0-9._-]{1,100}$", var.github_environment))
    error_message = "github_environment must be a GitHub environment name of 1-100 letters, digits, dots, underscores, or hyphens; the derived federated credential name must stay within Azure's 120-character limit."
  }
}

variable "tags" {
  description = "Additional tags applied to bootstrap resources."
  type        = map(string)
  default     = {}
}
