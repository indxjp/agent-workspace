resource "azurerm_monitor_diagnostic_setting" "container_apps_environment" {
  name                       = "send-to-log-analytics"
  target_resource_id         = azurerm_container_app_environment.main.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category_group = "allLogs"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}

resource "azurerm_monitor_diagnostic_setting" "postgres" {
  name                       = "send-to-log-analytics"
  target_resource_id         = azurerm_postgresql_flexible_server.main.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category_group = "allLogs"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}

resource "azurerm_monitor_diagnostic_setting" "key_vault" {
  name                       = "send-to-log-analytics"
  target_resource_id         = azurerm_key_vault.main.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category_group = "allLogs"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}

resource "azurerm_monitor_diagnostic_setting" "workspace_file_service" {
  name                       = "send-to-log-analytics"
  target_resource_id         = "${azurerm_storage_account.workspace.id}/fileServices/default"
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category_group = "allLogs"
  }

  # Azure Files expands AllMetrics into these service-specific categories.
  # Keeping the normalized representation prevents a perpetual post-create diff.
  enabled_metric { category = "Capacity" }
  enabled_metric { category = "SLI" }
  enabled_metric { category = "Transaction" }

  depends_on = [azurerm_storage_share.workspace]
}

resource "azurerm_monitor_diagnostic_setting" "workspace_blob_service" {
  name                       = "send-to-log-analytics"
  target_resource_id         = "${azurerm_storage_account.workspace.id}/blobServices/default"
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category_group = "allLogs"
  }

  enabled_metric {
    category = "AllMetrics"
  }

  depends_on = [azurerm_storage_container.workspace_objects]
}
