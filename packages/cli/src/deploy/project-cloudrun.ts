import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ProductionEnvironment, ProductionGcp } from '@indx-workspace/contracts/project-file';

import { parseEnvironment, type DeploymentImages } from '../deployment.ts';
import { type DeploymentProfile } from '../profile.ts';
import { copyContext } from './cloud-run-images.ts';
import { cloudRunModuleDirectory } from './cloud-run-module.ts';
import {
  assertNoConflictingVariables,
  deployRerunCommand,
  legacyVariablesNotice,
  lifecycleStep,
  readTerraformOutput,
  runPreflight,
} from './gcp-lifecycle.ts';
import { cloudRunImages, withCopiedApps, withCopiedImages } from './project-cloudrun-images.ts';
import { deployGcpStack, type GcpStackState } from './project-gcp-stack.ts';
import { assertCloudRunPrerequisites, fetchOption, resolveIpv4 } from './project-prerequisites.ts';
import { type DeployProjectEnvironmentOptions } from './project-types.ts';
import { spawnTool } from './runner.ts';
import type { DeployContext, DeployOutcome } from './steps.ts';

/** What `prepareCloudRun` hands back: a finished run, or what `agent-workspace deploy` still needs. */
type CloudRunPreparation =
  | { readonly done: GcpStackState }
  | {
      readonly done: null;
      readonly infra: string;
      readonly moduleDirectory: string;
      readonly images: DeploymentImages;
      readonly toolEnvironment: NodeJS.ProcessEnv;
    };

/**
 * The gcp-cloudrun target up to `agent-workspace deploy`: the Google Cloud preflight, the module's
 * prerequisites, then either the whole managed lifecycle (`gcp` without `--infra`: `done`) or the
 * image copy that precedes the shared plan and apply (a hand-written `terraform.tfvars`, or a
 * checkout named by `--infra`, whose module is never written to).
 */
export async function prepareCloudRun(
  options: DeployProjectEnvironmentOptions,
  deployed: ProductionEnvironment,
  profile: DeploymentProfile,
  created: boolean,
): Promise<CloudRunPreparation> {
  const { stateDirectory } = options;
  const gcp = deployed.gcp;
  const adminEmail = profile.identity.bootstrapAdmin;
  const envFile = path.join(stateDirectory, '.env');
  const base = copyContext(options.runner ?? spawnTool, options.env ?? process.env, process.cwd());
  await checkCloudRunProject(options, base, gcp);
  const cloudRunModule = await assertCloudRunPrerequisites(options, gcp);
  const { infra, moduleDirectory } = cloudRunModule;
  if (gcp !== undefined && options.infraDirectory === undefined) {
    const deployment = { options, deployed, gcp, profile, cloudRunModule, created, base };
    return { done: await deployGcpStack(deployment) };
  }
  if (gcp === undefined && options.infraDirectory === undefined) base.out(legacyVariablesNotice());
  // A checkout's module is never written to: the gcp block reaches it as Terraform variables, which
  // rank below its own tfvars files, so a file that names another project or region is refused.
  if (gcp !== undefined) await assertNoConflictingVariables(moduleDirectory, gcp);
  const pins = created ? null : parseEnvironment(await readFile(envFile, 'utf8'));
  const images = await cloudRunImages(options, {
    cloudRunModule,
    pins,
    ownerEmail: adminEmail,
    context: base,
    sandboxInternet: gcp?.sandboxInternet === true,
    apps: deployed.apps ?? {},
  });
  if (images === null) {
    return {
      done: {
        changes: true,
        applied: false,
        created: false,
        adminEmail,
        envFile,
        moduleDirectory,
        webUrl: null,
        loadBalancerIp: null,
      },
    };
  }
  return {
    done: null,
    infra,
    moduleDirectory,
    images,
    toolEnvironment: withCopiedApps(
      withCopiedImages(checkoutEnvironment(options, gcp), images),
      deployed,
      images,
    ),
  };
}

/** `terraform output -raw web_url` once a gcp-cloudrun run has left a stack to read it from. */
export function stackWebUrl(
  options: DeployProjectEnvironmentOptions,
  environment: NodeJS.ProcessEnv | undefined,
  moduleDirectory: string,
  outcome: DeployOutcome,
): Promise<string | null> {
  if (!outcome.applied && outcome.changes) return Promise.resolve(null);
  const quiet = {
    ...copyContext(options.runner ?? spawnTool, environment ?? process.env, process.cwd()),
    out: () => undefined,
  };
  return readTerraformOutput(quiet, moduleDirectory, 'web_url');
}

async function checkCloudRunProject(
  options: DeployProjectEnvironmentOptions,
  base: DeployContext,
  gcp: ProductionGcp | undefined,
): Promise<void> {
  const { apply, stateDirectory } = options;
  if (gcp !== undefined) {
    await lifecycleStep(
      base,
      'Check the Google Cloud project',
      (context) =>
        runPreflight(context, gcp, apply, {
          ...fetchOption(options),
          ...(gcp.domain === undefined
            ? {}
            : {
                resolveHost: options.resolveHost ?? resolveIpv4,
                loadBalancerIp: () =>
                  readTerraformOutput(
                    { ...context, out: () => undefined },
                    cloudRunModuleDirectory(stateDirectory),
                    'load_balancer_ip',
                  ),
              }),
        }),
      { rerun: deployRerunCommand(apply), quoteError: true },
    );
  }
}

function checkoutEnvironment(
  options: DeployProjectEnvironmentOptions,
  gcp: ProductionGcp | undefined,
): NodeJS.ProcessEnv | undefined {
  return gcp === undefined
    ? options.env
    : {
        ...(options.env ?? process.env),
        TF_VAR_project_id: gcp.project,
        TF_VAR_region: gcp.region,
        TF_VAR_vertex_location: gcp.modelLocation ?? 'global',
        TF_VAR_sandbox_internet: String(gcp.sandboxInternet === true),
      };
}
