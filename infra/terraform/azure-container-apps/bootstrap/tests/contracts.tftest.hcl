mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = {
      object_id = "11111111-1111-1111-1111-111111111111"
      tenant_id = "22222222-2222-2222-2222-222222222222"
    }
  }
}

mock_provider "random" {}

mock_provider "time" {}

variables {
  subscription_id   = "00000000-0000-0000-0000-000000000000"
  github_repository = "example-org/example-repo"
}

run "github_credential_trusts_the_deploy_job_environment" {
  command = plan

  assert {
    condition     = azurerm_federated_identity_credential.github[0].subject == "repo:example-org/example-repo:environment:azure-preview"
    error_message = "the federated credential must trust the environment sub claim that the deploy job presents, not a branch ref"
  }

  assert {
    condition     = azurerm_federated_identity_credential.github[0].issuer == "https://token.actions.githubusercontent.com"
    error_message = "only GitHub's Actions OIDC issuer may be trusted"
  }

  assert {
    condition     = tolist(azurerm_federated_identity_credential.github[0].audience) == tolist(["api://AzureADTokenExchange"])
    error_message = "the credential must accept only the Entra ID token-exchange audience"
  }

  assert {
    condition     = azurerm_federated_identity_credential.github[0].name == "github-env-azure-preview"
    error_message = "the credential name must derive from the trusted environment"
  }
}

run "dotted_environment_sanitises_only_the_credential_name" {
  command = plan

  variables {
    github_environment = "azure.preview"
  }

  assert {
    condition     = azurerm_federated_identity_credential.github[0].name == "github-env-azure-preview"
    error_message = "a dot is legal in a GitHub environment name but not in an Azure federated credential name, so the name must replace it"
  }

  assert {
    condition     = azurerm_federated_identity_credential.github[0].subject == "repo:example-org/example-repo:environment:azure.preview"
    error_message = "the subject must stay byte-for-byte equal to the GitHub environment name, unsanitised"
  }
}

run "overlong_github_environment_is_rejected" {
  command = plan

  variables {
    github_environment = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }

  expect_failures = [var.github_environment]
}

run "local_only_bootstrap_creates_no_github_trust" {
  command = plan

  variables {
    github_repository = null
  }

  assert {
    condition     = length(azurerm_federated_identity_credential.github) == 0
    error_message = "omitting github_repository must leave the deployment identity without any federated trust"
  }
}

run "invalid_github_environment_is_rejected" {
  command = plan

  variables {
    github_environment = "azure preview"
  }

  expect_failures = [var.github_environment]
}
