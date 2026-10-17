variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "asia-northeast1"
}

variable "state_bucket_name" {
  description = "Globally unique bucket name. Convention: <project>-agent-workspace-tfstate."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$", var.state_bucket_name))
    error_message = "state_bucket_name must be a valid GCS bucket name."
  }
}

variable "terraform_admin_members" {
  description = "Explicit user:/group: principals permitted to read and write state."
  type        = set(string)
  validation {
    condition     = length(var.terraform_admin_members) > 0 && alltrue([for member in var.terraform_admin_members : can(regex("^(user|group):[^[:space:]]+$", member))])
    error_message = "provide at least one explicit user: or group: principal."
  }
}
