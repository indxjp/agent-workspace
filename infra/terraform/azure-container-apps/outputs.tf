output "web_url" {
  description = "Public HTTPS entry point for the preview environment."
  value       = "https://${azurerm_container_app.web.ingress[0].fqdn}"
}

output "gateway_fqdn" {
  description = "Gateway FQDN; external HTTPS ingress is enabled when Dynamic Sessions need to reach it."
  value       = azurerm_container_app.gateway.ingress[0].fqdn
}

output "runner_manager_fqdn" {
  description = "Environment-internal runner-manager FQDN."
  value       = azurerm_container_app.runner.ingress[0].fqdn
}

output "runner_manager_url" {
  description = "Environment-internal raw-TCP HTTP URL used by web; it bypasses ACA's 240-second HTTP ingress timeout."
  value       = local.runner_manager_url
}

output "container_apps_environment_id" {
  value = azurerm_container_app_environment.main.id
}

output "container_registry_name" {
  value = data.azurerm_container_registry.images.name
}

output "container_registry_login_server" {
  value = data.azurerm_container_registry.images.login_server
}

output "postgres_server_fqdn" {
  description = "Private PostgreSQL FQDN, resolvable from the deployment VNet."
  value       = azurerm_postgresql_flexible_server.main.fqdn
}

output "workspace_storage_account_name" {
  value = azurerm_storage_account.workspace.name
}

output "workspace_file_share_name" {
  value = azurerm_storage_share.workspace.name
}

output "workspace_blob_container_name" {
  value = azurerm_storage_container.workspace_objects.name
}

output "key_vault_name" {
  value = azurerm_key_vault.main.name
}

output "log_analytics_workspace_id" {
  value = azurerm_log_analytics_workspace.main.id
}

output "session_pool_id" {
  description = "Dynamic Sessions pool resource ID, or null when the pool is disabled."
  value       = var.enable_dynamic_sessions ? azapi_resource.session_pool[0].id : null
}

output "session_pool_name" {
  description = "Generation-qualified Dynamic Sessions pool name, or null when the pool is disabled."
  value       = var.enable_dynamic_sessions ? local.session_pool_name : null
}

output "session_pool_generation" {
  description = "Configured blue/green generation token; empty means the original unsuffixed name."
  value       = var.enable_dynamic_sessions ? var.session_pool_generation : null
}

output "session_pool_management_endpoint" {
  description = "Data-plane session-management endpoint, or null when the pool is disabled."
  value       = var.enable_dynamic_sessions ? local.session_pool_endpoint : null
}

output "session_pool_node_count" {
  description = "Provider-reported backing node count. Custom-container Dynamic Sessions retain at least one ready session."
  value       = var.enable_dynamic_sessions ? try(azapi_resource.session_pool[0].output.properties.nodeCount, 0) : null
}

output "session_pool_ready_instances" {
  value = var.enable_dynamic_sessions ? var.session_pool_ready_instances : null
}

output "runtime_driver" {
  value = local.runtime_driver
}
