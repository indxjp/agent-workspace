resource "azurerm_storage_account" "workspace" {
  name                            = substr("st${local.unique_name}", 0, 24)
  resource_group_name             = data.azurerm_resource_group.deployment.name
  location                        = local.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  account_kind                    = "StorageV2"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  public_network_access_enabled   = true
  shared_access_key_enabled       = true
  tags                            = local.common_tags

  share_properties {
    retention_policy {
      days = 7
    }
  }
}

resource "azurerm_storage_share" "workspace" {
  name               = "workspace-state"
  storage_account_id = azurerm_storage_account.workspace.id
  quota              = 100
  access_tier        = "TransactionOptimized"
}

resource "azurerm_storage_container" "workspace_objects" {
  name                  = var.object_container_name
  storage_account_id    = azurerm_storage_account.workspace.id
  container_access_type = "private"
}

resource "azurerm_role_assignment" "web_blob_contributor" {
  scope                = azurerm_storage_container.workspace_objects.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.web.principal_id
  principal_type       = "ServicePrincipal"
}

# ACA environment storage currently requires a storage key even though the application identities
# themselves never receive that key. The share is mounted only into the web container.
resource "azurerm_container_app_environment_storage" "workspace" {
  name                         = "workspace-state"
  container_app_environment_id = azurerm_container_app_environment.main.id
  account_name                 = azurerm_storage_account.workspace.name
  share_name                   = azurerm_storage_share.workspace.name
  access_key                   = azurerm_storage_account.workspace.primary_access_key
  access_mode                  = "ReadWrite"
}

resource "random_password" "database" {
  length  = 32
  special = false
}

resource "azurerm_postgresql_flexible_server" "main" {
  name                          = "psql-${local.unique_name}"
  resource_group_name           = data.azurerm_resource_group.deployment.name
  location                      = local.location
  version                       = "16"
  delegated_subnet_id           = azurerm_subnet.postgres.id
  private_dns_zone_id           = azurerm_private_dns_zone.postgres.id
  public_network_access_enabled = false
  administrator_login           = "agentworkspace"
  administrator_password        = random_password.database.result
  sku_name                      = var.database_sku_name
  storage_mb                    = var.database_storage_mb
  backup_retention_days         = 7
  geo_redundant_backup_enabled  = false
  tags                          = local.common_tags

  authentication {
    active_directory_auth_enabled = false
    password_auth_enabled         = true
  }

  lifecycle {
    # Azure chooses a zone when none is requested. AzureRM otherwise plans to
    # remove that computed zone on the next apply, which the service rejects.
    ignore_changes = [zone]
  }

  depends_on = [azurerm_private_dns_zone_virtual_network_link.postgres]
}

resource "azurerm_postgresql_flexible_server_database" "main" {
  name      = "agent_workspace"
  server_id = azurerm_postgresql_flexible_server.main.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}
