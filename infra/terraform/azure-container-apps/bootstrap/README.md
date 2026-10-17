# Azure Container Apps bootstrap

This one-time stack creates two resource groups. The protected bootstrap group contains Azure Blob
state storage, Azure Container Registry, the deployment identity, and optional GitHub Actions OIDC
trust scoped to one GitHub environment. The separate workload group is the only resource group where
that identity has Contributor. Bootstrap intentionally keeps its own small state local: the remote
backend does not exist until this stack has been applied.

When `github_repository` is set, the federated credential's subject is
`repo:<github_repository>:environment:<github_environment>` (`azure-preview` by default), which is
the `sub` claim a job that declares `environment:` presents. Entra ID matches it byte-for-byte:
the GitHub environment named in `.github/workflows/azure-preview.yml` must already exist under that
exact name, and `github_repository` must use GitHub's canonical owner/repository casing. That trust
is environment-scoped, not ref-scoped: any workflow run in the repository that declares the
environment can exchange its token for this identity, on any ref, so the environment's deployment
branch policy and required reviewers are the remaining ref control and must be configured.

Register `Microsoft.Storage`, `Microsoft.ContainerRegistry`, `Microsoft.ManagedIdentity`, and
`Microsoft.Authorization` in the subscription before applying. Provider auto-registration is
disabled so the resulting resource-group-scoped deployment identity can run the main stack.

## Apply

```powershell
Copy-Item terraform.tfvars.example terraform.tfvars
terraform init
terraform plan -out bootstrap.tfplan
terraform apply bootstrap.tfplan
terraform output -json backend_config
```

Keep `bootstrap.tfstate` in an access-controlled operator location. Do not commit it. The storage
account disables shared-key access; Terraform and CI must authenticate to the backend with Entra
ID (`use_azuread_auth=true`). Blob versioning and seven-day soft deletion protect the main state.
An Azure `CanNotDelete` lock protects the state account; the bootstrap operator owns the lock, not
the workload deployment identity.
The bootstrap caller receives Storage Blob Data Contributor on this account so the provider can
create and maintain the container through Entra ID.

The deployment identity receives Contributor and a conditioned RBAC Administrator grant only in
the workload group. That condition permits only Reader, Key Vault Secrets User, Key Vault Secrets
Officer, and Azure ContainerApps Session Executor assignments. A second RBAC Administrator grant
is scoped directly to ACR and permits only AcrPull assignments. The identity also receives Storage
Blob Data Contributor on the state account and AcrPush on the registry; it cannot update or delete
the protected storage account, registry, identity, or federated credential. ACR-scoped Reader lets
Terraform resolve the protected registry without granting any management write.

Use `resource_group_name`, `container_registry_name`, and
`container_registry_resource_group_name` in the main stack. Pass the `backend_config` fields to
`terraform init -backend-config=...`; never copy them into source.
