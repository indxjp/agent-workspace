/**
 * Which real tool `agent-workspace deploy` drives for a profile, and where its inputs are
 * (ADR-0094).
 *
 * The answer is read from the same renderers `render` writes with, never restated: a profile gets
 * a Terraform target when `renderTerraformVariables` renders it variables, and a chart target when
 * `renderHelmValues` renders it an overlay. The Terraform module and the chart are not part of a
 * generated project, so a cloud target needs `--infra`, the `infra/` directory of a checkout of
 * this repository.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { DeploymentImages } from '../deployment.ts';
import type { DeploymentProfile } from '../profile.ts';
import { composeProjectName } from '../render/env.ts';
import { helmOverlaySkipReason, renderHelmValues } from '../render/helm-values.ts';
import {
  CLOUDFLARE_CONFIG_FILE,
  CLOUDFLARE_CONTROL_PLANE_CONFIG_FILE,
  CLOUDFLARE_GATEWAY_CONFIG_FILE,
  CLOUDFLARE_MANAGER_CONFIG_FILE,
  renderCloudflareProject,
} from '../render/cloudflare.ts';
import { renderTerraformVariables } from '../render/terraform-vars.ts';
import { renderVercelProject } from '../render/vercel.ts';

/** What `--target` may name; `local` always deploys with Compose. */
export const REQUESTED_TARGETS = ['helm', 'terraform', 'vercel', 'cloudflare'] as const;
export type RequestedTarget = (typeof REQUESTED_TARGETS)[number];

/** The chart's release name and namespace, as `docs/deploy/kubernetes.md` installs it. */
export const HELM_RELEASE = 'agent-workspace';

export type DeployTarget =
  | { readonly kind: 'compose' }
  | {
      readonly kind: 'helm';
      readonly chart: string;
      /** The chart's flavour file for this cloud, beneath the rendered overlay. */
      readonly flavourFile: string;
      /** The operator's own values (`AW_HELM_VALUES`), above the chart's and beneath the overlay. */
      readonly operatorValuesFile?: string;
      readonly overlayFile: string;
    }
  | {
      readonly kind: 'terraform';
      readonly module: string;
      readonly moduleDirectory: string;
      readonly variablesFile: string;
    }
  | {
      readonly kind: 'vercel';
      /** The Vercel project the deployment lives in, named after the project directory. */
      readonly projectName: string;
      /** The rendered `deploy/vercel/vercel.json`. */
      readonly settingsFile: string;
    }
  | {
      readonly kind: 'cloudflare';
      /** The Worker the deployment lives in, named after the project directory. */
      readonly workerName: string;
      /** The rendered `deploy/cloudflare/wrangler.jsonc`. */
      readonly configFile: string;
      /** The control plane Worker, named `<workerName>-control-plane`. */
      readonly controlPlaneWorkerName: string;
      /** The rendered `deploy/cloudflare/control-plane.wrangler.jsonc`. */
      readonly controlPlaneConfigFile: string;
      /** The model gateway Worker, named `<workerName>-gateway`. */
      readonly gatewayWorkerName: string;
      /** The rendered `deploy/cloudflare/gateway.wrangler.jsonc`. */
      readonly gatewayConfigFile: string;
      /** The runner manager Worker, named `<workerName>-manager`. */
      readonly managerWorkerName: string;
      /** The rendered `deploy/cloudflare/manager.wrangler.jsonc`. */
      readonly managerConfigFile: string;
      /** The frontend Worker, named `<workerName>-web`; its configuration is built at deploy. */
      readonly frontendWorkerName: string;
    };

export interface TargetSelection {
  readonly profile: DeploymentProfile;
  readonly images: DeploymentImages;
  readonly requested: RequestedTarget | null;
  readonly projectDirectory: string;
  /** `--infra`, resolved; `null` when it was not given. */
  readonly infraDirectory: string | null;
}

function requireInfra(infraDirectory: string | null, needs: string): string {
  if (infraDirectory !== null) return infraDirectory;
  throw new Error(
    `--infra <dir> is required to deploy this profile: ${needs} is not part of a generated ` +
      'project. Pass the infra/ directory of a claude-agent-workspace checkout. Nothing was run.',
  );
}

/**
 * The target a profile deploys to. Terraform is preferred where the profile has a module (gcp,
 * azure), so the plan an operator reviews is Terraform's; `--target helm` selects the chart. A
 * `--target` the profile has no artefact for is refused by name, never ignored.
 */
export function selectTarget(selection: TargetSelection): DeployTarget {
  const { profile, images, requested, projectDirectory, infraDirectory } = selection;
  if (profile.cloud === 'local') {
    if (requested !== null) {
      throw new Error(
        `--target ${requested} does not apply to cloud "local": a local profile deploys with ` +
          'Docker Compose. Nothing was run.',
      );
    }
    return { kind: 'compose' };
  }

  const vercel = renderVercelProject(profile);
  if (vercel !== null) {
    if (requested !== null && requested !== 'vercel') {
      throw new Error(
        `--target ${requested} does not apply to cloud "vercel": a vercel profile deploys to ` +
          'Vercel. Nothing was run.',
      );
    }
    return {
      kind: 'vercel',
      projectName: composeProjectName(path.basename(projectDirectory)),
      settingsFile: path.join(projectDirectory, 'deploy', vercel.directory, vercel.fileName),
    };
  }
  if (requested === 'vercel') {
    throw new Error(
      `--target vercel does not apply to cloud "${profile.cloud}": it deploys a cloud: vercel ` +
        'profile. Nothing was run.',
    );
  }

  const cloudflare = renderCloudflareProject(profile, images);
  if (cloudflare !== null) {
    if (requested !== null && requested !== 'cloudflare') {
      throw new Error(
        `--target ${requested} does not apply to cloud "cloudflare": a cloudflare profile ` +
          'deploys to Cloudflare. Nothing was run.',
      );
    }
    const workerName = composeProjectName(path.basename(projectDirectory)).replaceAll('_', '-');
    return {
      kind: 'cloudflare',
      workerName,
      configFile: path.join(
        projectDirectory,
        'deploy',
        cloudflare.directory,
        CLOUDFLARE_CONFIG_FILE,
      ),
      controlPlaneWorkerName: `${workerName}-control-plane`,
      controlPlaneConfigFile: path.join(
        projectDirectory,
        'deploy',
        cloudflare.directory,
        CLOUDFLARE_CONTROL_PLANE_CONFIG_FILE,
      ),
      gatewayWorkerName: `${workerName}-gateway`,
      gatewayConfigFile: path.join(
        projectDirectory,
        'deploy',
        cloudflare.directory,
        CLOUDFLARE_GATEWAY_CONFIG_FILE,
      ),
      managerWorkerName: `${workerName}-manager`,
      managerConfigFile: path.join(
        projectDirectory,
        'deploy',
        cloudflare.directory,
        CLOUDFLARE_MANAGER_CONFIG_FILE,
      ),
      frontendWorkerName: `${workerName}-web`,
    };
  }
  if (requested === 'cloudflare') {
    throw new Error(
      `--target cloudflare does not apply to cloud "${profile.cloud}": it deploys a cloud: ` +
        'cloudflare profile. Nothing was run.',
    );
  }

  const terraform = renderTerraformVariables(profile, images);
  const helm = renderHelmValues(profile, images);
  const kind = requested ?? (terraform === null ? 'helm' : 'terraform');

  if (kind === 'terraform') {
    if (terraform === null) {
      throw new Error(
        `Cloud "${profile.cloud}" has no Terraform module; deploy it with the chart ` +
          '(--target helm). Nothing was run.',
      );
    }
    const infra = requireInfra(infraDirectory, `the Terraform module ${terraform.module}`);
    return {
      kind: 'terraform',
      module: terraform.module,
      moduleDirectory: path.join(infra, 'terraform', terraform.module),
      variablesFile: path.join(projectDirectory, 'deploy', 'terraform', terraform.fileName),
    };
  }

  if (helm === null) {
    throw new Error(
      `${helmOverlaySkipReason(profile) ?? `Cloud "${profile.cloud}" has no chart flavour.`} ` +
        'Nothing was run.',
    );
  }
  const infra = requireInfra(infraDirectory, 'the chart infra/helm/agent-workspace');
  const chart = path.join(infra, 'helm', 'agent-workspace');
  return {
    kind: 'helm',
    chart,
    flavourFile: path.join(chart, helm.flavour),
    overlayFile: path.join(projectDirectory, 'deploy', 'helm', 'values.yaml'),
  };
}

async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Refuse a Terraform module that was never initialised. `deploy` does not run `terraform init`
 * itself: that configures a backend, a side effect the operator chooses.
 */
export async function assertModuleInitialised(module: string, directory: string): Promise<void> {
  if (!(await isDirectory(path.join(directory, '.terraform')))) {
    throw new Error(
      `The Terraform module ${module} is not initialised. Run \`terraform -chdir=` +
        `${directory} init\` with your backend configuration, then run agent-workspace deploy ` +
        'again. Nothing was run.',
    );
  }
}

/**
 * Refuse, before any tool runs, a target whose module or chart is not where `--infra` says, or a
 * Terraform module that was never initialised.
 */
export async function assertTargetPresent(target: DeployTarget): Promise<void> {
  if (target.kind === 'compose' || target.kind === 'vercel' || target.kind === 'cloudflare') {
    return;
  }
  const directory = target.kind === 'helm' ? target.chart : target.moduleDirectory;
  if (!(await isDirectory(directory))) {
    throw new Error(
      `${directory} is not a directory. --infra must name the infra/ directory of a ` +
        'claude-agent-workspace checkout. Nothing was run.',
    );
  }
  if (target.kind === 'terraform') await assertModuleInitialised(target.module, directory);
}
