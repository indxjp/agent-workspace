import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  ProductionApp,
  ProductionGcp,
  ProjectDocument,
} from '@indx-workspace/contracts/project-file';

import { ProfileError } from '../profile.ts';
import { copyContext } from './cloud-run-images.ts';
import { cloudRunModuleDirectory, materializeCloudRunModule } from './cloud-run-module.ts';
import {
  backendFor,
  backendRecord,
  destroyStack,
  ensureStateBucket,
  initialiseBackend,
  lifecycleStep,
  moduleResourceName,
  readOwnerPassword,
  runPreflight,
  stateBucketName,
  writeProjectVariables,
} from './gcp-lifecycle.ts';
import { isJson } from './gcp-json-fields.ts';
import { gatherStatus, type DeployStatusReport } from './gcp-status.ts';
import { isPresent } from './project-prerequisites.ts';
import { deployedEnvironment, type DeployableEnvironment } from './project-types.ts';
import { spawnTool, type ToolRunner } from './runner.ts';
import type { DeployContext } from './steps.ts';

/** The Google Cloud project and region of `environment`, or the refusal that names how to set them. */
function gcpOf(project: ProjectDocument, environment: DeployableEnvironment): ProductionGcp {
  const deployed = deployedEnvironment(project, environment);
  if (deployed.target !== 'gcp-cloudrun' || deployed.gcp === undefined) {
    throw new ProfileError(
      `environments.${environment}.gcp`,
      'is not defined; this command needs target: gcp-cloudrun and gcp: { project, region }',
    );
  }
  return deployed.gcp;
}

export interface ShowOwnerPasswordOptions {
  readonly project: ProjectDocument;
  readonly environment: DeployableEnvironment;
  readonly stateDirectory: string;
  readonly runner?: ToolRunner;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * `aw deploy production --show-owner-password`: the Owner's generated password, read from the
 * Terraform state with `terraform output -raw`. Returned, never logged: the caller prints it.
 *
 * @throws {ProfileError} when the environment has no gcp block.
 * @throws {Error} when the stack has no password yet.
 */
export async function showOwnerPassword(options: ShowOwnerPasswordOptions): Promise<string> {
  gcpOf(options.project, options.environment);
  const context = {
    ...copyContext(options.runner ?? spawnTool, options.env ?? process.env, process.cwd()),
    out: () => undefined,
  };
  return readOwnerPassword(context, cloudRunModuleDirectory(options.stateDirectory));
}

export interface DestroyProjectEnvironmentOptions extends ShowOwnerPasswordOptions {
  /** Makes the preflight's HTTP request (the global `fetch` when unset); the suite injects a stub. */
  readonly fetch?: typeof fetch;
  /** Asks the Owner `question` and answers the line they typed. */
  readonly confirm: (question: string) => Promise<string>;
}

/** The preflight checks a destroy needs: the tools, the sign-in and the project; not billing or APIs. */
const DESTROY_PREFLIGHT = ['gcloud', 'sign-in', 'gcloud-account', 'project', 'terraform'] as const;

/** What the limited prelude of a stack command says when there is no stack to work on. */
interface NothingDeployed {
  readonly rerun: string;
  readonly noVariables: string;
  readonly noBackend: string;
  readonly noBucket: (bucket: string) => string;
}

/** A stack command's ground: the context, the Terraform module and the variables file it was run with. */
interface InitialisedStack {
  readonly gcp: ProductionGcp;
  readonly context: DeployContext;
  readonly moduleDirectory: string;
  readonly variablesFile: string;
}

/** `value` when it is a non-empty string. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The apps `aw deploy` last wrote to the module's variables, whose images are the Artifact Registry
 * copies. Status and destroy copy nothing, so they keep these rather than drop the apps from the
 * file and plan against a stack without them.
 */
async function recordedApps(moduleDirectory: string): Promise<Record<string, ProductionApp>> {
  const file = path.join(moduleDirectory, 'terraform.tfvars.json');
  if (!(await isPresent(file))) return {};
  const variables: unknown = JSON.parse(await readFile(file, 'utf8'));
  const apps = isJson(variables) && isJson(variables['apps']) ? variables['apps'] : {};
  return Object.fromEntries(
    Object.entries(apps).flatMap(([name, app]) => {
      const image = isJson(app) ? text(app['image']) : undefined;
      const url = isJson(app) ? text(app['url']) : undefined;
      return image === undefined || url === undefined ? [] : [[name, { image, url }]];
    }),
  );
}

/**
 * What `aw deploy destroy production` and `aw deploy status production` share: find the variables
 * file `aw deploy` wrote, run the limited preflight, materialise the module, check the stack used
 * the managed state, rewrite the variables, check the state bucket exists and initialise Terraform.
 * Nothing is created.
 *
 * @throws {Error} with the `refusals` text when there is no stack to work on.
 */
async function initialiseExistingStack(
  options: ShowOwnerPasswordOptions & { readonly fetch?: typeof fetch },
  refusals: NothingDeployed,
): Promise<InitialisedStack> {
  const { project, environment, stateDirectory } = options;
  const gcp = gcpOf(project, environment);
  const env = options.env ?? process.env;
  const context = copyContext(options.runner ?? spawnTool, env, process.cwd());
  const { rerun } = refusals;
  const variablesFile = path.join(
    stateDirectory,
    'deploy',
    'terraform',
    'gcp-cloudrun.auto.tfvars.json',
  );
  if (!(await isPresent(variablesFile))) throw new Error(refusals.noVariables);
  await lifecycleStep(
    context,
    'Check the Google Cloud project',
    (step) =>
      runPreflight(step, gcp, false, {
        only: DESTROY_PREFLIGHT,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
    { rerun },
  );
  await materializeCloudRunModule(stateDirectory);
  const moduleDirectory = cloudRunModuleDirectory(stateDirectory);
  if (!(await isPresent(backendRecord(moduleDirectory)))) throw new Error(refusals.noBackend);
  await writeProjectVariables(
    moduleDirectory,
    gcp,
    moduleResourceName(project.name),
    env,
    await recordedApps(moduleDirectory),
  );
  const bucket = await lifecycleStep(
    context,
    'Check the Terraform state bucket',
    (step) => ensureStateBucket(step, gcp, false),
    { rerun },
  );
  if (bucket === 'missing') throw new Error(refusals.noBucket(stateBucketName(gcp)));
  await lifecycleStep(
    context,
    'Initialise Terraform',
    (step) => initialiseBackend(step, moduleDirectory, backendFor(gcp, project.name)),
    { rerun },
  );
  return { gcp, context, moduleDirectory, variablesFile };
}

/**
 * `aw deploy destroy production`: plan the destruction of the stack `aw deploy` made, print what
 * it would delete, and apply that plan only after the Owner types the Google Cloud project id. The
 * state bucket and the local state directory are left in place.
 *
 * @throws {ProfileError} when the environment has no gcp block.
 * @throws {Error} when nothing was deployed from this machine, the typed id differs, or Terraform
 * refuses (Cloud SQL data protection included).
 */
export async function destroyProjectEnvironment(
  options: DestroyProjectEnvironmentOptions,
): Promise<void> {
  const { gcp, context, moduleDirectory, variablesFile } = await initialiseExistingStack(options, {
    rerun: 'aw deploy destroy production',
    noVariables:
      'Nothing was deployed from this machine, so there is nothing to destroy. Deploy it first ' +
      'with `aw deploy production`. Nothing was destroyed.',
    noBackend:
      'Nothing was deployed here by `aw deploy production`, so there is nothing to destroy. ' +
      'A stack deployed with --infra lives in that checkout: destroy it there. Nothing was destroyed.',
    noBucket: (bucket) =>
      `The state bucket gs://${bucket} does not exist, so there is nothing to ` +
      'destroy. Nothing was destroyed.',
  });
  await destroyStack(context, {
    moduleDirectory,
    variablesFile,
    project: gcp.project,
    confirm: options.confirm,
  });
}

export interface DeployStatusOptions extends ShowOwnerPasswordOptions {
  /** Makes the preflight's HTTP request (the global `fetch` when unset); the suite injects a stub. */
  readonly fetch?: typeof fetch;
}

/**
 * `aw deploy status production`: the versions, revision health, data protection and drift of the
 * stack `aw deploy` made. Read-only: it plans without locking the state and never applies.
 *
 * @throws {ProfileError} when the environment has no gcp block.
 * @throws {Error} when nothing was deployed from this machine, or a tool refuses.
 */
export async function deployStatus(options: DeployStatusOptions): Promise<DeployStatusReport> {
  const nothing = (why: string): string =>
    `Nothing was deployed from this machine, ${why}. Deploy it first with \`aw deploy production\`.`;
  const { gcp, context, moduleDirectory, variablesFile } = await initialiseExistingStack(options, {
    rerun: 'aw deploy status production',
    noVariables: nothing('so there is no status to report'),
    noBackend: nothing(
      'or the stack was deployed with --infra from that checkout, so there is no status to report',
    ),
    noBucket: (bucket) =>
      `The state bucket gs://${bucket} does not exist, so there is no status to report. Deploy it first with \`aw deploy production\`.`,
  });
  return gatherStatus(context, {
    moduleDirectory,
    variablesFile,
    gcp,
    name: moduleResourceName(options.project.name),
  });
}
