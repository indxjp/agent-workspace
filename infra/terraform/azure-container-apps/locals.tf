data "azurerm_client_config" "current" {}

data "azurerm_resource_group" "deployment" {
  name = var.resource_group_name
}

data "azurerm_container_registry" "images" {
  name                = var.container_registry_name
  resource_group_name = var.container_registry_resource_group_name
}

locals {
  location     = data.azurerm_resource_group.deployment.location
  compact_name = substr(replace(var.name, "-", ""), 0, 14)
  unique_name  = "${local.compact_name}${random_string.suffix.result}"
  common_tags = merge({
    application = "agent-workspace"
    environment = "preview"
    managed-by  = "terraform"
  }, var.tags)

  state_mount_path               = "/var/lib/agent-workspace"
  runtime_driver                 = var.enable_dynamic_sessions ? "aca-sessions" : "docker"
  web_app_name                   = "ca-${var.name}-web"
  web_base_url                   = "https://${local.web_app_name}.${azurerm_container_app_environment.main.default_domain}"
  runner_app_name                = "ca-${var.name}-runner"
  runner_manager_url             = "http://${local.runner_app_name}:8090"
  verification_network_policy    = var.session_pool_network_status == "EgressEnabled" ? "open" : "none"
  session_pool_generation_suffix = var.session_pool_generation == "" ? "" : "g${var.session_pool_generation}"
  session_pool_name = "${substr(
    "${local.compact_name}${random_string.suffix.result}sessions",
    0,
    32 - length(local.session_pool_generation_suffix)
  )}${local.session_pool_generation_suffix}"
  session_pool_endpoint = var.enable_dynamic_sessions ? try(
    azapi_resource.session_pool[0].output.properties.poolManagementEndpoint,
    ""
  ) : ""
}

resource "random_string" "suffix" {
  length  = 6
  upper   = false
  special = false
}
