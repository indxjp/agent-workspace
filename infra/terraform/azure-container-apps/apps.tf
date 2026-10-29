resource "azurerm_container_app" "gateway" {
  name                         = "ca-${var.name}-gateway"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = data.azurerm_resource_group.deployment.name
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"
  tags                         = local.common_tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.gateway.id]
  }

  registry {
    server   = data.azurerm_container_registry.images.login_server
    identity = azurerm_user_assigned_identity.gateway.id
  }

  dynamic "secret" {
    for_each = local.gateway_container_secret_names

    content {
      name                = secret.value
      key_vault_secret_id = azurerm_key_vault_secret.deployment[secret.value].versionless_id
      identity            = azurerm_user_assigned_identity.gateway.id
    }
  }

  ingress {
    # Dynamic Sessions are outside this Container Apps environment and cannot reach internal ingress.
    # Every model route still requires a short-lived run token; only /health is anonymous.
    external_enabled           = var.enable_dynamic_sessions
    allow_insecure_connections = false
    target_port                = 4000
    transport                  = "auto"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = 0
    max_replicas = 2

    container {
      name   = "gateway"
      image  = var.images.gateway
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "AZURE_CLIENT_ID"
        value = azurerm_user_assigned_identity.gateway.client_id
      }
      env {
        # aw-control MCP calls go to web. The environment-derived address, not the web app's
        # attribute: web already depends on this app for MODEL_GATEWAY_URL.
        name  = "GATEWAY_CONTROL_PLANE_ORIGIN"
        value = local.web_base_url
      }
      env {
        name  = "MASTER_KEY_PROVIDER"
        value = "key-vault"
      }
      env {
        name  = "AZURE_KEY_VAULT_URL"
        value = azurerm_key_vault.main.vault_uri
      }
      env {
        name  = "AZURE_MASTER_KEY_SECRET_NAME"
        value = "master-encryption-key"
      }
      env {
        name  = "GATEWAY_PRICING_JSON"
        value = var.gateway_pricing_json
      }
      env {
        name        = "DATABASE_URL"
        secret_name = "database-url"
      }
      env {
        name        = "GATEWAY_TOKEN_SECRET"
        secret_name = "gateway-token-secret"
      }

      startup_probe {
        transport               = "HTTP"
        port                    = 4000
        path                    = "/health"
        initial_delay           = 1
        interval_seconds        = 2
        timeout                 = 2
        failure_count_threshold = 30
      }

      liveness_probe {
        transport               = "HTTP"
        port                    = 4000
        path                    = "/health"
        initial_delay           = 10
        interval_seconds        = 10
        timeout                 = 5
        failure_count_threshold = 3
      }

      readiness_probe {
        transport               = "HTTP"
        port                    = 4000
        path                    = "/health"
        interval_seconds        = 5
        timeout                 = 3
        failure_count_threshold = 3
        success_count_threshold = 1
      }
    }
  }

  depends_on = [time_sleep.workload_rbac]
}

resource "azurerm_container_app" "runner" {
  name                         = local.runner_app_name
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = data.azurerm_resource_group.deployment.name
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"
  tags                         = local.common_tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.runner.id]
  }

  registry {
    server   = data.azurerm_container_registry.images.login_server
    identity = azurerm_user_assigned_identity.runner.id
  }

  dynamic "secret" {
    for_each = local.runner_secret_names

    content {
      name                = secret.value
      key_vault_secret_id = azurerm_key_vault_secret.deployment[secret.value].versionless_id
      identity            = azurerm_user_assigned_identity.runner.id
    }
  }

  ingress {
    external_enabled           = false
    allow_insecure_connections = false
    target_port                = 8090
    exposed_port               = 8090
    transport                  = "tcp"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = 0
    max_replicas = 1

    tcp_scale_rule {
      name                = "runner-connections"
      concurrent_requests = 10
    }

    container {
      name   = "runner-manager"
      image  = var.images.runner
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "AZURE_CLIENT_ID"
        value = azurerm_user_assigned_identity.runner.client_id
      }
      env {
        name  = "RUNTIME_DRIVER"
        value = local.runtime_driver
      }
      env {
        name  = "ACA_SESSION_POOL_ENDPOINT"
        value = local.session_pool_endpoint
      }
      env {
        # ENG-07 (ADR-0073 D6): a session pool is provisioned with one image, so it offers one
        # engine; the pool in sessions.tf runs var.images.runtime, the Claude engine's image.
        name  = "ACA_SESSION_POOL_ENGINE"
        value = "claude-agent-sdk"
      }
      env {
        name  = "ACA_SESSION_POOL_API_VERSION"
        value = "2025-02-02-preview"
      }
      env {
        name  = "ACA_SESSION_API_VERSION"
        value = "2025-02-02-preview"
      }
      env {
        name  = "ACA_SESSION_POOL_NETWORK_STATUS"
        value = var.session_pool_network_status
      }
      env {
        name  = "ACA_SESSION_NETWORK_STATUS"
        value = var.session_pool_network_status
      }
      env {
        name  = "RUNTIME_VERIFICATION_NETWORK_POLICY"
        value = local.verification_network_policy
      }
      env {
        name  = "RUNTIME_VERIFICATION_TIMEOUT_MS"
        value = "150000"
      }
      env {
        name        = "RUNNER_MANAGER_TOKEN"
        secret_name = "runner-manager-token"
      }

      startup_probe {
        transport               = "HTTP"
        port                    = 8090
        path                    = "/healthz"
        initial_delay           = 1
        interval_seconds        = 2
        timeout                 = 2
        failure_count_threshold = 30
      }

      liveness_probe {
        transport               = "HTTP"
        port                    = 8090
        path                    = "/healthz"
        initial_delay           = 10
        interval_seconds        = 10
        timeout                 = 5
        failure_count_threshold = 3
      }

      readiness_probe {
        transport               = "HTTP"
        port                    = 8090
        path                    = "/healthz"
        interval_seconds        = 5
        timeout                 = 3
        failure_count_threshold = 3
        success_count_threshold = 1
      }
    }
  }

  depends_on = [
    time_sleep.runner_session_rbac,
    time_sleep.workload_rbac,
  ]
}

resource "azurerm_container_app" "web" {
  name                         = local.web_app_name
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = data.azurerm_resource_group.deployment.name
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"
  tags                         = local.common_tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.web.id]
  }

  registry {
    server   = data.azurerm_container_registry.images.login_server
    identity = azurerm_user_assigned_identity.web.id
  }

  dynamic "secret" {
    for_each = local.web_container_secret_names

    content {
      name                = secret.value
      key_vault_secret_id = azurerm_key_vault_secret.deployment[secret.value].versionless_id
      identity            = azurerm_user_assigned_identity.web.id
    }
  }

  ingress {
    external_enabled           = true
    allow_insecure_connections = false
    target_port                = 3000
    transport                  = "auto"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = 0
    max_replicas = var.web_max_replicas

    volume {
      name          = "workspace-state"
      storage_name  = azurerm_container_app_environment_storage.workspace.name
      storage_type  = "AzureFile"
      mount_options = "uid=1000,gid=1000,dir_mode=0770,file_mode=0660,nosharesock"
    }

    container {
      name   = "web"
      image  = var.images.web
      cpu    = 1
      memory = "2Gi"

      volume_mounts {
        name = "workspace-state"
        path = local.state_mount_path
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "AZURE_CLIENT_ID"
        value = azurerm_user_assigned_identity.web.client_id
      }
      env {
        name  = "BOOTSTRAP_ADMIN"
        value = var.bootstrap_admin_email
      }
      env {
        # One setting for where files, skills and session transcripts live (the storage design, §04).
        # The server derives the public cloud's blob host from the account; a sovereign cloud names
        # its own through storage_blob_endpoint.
        name  = "AW_STORAGE_URL"
        value = "azblob://${azurerm_storage_account.workspace.name}/${azurerm_storage_container.workspace_objects.name}${var.storage_blob_endpoint == null ? "" : "?endpoint=${var.storage_blob_endpoint}"}"
      }
      dynamic "env" {
        # Absent when unset, so the server default applies and an existing app gets no new revision.
        for_each = var.storage_signed_upload_max_bytes == null ? [] : [var.storage_signed_upload_max_bytes]
        content {
          name  = "AW_STORAGE_SIGNED_UPLOAD_MAX_BYTES"
          value = tostring(env.value)
        }
      }
      env {
        name  = "AW_RUNTIME_VERIFICATION_FILE"
        value = "${local.state_mount_path}/runtime-verifications.json"
      }
      env {
        name  = "RUNNER_MANAGER_URL"
        value = local.runner_manager_url
      }
      env {
        name  = "MODEL_GATEWAY_URL"
        value = "https://${azurerm_container_app.gateway.ingress[0].fqdn}"
      }
      env {
        # ENG-07 (ADR-0073): the control plane offers exactly the engines it has an image for.
        name  = "AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK"
        value = var.images.runtime
      }
      env {
        name  = "RUNTIME_DRIVER"
        value = local.runtime_driver
      }
      env {
        name  = "RUNTIME_VERIFICATION_NETWORK_POLICY"
        value = local.verification_network_policy
      }
      env {
        name  = "MASTER_KEY_PROVIDER"
        value = "key-vault"
      }
      env {
        name  = "AZURE_KEY_VAULT_URL"
        value = azurerm_key_vault.main.vault_uri
      }
      env {
        name  = "AZURE_MASTER_KEY_SECRET_NAME"
        value = "master-encryption-key"
      }
      dynamic "env" {
        # ADR-0135: the origin A2A agent cards advertise. Absent when unset, so an existing app
        # gets no new revision.
        for_each = var.public_url == "" ? [] : [var.public_url]
        content {
          name  = "AW_PUBLIC_URL"
          value = env.value
        }
      }
      env {
        name        = "DATABASE_URL"
        secret_name = "database-url"
      }
      env {
        name        = "GATEWAY_TOKEN_SECRET"
        secret_name = "gateway-token-secret"
      }
      env {
        name        = "SESSION_SECRET"
        secret_name = "session-secret"
      }
      env {
        name        = "BOOTSTRAP_ADMIN_PASSWORD"
        secret_name = "bootstrap-admin-password"
      }
      env {
        name        = "RUNNER_MANAGER_TOKEN"
        secret_name = "runner-manager-token"
      }

      startup_probe {
        transport               = "TCP"
        port                    = 3000
        initial_delay           = 1
        interval_seconds        = 2
        timeout                 = 2
        failure_count_threshold = 30
      }

      liveness_probe {
        transport               = "TCP"
        port                    = 3000
        initial_delay           = 10
        interval_seconds        = 10
        timeout                 = 5
        failure_count_threshold = 3
      }

      readiness_probe {
        transport               = "TCP"
        port                    = 3000
        interval_seconds        = 5
        timeout                 = 3
        failure_count_threshold = 3
        success_count_threshold = 1
      }
    }
  }

  depends_on = [
    azurerm_container_app_environment_storage.workspace,
    azurerm_container_app.gateway,
    azurerm_container_app.runner,
    time_sleep.workload_rbac,
  ]
}
