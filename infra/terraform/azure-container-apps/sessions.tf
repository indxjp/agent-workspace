# The stable 2025-07-01 session-pool schema removed probes. This preview API is used deliberately
# because the runtime contract requires startup and liveness checks; see README.md for the upgrade
# rule. The data-plane management endpoint remains on 2025-02-02-preview.
resource "time_sleep" "acr_pull_rbac" {
  create_duration = "60s"

  triggers = {
    role_assignment_ids = join(",", sort([for assignment in azurerm_role_assignment.acr_pull : assignment.id]))
  }

  depends_on = [
    azurerm_role_assignment.acr_pull,
  ]
}

resource "azapi_resource" "session_pool" {
  count = var.enable_dynamic_sessions ? 1 : 0

  type          = "Microsoft.App/sessionPools@2025-10-02-preview"
  name          = local.session_pool_name
  parent_id     = data.azurerm_resource_group.deployment.id
  location      = local.location
  tags          = local.common_tags
  ignore_casing = true

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.session_pool[0].id]
  }

  body = {
    properties = {
      environmentId      = azurerm_container_app_environment.main.id
      poolManagementType = "Dynamic"
      containerType      = "CustomContainer"
      scaleConfiguration = {
        readySessionInstances = var.session_pool_ready_instances
        maxConcurrentSessions = var.session_pool_max_concurrent_sessions
      }
      dynamicPoolConfiguration = {
        lifecycleConfiguration = {
          lifecycleType           = "Timed"
          cooldownPeriodInSeconds = var.session_pool_cooldown_seconds
        }
      }
      sessionNetworkConfiguration = {
        status = var.session_pool_network_status
      }
      managedIdentitySettings = [{
        identity  = azurerm_user_assigned_identity.session_pool[0].id
        lifecycle = "None"
      }]
      customContainerTemplate = {
        registryCredentials = {
          server   = data.azurerm_container_registry.images.login_server
          identity = azurerm_user_assigned_identity.session_pool[0].id
        }
        ingress = {
          targetPort = 8080
        }
        containers = [{
          name  = "runtime"
          image = var.images.runtime
          env = [
            { name = "NODE_ENV", value = "production" },
            { name = "HOST", value = "0.0.0.0" },
            { name = "PORT", value = "8080" },
            { name = "AW_SESSION_MIRROR_URL", value = local.web_base_url },
          ]
          resources = {
            cpu    = 1
            memory = "2Gi"
          }
          probes = [
            {
              type                          = "Startup"
              initialDelaySeconds           = 0
              periodSeconds                 = 2
              timeoutSeconds                = 2
              failureThreshold              = 30
              successThreshold              = 1
              terminationGracePeriodSeconds = 30
              httpGet = {
                path   = "/healthz"
                port   = 8080
                scheme = "HTTP"
              }
            },
            {
              type                          = "Liveness"
              initialDelaySeconds           = 10
              periodSeconds                 = 10
              timeoutSeconds                = 5
              failureThreshold              = 3
              successThreshold              = 1
              terminationGracePeriodSeconds = 30
              httpGet = {
                path   = "/healthz"
                port   = 8080
                scheme = "HTTP"
              }
            },
          ]
        }]
      }
    }
  }

  depends_on = [
    time_sleep.acr_pull_rbac,
  ]

  lifecycle {
    create_before_destroy = true
  }
}

resource "azurerm_role_assignment" "runner_session_executor" {
  count = var.enable_dynamic_sessions ? 1 : 0

  scope                = azapi_resource.session_pool[0].id
  role_definition_name = "Azure ContainerApps Session Executor"
  principal_id         = azurerm_user_assigned_identity.runner.principal_id
  principal_type       = "ServicePrincipal"

  lifecycle {
    create_before_destroy = true
  }
}

resource "time_sleep" "runner_session_rbac" {
  count = var.enable_dynamic_sessions ? 1 : 0

  create_duration = "30s"

  triggers = {
    role_assignment_id = azurerm_role_assignment.runner_session_executor[0].id
  }
}

resource "time_sleep" "workload_rbac" {
  create_duration = "30s"

  triggers = {
    role_assignment_ids = join(",", sort(concat(
      [for assignment in azurerm_role_assignment.acr_pull : assignment.id],
      [for assignment in azurerm_role_assignment.web_secret_reader : assignment.id],
      [for assignment in azurerm_role_assignment.gateway_secret_reader : assignment.id],
      [for assignment in azurerm_role_assignment.runner_secret_reader : assignment.id],
      [azurerm_role_assignment.web_blob_contributor.id],
    )))
  }

  depends_on = [
    azurerm_role_assignment.acr_pull,
    azurerm_role_assignment.web_secret_reader,
    azurerm_role_assignment.gateway_secret_reader,
    azurerm_role_assignment.runner_secret_reader,
    azurerm_role_assignment.web_blob_contributor,
  ]
}
