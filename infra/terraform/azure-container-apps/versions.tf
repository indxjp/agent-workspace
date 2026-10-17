terraform {
  required_version = ">= 1.9.0"

  required_providers {
    azapi = {
      source  = "Azure/azapi"
      version = "~> 2.0"
    }
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.13"
    }
  }

  # Supply the bootstrap output fields with -backend-config. The backend authenticates with
  # Entra ID/OIDC; no storage account key is needed or accepted by the bootstrap account.
  backend "azurerm" {}
}

provider "azurerm" {
  subscription_id                 = var.subscription_id
  resource_provider_registrations = "none"

  features {
    key_vault {
      purge_soft_deleted_secrets_on_destroy = false
    }
  }
}

provider "azapi" {
  subscription_id  = var.subscription_id
  enable_preflight = true
}
