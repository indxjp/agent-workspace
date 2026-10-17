output "resource_group_name" {
  description = "Workload resource group consumed by the main stack."
  value       = azurerm_resource_group.workload.name
}

output "bootstrap_resource_group_name" {
  description = "Protected resource group containing state, ACR, and the deployment identity."
  value       = azurerm_resource_group.security.name
}

output "container_registry_resource_group_name" {
  description = "Protected ACR resource group to pass to the main stack."
  value       = azurerm_resource_group.security.name
}

output "container_registry_name" {
  description = "ACR name to pass to the main stack and image publishing jobs."
  value       = azurerm_container_registry.images.name
}

output "container_registry_login_server" {
  value = azurerm_container_registry.images.login_server
}

output "deployer_client_id" {
  description = "AZURE_CLIENT_ID for GitHub Actions OIDC login."
  value       = azurerm_user_assigned_identity.deployer.client_id
}

output "deployer_principal_id" {
  value = azurerm_user_assigned_identity.deployer.principal_id
}

output "backend_config" {
  description = "Values for terraform init -backend-config in the main stack. Authentication uses Entra ID/OIDC, not a storage key."
  value = {
    resource_group_name  = azurerm_resource_group.security.name
    storage_account_name = azurerm_storage_account.state.name
    container_name       = azurerm_storage_container.state.name
    key                  = "azure-container-apps.tfstate"
    use_azuread_auth     = true
  }
}

output "github_actions_login" {
  description = "Non-secret values used by azure/login when GitHub OIDC is enabled."
  value = var.github_repository == null ? null : {
    client_id       = azurerm_user_assigned_identity.deployer.client_id
    tenant_id       = azurerm_user_assigned_identity.deployer.tenant_id
    subscription_id = var.subscription_id
  }
}
