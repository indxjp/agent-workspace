locals {
  compact_name = substr(replace(var.name, "-", ""), 0, 14)
  suffix       = random_string.suffix.result
  common_tags = merge({
    application = "agent-workspace"
    environment = "preview"
    managed-by  = "terraform"
  }, var.tags)
}

data "azurerm_client_config" "current" {}

resource "random_string" "suffix" {
  length  = 6
  upper   = false
  special = false
}

resource "azurerm_resource_group" "security" {
  name     = "rg-${var.name}-bootstrap-${local.suffix}"
  location = var.location
  tags     = local.common_tags
}

resource "azurerm_resource_group" "workload" {
  name     = "rg-${var.name}-${local.suffix}"
  location = var.location
  tags     = local.common_tags
}

resource "azurerm_storage_account" "state" {
  name                            = substr("st${local.compact_name}${local.suffix}", 0, 24)
  resource_group_name             = azurerm_resource_group.security.name
  location                        = azurerm_resource_group.security.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  account_kind                    = "StorageV2"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  public_network_access_enabled   = true
  shared_access_key_enabled       = false
  allow_nested_items_to_be_public = false
  tags                            = local.common_tags

  blob_properties {
    versioning_enabled = true

    container_delete_retention_policy {
      days = 7
    }

    delete_retention_policy {
      days = 7
    }
  }
}

resource "azurerm_management_lock" "state" {
  name       = "protect-terraform-state"
  scope      = azurerm_storage_account.state.id
  lock_level = "CanNotDelete"
  notes      = "Protects the remote Terraform state account from accidental deletion."
}

resource "azurerm_storage_container" "state" {
  name                  = "tfstate"
  storage_account_id    = azurerm_storage_account.state.id
  container_access_type = "private"

  depends_on = [time_sleep.bootstrap_operator_state]
}

# The account rejects Shared Key requests. Give the bootstrap caller managed data-plane
# access so the provider can create the initial container through Entra ID.
resource "azurerm_role_assignment" "bootstrap_operator_state" {
  scope                = azurerm_storage_account.state.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = data.azurerm_client_config.current.object_id
}

resource "time_sleep" "bootstrap_operator_state" {
  create_duration = "30s"

  depends_on = [azurerm_role_assignment.bootstrap_operator_state]
}

resource "azurerm_container_registry" "images" {
  name                                         = substr("cr${local.compact_name}${local.suffix}", 0, 50)
  resource_group_name                          = azurerm_resource_group.security.name
  location                                     = azurerm_resource_group.security.location
  sku                                          = "Basic"
  admin_enabled                                = false
  public_network_access_enabled                = true
  anonymous_pull_enabled                       = false
  azuread_authentication_as_arm_policy_enabled = true
  tags                                         = local.common_tags
}

resource "azurerm_user_assigned_identity" "deployer" {
  name                = "id-${var.name}-deployer"
  resource_group_name = azurerm_resource_group.security.name
  location            = azurerm_resource_group.security.location
  tags                = local.common_tags
}

# Contributor creates the stack; RBAC Administrator is required because the main stack grants
# narrowly scoped pull and secret-reading roles to its workload identities. It cannot create new
# owners or elevate itself beyond this resource group.
resource "azurerm_role_assignment" "deployer_contributor" {
  scope                = azurerm_resource_group.workload.id
  role_definition_name = "Contributor"
  principal_id         = azurerm_user_assigned_identity.deployer.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "deployer_rbac_admin" {
  scope                = azurerm_resource_group.workload.id
  role_definition_name = "Role Based Access Control Administrator"
  principal_id         = azurerm_user_assigned_identity.deployer.principal_id
  principal_type       = "ServicePrincipal"
  condition_version    = "2.0"
  condition            = <<-CONDITION
    ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {acdd72a7-3385-48ef-bd42-f606fba81ae7,4633458b-17de-408a-b874-0445c86b69e6,0fb8eba5-a2bb-4abe-b1c1-49dfad359bb0,b86a8fe4-44ce-4948-aee5-eccb2c155cd7})) AND ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {acdd72a7-3385-48ef-bd42-f606fba81ae7,4633458b-17de-408a-b874-0445c86b69e6,0fb8eba5-a2bb-4abe-b1c1-49dfad359bb0,b86a8fe4-44ce-4948-aee5-eccb2c155cd7}))
  CONDITION
}

resource "azurerm_role_assignment" "deployer_state" {
  scope                = azurerm_storage_account.state.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.deployer.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "deployer_acr_push" {
  scope                = azurerm_container_registry.images.id
  role_definition_name = "AcrPush"
  principal_id         = azurerm_user_assigned_identity.deployer.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "deployer_acr_reader" {
  scope                = azurerm_container_registry.images.id
  role_definition_name = "Reader"
  principal_id         = azurerm_user_assigned_identity.deployer.principal_id
  principal_type       = "ServicePrincipal"
}

# The main stack may grant only AcrPull on the protected registry. Contributor remains confined to
# the workload resource group, so the deployment identity cannot change or delete ACR itself.
resource "azurerm_role_assignment" "deployer_acr_rbac_admin" {
  scope                = azurerm_container_registry.images.id
  role_definition_name = "Role Based Access Control Administrator"
  principal_id         = azurerm_user_assigned_identity.deployer.principal_id
  principal_type       = "ServicePrincipal"
  condition_version    = "2.0"
  condition            = <<-CONDITION
    ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {7f951dda-4ed3-4680-a7ca-43fe172d538d})) AND ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {7f951dda-4ed3-4680-a7ca-43fe172d538d}))
  CONDITION
}

# A workflow job that declares `environment:` receives an OIDC token whose sub claim is
# repo:<owner>/<repo>:environment:<name>, never the repo:...:ref:... branch form. Entra ID
# compares the subject byte-for-byte, including owner/repository casing, so this string must
# match `.github/workflows/azure-preview.yml`'s `environment:` value exactly or every token
# exchange fails with AADSTS70021. The credential name is a separate Azure resource name that
# admits only alphanumerics, hyphens, and underscores, so dots legal in a GitHub environment
# name are replaced here; `subject` stays unsanitised.
resource "azurerm_federated_identity_credential" "github" {
  count = var.github_repository == null ? 0 : 1

  name                = "github-env-${replace(var.github_environment, ".", "-")}"
  resource_group_name = azurerm_resource_group.security.name
  parent_id           = azurerm_user_assigned_identity.deployer.id
  audience            = ["api://AzureADTokenExchange"]
  issuer              = "https://token.actions.githubusercontent.com"
  subject             = "repo:${var.github_repository}:environment:${var.github_environment}"
}
