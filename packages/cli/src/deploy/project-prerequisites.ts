import { lookup } from 'node:dns/promises';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { ProductionGcp } from '@indx-workspace/contracts/project-file';

import { cloudRunModuleDirectory, materializeCloudRunModule } from './cloud-run-module.ts';
import { type CloudRunModule, type DeployProjectEnvironmentOptions } from './project-types.ts';
import { isMissingTool, spawnTool, type ToolResult } from './runner.ts';
import { assertModuleInitialised } from './targets.ts';

/** The Node.js major a deploy must run on: the CLI's own `engines` floor. */
const NODE_MAJOR_REQUIRED = 24;

/**
 * Run `tool <args>` through the no-shell `ToolRunner`, refusing by name a tool that is not on
 * PATH (`missing`) or does not answer (`failing`).
 */
export async function assertToolAnswers(
  options: DeployProjectEnvironmentOptions,
  invocation: { readonly tool: 'docker' | 'helm' | 'terraform'; readonly args: readonly string[] },
  missing: string,
  failing: string,
): Promise<void> {
  let result: ToolResult;
  try {
    result = await (options.runner ?? spawnTool)({
      ...invocation,
      cwd: process.cwd(),
      env: options.env ?? process.env,
    });
  } catch (error) {
    if (!isMissingTool(error)) throw error;
    throw new Error(`${missing} Nothing was created.`, { cause: error });
  }
  if (result.status !== 0) throw new Error(`${failing} Nothing was created.`);
}

/**
 * The Owner prerequisites a single-VM deploy needs beyond Node.js, each refused by name before
 * anything is created. The DNS record is demanded only by `--yes`: a plan deploys nothing, so it
 * can run before the record exists.
 */
export async function assertSingleVmPrerequisites(
  options: DeployProjectEnvironmentOptions,
  url: string,
): Promise<void> {
  await assertToolAnswers(
    options,
    { tool: 'docker', args: ['compose', 'version'] },
    'Docker Engine is not installed or not on PATH; the single-vm target runs it. Install ' +
      'Docker Engine and its Compose plugin.',
    '`docker compose version` failed: the Docker Compose plugin is missing or the Docker ' +
      'daemon is not reachable. Install docker-compose-plugin.',
  );
  if (!options.apply) return;
  const { hostname } = new URL(url);
  try {
    await (options.resolveHost ?? lookup)(hostname);
  } catch (error) {
    throw new Error(
      `The url host ${hostname} does not resolve. Add a DNS A record for it pointing at this ` +
        'VM, then re-run with --yes. Nothing was applied.',
      { cause: error },
    );
  }
}

/** The Terraform module the gcp-cloudrun recipe applies, beneath `--infra`. */
const CLOUD_RUN_MODULE = path.join('terraform', 'gcp-cloudrun');
const PROJECT_ID_LINE = /^\s*project_id\s*=/mu;

/**
 * The Owner prerequisites a Cloud Run deploy needs beyond Node.js, each refused by name before a
 * deployment is created: the module (the one this CLI ships unless `--infra` names a checkout's),
 * its `project_id` (which `environments.production.gcp` supplies), Terraform, and an initialised
 * module (which the lifecycle creates for a gcp block without `--infra`). Without `--infra` the shipped module is
 * first written beside the state directory, which is where the Owner's `terraform.tfvars` and
 * `terraform init` belong.
 */
export async function assertCloudRunPrerequisites(
  options: DeployProjectEnvironmentOptions,
  gcp: ProductionGcp | undefined,
): Promise<CloudRunModule> {
  const shipped = options.infraDirectory === undefined;
  const infra = options.infraDirectory ?? (await materializeCloudRunModule(options.stateDirectory));
  const moduleDirectory = shipped
    ? cloudRunModuleDirectory(options.stateDirectory)
    : path.join(infra, CLOUD_RUN_MODULE);
  if (!(await isPresent(path.join(moduleDirectory, 'main.tf')))) {
    throw new Error(
      `${moduleDirectory} holds no Terraform module. --infra must name the infra/ directory of a ` +
        'claude-agent-workspace checkout. Nothing was created.',
    );
  }
  const tfvars = path.join(moduleDirectory, 'terraform.tfvars');
  const declared =
    (await isPresent(tfvars)) && PROJECT_ID_LINE.test(await readFile(tfvars, 'utf8'));
  if (gcp === undefined && !declared && !options.env?.['TF_VAR_project_id']) {
    throw new Error(
      'The gcp-cloudrun module has no project_id: add project_id = "<your GCP project id>" to ' +
        `${tfvars}, or set TF_VAR_project_id. Nothing was deployed.`,
    );
  }
  await assertToolAnswers(
    options,
    { tool: 'terraform', args: ['version'] },
    'Terraform is not installed or not on PATH; the gcp-cloudrun target runs it. Install ' +
      'Terraform 1.8 or later.',
    '`terraform version` failed. Reinstall Terraform 1.8 or later.',
  );
  // With a gcp block and no --infra, the lifecycle initialises the module itself.
  if (gcp === undefined || !shipped) await assertModuleInitialised('gcp-cloudrun', moduleDirectory);
  return { infra, moduleDirectory };
}

/** Every IPv4 address of `hostname`: the load balancer's address is IPv4, and a host can have several. */
export function resolveIpv4(
  hostname: string,
  lookupAddresses: typeof lookup = lookup,
): Promise<unknown> {
  return lookupAddresses(hostname, { all: true, family: 4 });
}

export async function isPresent(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

export function assertNodeVersion(options: DeployProjectEnvironmentOptions): void {
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  if (Number.parseInt(nodeVersion, 10) < NODE_MAJOR_REQUIRED) {
    throw new Error(
      `Node.js ${String(NODE_MAJOR_REQUIRED)} or later is required; this is ${nodeVersion}. ` +
        `Install Node.js ${String(NODE_MAJOR_REQUIRED)}. Nothing was created.`,
    );
  }
}

export function fetchOption(options: DeployProjectEnvironmentOptions): {
  readonly fetch?: typeof fetch;
} {
  return options.fetch === undefined ? {} : { fetch: options.fetch };
}
