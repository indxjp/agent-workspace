# Terraform state bootstrap

Authenticate with Application Default Credentials or Workload Identity Federation, copy
`terraform.tfvars.example`, then run `terraform init && terraform apply`. The output is the exact
backend command for the parent stack. Secret values do not belong in either stack's variables or
state.

The bucket uses uniform access, public-access prevention, object versioning, a seven-day retention
floor, and no force-destroy. The binding is intentionally restricted to explicitly named people or
groups.
