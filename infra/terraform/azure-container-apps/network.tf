resource "azurerm_virtual_network" "main" {
  name                = "vnet-${var.name}"
  resource_group_name = data.azurerm_resource_group.deployment.name
  location            = local.location
  address_space       = ["10.42.0.0/20"]
  tags                = local.common_tags
}

resource "azurerm_subnet" "container_apps" {
  name                 = "snet-container-apps"
  resource_group_name  = data.azurerm_resource_group.deployment.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.42.0.0/23"]

  delegation {
    name = "container-apps"

    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "postgres" {
  name                 = "snet-postgres"
  resource_group_name  = data.azurerm_resource_group.deployment.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.42.2.0/24"]
  # Flexible Server adds this endpoint to its delegated subnet. Declaring it
  # prevents a perpetual post-create diff on the next Terraform run.
  service_endpoints = ["Microsoft.Storage"]

  delegation {
    name = "postgres-flexible-server"

    service_delegation {
      name    = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_private_dns_zone" "postgres" {
  name                = "${local.unique_name}.postgres.database.azure.com"
  resource_group_name = data.azurerm_resource_group.deployment.name
  tags                = local.common_tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "postgres" {
  name                  = "postgres-vnet-link"
  resource_group_name   = data.azurerm_resource_group.deployment.name
  private_dns_zone_name = azurerm_private_dns_zone.postgres.name
  virtual_network_id    = azurerm_virtual_network.main.id
  registration_enabled  = false
  tags                  = local.common_tags
}

resource "azurerm_log_analytics_workspace" "main" {
  name                = "log-${var.name}"
  resource_group_name = data.azurerm_resource_group.deployment.name
  location            = local.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = local.common_tags
}

resource "azurerm_container_app_environment" "main" {
  name                           = "cae-${var.name}"
  resource_group_name            = data.azurerm_resource_group.deployment.name
  location                       = local.location
  log_analytics_workspace_id     = azurerm_log_analytics_workspace.main.id
  infrastructure_subnet_id       = azurerm_subnet.container_apps.id
  internal_load_balancer_enabled = false
  zone_redundancy_enabled        = false
  tags                           = local.common_tags

  # Azure materializes the Consumption profile even when it is omitted from
  # the create request. Model it explicitly so subsequent plans are stable.
  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
    minimum_count         = 0
    maximum_count         = 0
  }
}
