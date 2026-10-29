mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = {
      object_id       = "11111111-1111-1111-1111-111111111111"
      tenant_id       = "22222222-2222-2222-2222-222222222222"
      subscription_id = "00000000-0000-0000-0000-000000000000"
    }
  }

  mock_data "azurerm_resource_group" {
    defaults = {
      id       = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-agent-workspace-test"
      name     = "rg-agent-workspace-test"
      location = "japaneast"
    }
  }

  mock_data "azurerm_container_registry" {
    defaults = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-agent-workspace-bootstrap-test/providers/Microsoft.ContainerRegistry/registries/cragentworkspacetest"
      name         = "cragentworkspacetest"
      login_server = "cragentworkspacetest.azurecr.io"
    }
  }

  mock_resource "azurerm_user_assigned_identity" {
    override_during = plan

    defaults = {
      client_id    = "33333333-3333-3333-3333-333333333333"
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-agent-workspace-test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/mock-identity"
      principal_id = "44444444-4444-4444-4444-444444444444"
    }
  }

  mock_resource "azurerm_storage_container" {
    override_during = plan

    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-agent-workspace-test/providers/Microsoft.Storage/storageAccounts/stagentworkspace/blobServices/default/containers/acme-ai-files"
    }
  }
}

mock_provider "azapi" {}

mock_provider "random" {
  mock_resource "random_string" {
    override_during = plan

    defaults = {
      result = "abcdef"
    }
  }
}

variables {
  subscription_id                        = "00000000-0000-0000-0000-000000000000"
  resource_group_name                    = "rg-agent-workspace-test"
  container_registry_name                = "cragentworkspacetest"
  container_registry_resource_group_name = "rg-agent-workspace-bootstrap-test"
  bootstrap_admin_email                  = "owner@example.com"
  object_container_name                  = "acme-ai-files"

  images = {
    web     = "cragentworkspacetest.azurecr.io/agent-workspace/web@sha256:1111111111111111111111111111111111111111111111111111111111111111"
    gateway = "cragentworkspacetest.azurecr.io/agent-workspace/gateway@sha256:2222222222222222222222222222222222222222222222222222222222222222"
    runner  = "cragentworkspacetest.azurecr.io/agent-workspace/runner@sha256:3333333333333333333333333333333333333333333333333333333333333333"
    runtime = "cragentworkspacetest.azurecr.io/agent-workspace/runtime@sha256:4444444444444444444444444444444444444444444444444444444444444444"
  }
}

run "preview_apps_scale_to_zero_and_sandbox_is_separate" {
  command = plan

  assert {
    condition = (
      azurerm_container_app.web.template[0].min_replicas == 0 &&
      azurerm_container_app.gateway.template[0].min_replicas == 0 &&
      azurerm_container_app.runner.template[0].min_replicas == 0
    )
    error_message = "all long-lived Container Apps must permit scale-to-zero"
  }

  assert {
    condition     = azurerm_container_app.runner.template[0].max_replicas == 1
    error_message = "the process-local runner allocation registry requires exactly one maximum replica"
  }

  assert {
    condition = (
      !azurerm_container_app_environment.main.internal_load_balancer_enabled &&
      azurerm_container_app.web.ingress[0].external_enabled &&
      azurerm_container_app.gateway.ingress[0].external_enabled &&
      !azurerm_container_app.runner.ingress[0].external_enabled
    )
    error_message = "Dynamic Sessions must reach the run-token-protected gateway through external HTTPS ingress"
  }

  assert {
    condition = (
      azurerm_container_app.runner.ingress[0].transport == "tcp" &&
      azurerm_container_app.runner.ingress[0].exposed_port == 8090
    )
    error_message = "web-to-runner traffic must use internal TCP ingress to avoid ACA's 240-second HTTP timeout"
  }

  assert {
    condition     = azapi_resource.session_pool[0].body.properties.scaleConfiguration.readySessionInstances == 1
    error_message = "the Dynamic Sessions pool must use Azure's minimum supported warm sandbox count"
  }

  assert {
    condition     = azapi_resource.session_pool[0].body.properties.managedIdentitySettings[0].lifecycle == "None"
    error_message = "the image-pull identity must never enter a running sandbox"
  }

  assert {
    condition = length([
      for item in azapi_resource.session_pool[0].body.properties.customContainerTemplate.containers[0].env : item
      if item.name == "AW_SESSION_MIRROR_URL" && startswith(item.value, "https://ca-agent-workspace-web.")
    ]) == 1
    error_message = "the sandbox template must receive the stable public web URL for transcript mirroring"
  }

  assert {
    condition = length([
      for item in azurerm_container_app.runner.template[0].container[0].env : item
      if item.name == "ACA_SESSION_POOL_NETWORK_STATUS" && item.value == "EgressEnabled"
    ]) == 1
    error_message = "the runner must receive the pool's honest all-or-nothing network status"
  }
}

run "gateway_stays_internal_without_dynamic_sessions" {
  command = plan

  variables {
    enable_dynamic_sessions = false
  }

  assert {
    condition     = !azurerm_container_app.gateway.ingress[0].external_enabled
    error_message = "the gateway must stay internal when no external Dynamic Sessions are configured"
  }
}

run "azure_native_data_backends_use_managed_identity" {
  command = plan

  assert {
    condition     = azurerm_storage_container.workspace_objects.container_access_type == "private"
    error_message = "the native object container must never permit anonymous access"
  }

  assert {
    condition = (
      azurerm_role_assignment.web_blob_contributor.scope == azurerm_storage_container.workspace_objects.id &&
      azurerm_role_assignment.web_blob_contributor.role_definition_name == "Storage Blob Data Contributor" &&
      azurerm_role_assignment.web_blob_contributor.principal_id == azurerm_user_assigned_identity.web.principal_id
    )
    error_message = "only the web identity receives container-scoped Blob data access"
  }

  assert {
    condition = length([
      for item in azurerm_container_app.web.template[0].container[0].env : item
      if item.name == "AW_STORAGE_URL" && item.value == "azblob://${azurerm_storage_account.workspace.name}/${azurerm_storage_container.workspace_objects.name}"
    ]) == 1
    error_message = "the web application must receive one AW_STORAGE_URL naming the provisioned account and container"
  }

  assert {
    condition = length([
      for item in azurerm_container_app.web.template[0].container[0].env : item
      if contains(["OBJECT_STORAGE_BACKEND", "OBJECT_STORAGE_BUCKET", "OBJECT_STORAGE_ENDPOINT", "AW_SESSION_TRANSCRIPT_ROOT"], item.name)
    ]) == 0
    error_message = "the web application must not also receive the old storage settings, which the server ignores with a warning"
  }

  assert {
    condition = alltrue([
      for app in [azurerm_container_app.web, azurerm_container_app.gateway] :
      length([
        for item in app.template[0].container[0].env : item
        if item.name == "MASTER_KEY_PROVIDER" && item.value == "key-vault"
      ]) == 1
    ])
    error_message = "web and gateway must load the deployment master key through Key Vault"
  }

  assert {
    condition = alltrue([
      for app in [azurerm_container_app.web, azurerm_container_app.gateway] :
      length([
        for item in app.template[0].container[0].env : item
        if item.name == "MASTER_ENCRYPTION_KEY"
      ]) == 0
    ])
    error_message = "the Key Vault-backed master key must not be projected into process environment"
  }
}

run "mutable_image_tags_are_rejected" {
  command = plan

  variables {
    images = {
      web     = "cragentworkspacetest.azurecr.io/agent-workspace/web:latest"
      gateway = "cragentworkspacetest.azurecr.io/agent-workspace/gateway:latest"
      runner  = "cragentworkspacetest.azurecr.io/agent-workspace/runner:latest"
      runtime = "cragentworkspacetest.azurecr.io/agent-workspace/runtime:latest"
    }
  }

  expect_failures = [var.images]
}

run "session_pool_generation_replaces_only_pool_name" {
  command = plan

  variables {
    session_pool_generation = "blue2"
  }

  assert {
    condition     = endswith(local.session_pool_name, "gblue2")
    error_message = "a generation token must qualify the pool name"
  }

  assert {
    condition     = length(local.session_pool_name) <= 32
    error_message = "a generation-qualified pool name must satisfy Azure's 32-character limit"
  }

  assert {
    condition = (
      azurerm_container_app.web.name == "ca-agent-workspace-web" &&
      azurerm_container_app.gateway.name == "ca-agent-workspace-gateway" &&
      azurerm_container_app.runner.name == "ca-agent-workspace-runner"
    )
    error_message = "a pool generation bump must not rename long-lived Container Apps"
  }
}

run "invalid_session_pool_generation_is_rejected" {
  command = plan

  variables {
    session_pool_generation = "Blue-green-02"
  }

  expect_failures = [var.session_pool_generation]
}

run "public_url_is_absent_from_web_when_unset" {
  command = plan

  assert {
    condition = length([
      for item in azurerm_container_app.web.template[0].container[0].env : item
      if item.name == "AW_PUBLIC_URL"
    ]) == 0
    error_message = "an unset public_url must leave AW_PUBLIC_URL off the web container"
  }
}

run "public_url_reaches_web_alone" {
  command = plan

  variables {
    public_url = "https://aw.example.com"
  }

  assert {
    condition = length([
      for item in azurerm_container_app.web.template[0].container[0].env : item
      if item.name == "AW_PUBLIC_URL" && item.value == "https://aw.example.com"
    ]) == 1
    error_message = "public_url must reach the web container as exactly one AW_PUBLIC_URL"
  }

  assert {
    condition = alltrue([
      for app in [azurerm_container_app.gateway, azurerm_container_app.runner] :
      length([for item in app.template[0].container[0].env : item if item.name == "AW_PUBLIC_URL"]) == 0
    ])
    error_message = "only web serves agent cards, so the gateway and runner must not receive AW_PUBLIC_URL"
  }
}

run "public_url_with_a_path_is_rejected" {
  command = plan

  variables {
    public_url = "https://aw.example.com/path"
  }

  expect_failures = [var.public_url]
}

run "storage_blob_endpoint_reaches_the_storage_url" {
  command = plan

  variables {
    storage_blob_endpoint = "https://stagentworkspace.blob.core.usgovcloudapi.net"
  }

  assert {
    condition = length([
      for item in azurerm_container_app.web.template[0].container[0].env : item
      if item.name == "AW_STORAGE_URL" && item.value == "azblob://${azurerm_storage_account.workspace.name}/${azurerm_storage_container.workspace_objects.name}?endpoint=https://stagentworkspace.blob.core.usgovcloudapi.net"
    ]) == 1
    error_message = "a sovereign-cloud storage_blob_endpoint must reach AW_STORAGE_URL as its endpoint"
  }
}

run "storage_blob_endpoint_must_be_an_https_origin" {
  command = plan

  variables {
    storage_blob_endpoint = "http://stagentworkspace.blob.core.chinacloudapi.cn/path"
  }

  expect_failures = [var.storage_blob_endpoint]
}
