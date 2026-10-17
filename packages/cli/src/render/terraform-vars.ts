/**
 * The deployment profile rendered to a Terraform module's variables.
 *
 * Only the variables the profile actually decides are emitted. A module's own `default` is never
 * restated — that is the duplicated default this unit removes — and a variable the profile cannot
 * know (a project id, subscription id, or other account-scoped input) is left
 * for the operator's `terraform.tfvars`, as each module's `terraform.tfvars.example` already
 * shows. `infra/tests/contracts.test.mjs` holds the rendered keys against the module's declared
 * `variable` blocks, so a renamed variable fails there rather than at `terraform apply`.
 */
import type { DeploymentImages } from '../deployment.ts';
import type { DeploymentCloud, DeploymentProfile } from '../profile.ts';

/** The module each cloud's managed deployment uses. AWS has none; EKS is installed with Helm. */
const TERRAFORM_MODULES: Readonly<Record<DeploymentCloud, string | null>> = {
  gcp: 'gcp-cloudrun',
  azure: 'azure-container-apps',
  aws: null,
  local: null,
  vercel: null,
  cloudflare: null,
};

export interface TerraformVariablesArtefact {
  /** The directory under `infra/terraform` these variables are applied in. */
  readonly module: string;
  readonly fileName: string;
  readonly contents: string;
}

/** The `.env` values a module takes as variables; unset values are not rendered. */
export interface TerraformVariableOptions {
  readonly deploymentPolicy?: string | undefined;
  readonly publicUrl?: string | undefined;
}

/**
 * Render the module's `.auto.tfvars.json`, or `null` when the profile's cloud has no module.
 *
 * `.auto.tfvars.json` rather than `.tfvars`: Terraform loads it without a `-var-file` flag, and
 * JSON has one unambiguous writer, so the generated file cannot drift in formatting the way
 * hand-written HCL does.
 *
 * `deploymentPolicy` is the policy ceiling JSON `.env` carries as `AW_DEPLOYMENT_POLICY`; only the
 * gcp-cloudrun module declares `deployment_policy`, so no other module is given it. `publicUrl` is
 * the origin `.env` carries as `AW_PUBLIC_URL` (ADR-0135); the gcp-cloudrun and azure-container-apps
 * modules both declare `public_url`.
 */
export function renderTerraformVariables(
  profile: DeploymentProfile,
  images: DeploymentImages,
  { deploymentPolicy, publicUrl }: TerraformVariableOptions = {},
): TerraformVariablesArtefact | null {
  const module = TERRAFORM_MODULES[profile.cloud];
  if (module === null) return null;

  const objectContainerName = profile.storage.objects.startsWith('azblob://')
    ? profile.storage.objects.slice('azblob://'.length)
    : undefined;
  const variables = {
    bootstrap_admin_email: profile.identity.bootstrapAdmin,
    ...(objectContainerName === undefined ? {} : { object_container_name: objectContainerName }),
    ...(deploymentPolicy === undefined || module !== 'gcp-cloudrun'
      ? {}
      : { deployment_policy: deploymentPolicy }),
    ...(publicUrl === undefined ? {} : { public_url: publicUrl }),
    images: {
      web: images.web,
      gateway: images.gateway,
      runner: images.runner,
      runtime: images.runtime,
    },
  };

  return {
    module,
    fileName: `${module}.auto.tfvars.json`,
    contents: `${JSON.stringify(variables, null, 2)}\n`,
  };
}
