resource "azurerm_user_assigned_identity" "web" {
  name                = "id-${var.name}-web"
  resource_group_name = data.azurerm_resource_group.deployment.name
  location            = local.location
  tags                = local.common_tags
}

resource "azurerm_user_assigned_identity" "gateway" {
  name                = "id-${var.name}-gateway"
  resource_group_name = data.azurerm_resource_group.deployment.name
  location            = local.location
  tags                = local.common_tags
}

resource "azurerm_user_assigned_identity" "runner" {
  name                = "id-${var.name}-runner"
  resource_group_name = data.azurerm_resource_group.deployment.name
  location            = local.location
  tags                = local.common_tags
}

resource "azurerm_user_assigned_identity" "session_pool" {
  count = var.enable_dynamic_sessions ? 1 : 0

  name                = "id-${var.name}-sessions"
  resource_group_name = data.azurerm_resource_group.deployment.name
  location            = local.location
  tags                = local.common_tags
}

locals {
  workload_identities = merge({
    web     = azurerm_user_assigned_identity.web.principal_id
    gateway = azurerm_user_assigned_identity.gateway.principal_id
    runner  = azurerm_user_assigned_identity.runner.principal_id
    }, var.enable_dynamic_sessions ? {
    session_pool = azurerm_user_assigned_identity.session_pool[0].principal_id
  } : {})
}

resource "azurerm_role_assignment" "acr_pull" {
  for_each = local.workload_identities

  scope                = data.azurerm_container_registry.images.id
  role_definition_name = "AcrPull"
  principal_id         = each.value
  principal_type       = "ServicePrincipal"
}

resource "azurerm_key_vault" "main" {
  name                          = substr("kv-${local.unique_name}", 0, 24)
  resource_group_name           = data.azurerm_resource_group.deployment.name
  location                      = local.location
  tenant_id                     = data.azurerm_client_config.current.tenant_id
  sku_name                      = "standard"
  rbac_authorization_enabled    = true
  purge_protection_enabled      = true
  soft_delete_retention_days    = 7
  public_network_access_enabled = true
  tags                          = local.common_tags
}

# The principal running Terraform needs only secret CRUD in this vault. Workload identities are
# granted get/list separately and never receive management-plane roles.
resource "azurerm_role_assignment" "terraform_secret_officer" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

resource "time_sleep" "key_vault_rbac" {
  create_duration = "30s"

  depends_on = [azurerm_role_assignment.terraform_secret_officer]
}

resource "random_password" "master_encryption_key_entropy" {
  length  = 64
  special = false
}

resource "random_password" "session_secret" {
  length  = 64
  special = false
}

resource "random_password" "runner_manager_token" {
  length  = 48
  special = false
}

resource "random_password" "gateway_token_secret" {
  length  = 64
  special = false
}

resource "random_password" "bootstrap_admin_password" {
  length           = 24
  special          = true
  override_special = "!#%*+-.:=?@_"
}

locals {
  secret_values = {
    database-url = "postgresql://agentworkspace:${random_password.database.result}@${azurerm_postgresql_flexible_server.main.fqdn}:5432/${azurerm_postgresql_flexible_server_database.main.name}?sslmode=require"
    # sha256 converts the sensitive entropy to the 64 hexadecimal characters
    # required by the application's AES-256 master-key parser. Unlike
    # random_id, random_password uses a non-secret constant resource ID, so
    # Terraform never prints the generated value in routine apply logs.
    master-encryption-key    = sha256(random_password.master_encryption_key_entropy.result)
    session-secret           = random_password.session_secret.result
    runner-manager-token     = random_password.runner_manager_token.result
    gateway-token-secret     = random_password.gateway_token_secret.result
    bootstrap-admin-password = random_password.bootstrap_admin_password.result
  }
}

resource "azurerm_key_vault_secret" "deployment" {
  for_each = local.secret_values

  name         = each.key
  value        = each.value
  key_vault_id = azurerm_key_vault.main.id
  content_type = "Agent Workspace deployment secret"
  tags         = local.common_tags

  depends_on = [time_sleep.key_vault_rbac]
}

locals {
  web_container_secret_names = toset([
    "database-url",
    "session-secret",
    "runner-manager-token",
    "gateway-token-secret",
    "bootstrap-admin-password",
  ])
  gateway_container_secret_names = toset([
    "database-url",
    "gateway-token-secret",
  ])
  web_key_vault_secret_names = setunion(
    local.web_container_secret_names,
    toset(["master-encryption-key"]),
  )
  gateway_key_vault_secret_names = setunion(
    local.gateway_container_secret_names,
    toset(["master-encryption-key"]),
  )
  runner_secret_names = toset(["runner-manager-token"])
}

resource "azurerm_role_assignment" "web_secret_reader" {
  for_each = local.web_key_vault_secret_names

  scope                = "${azurerm_key_vault.main.id}/secrets/${each.value}"
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.web.principal_id
  principal_type       = "ServicePrincipal"
  depends_on           = [azurerm_key_vault_secret.deployment]
}

resource "azurerm_role_assignment" "gateway_secret_reader" {
  for_each = local.gateway_key_vault_secret_names

  scope                = "${azurerm_key_vault.main.id}/secrets/${each.value}"
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.gateway.principal_id
  principal_type       = "ServicePrincipal"
  depends_on           = [azurerm_key_vault_secret.deployment]
}

resource "azurerm_role_assignment" "runner_secret_reader" {
  for_each = local.runner_secret_names

  scope                = "${azurerm_key_vault.main.id}/secrets/${each.value}"
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.runner.principal_id
  principal_type       = "ServicePrincipal"
  depends_on           = [azurerm_key_vault_secret.deployment]
}
