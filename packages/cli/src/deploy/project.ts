/**
 * The bridge from a v2 project file to the v1 deployment profile `deploy` already drives
 * (issue #621, ADR-0103's amendment).
 *
 * A v2 environment names only a deploy recipe (`target`) and the URL it is served at; the
 * profile — where its database, objects, secrets and sandboxes live — follows from the recipe,
 * through the same per-cloud defaults `create-agent-workspace --cloud` writes. The profile is
 * internal: a customer edits `agent-workspace.yaml` and never sees it.
 */
import path from 'node:path';

import type { VertexLocation } from '@indx-workspace/contracts/models';
import type {
  ProductionEnvironment,
  ProjectDocument,
} from '@indx-workspace/contracts/project-file';

import { resolveDeploymentImages, type DeploymentImages } from '../deployment.ts';
import { validateProfile, type DeploymentProfile } from '../profile.ts';
import { runDeployCommand } from './command.ts';
import { prepareCloudRun, stackWebUrl } from './project-cloudrun.ts';
import type { GcpStackState } from './project-gcp-stack.ts';
import { deployToKubernetes } from './project-kubernetes.ts';
import {
  assertNodeVersion,
  assertSingleVmPrerequisites,
  isPresent,
} from './project-prerequisites.ts';
import { claimState, syncDeploymentState } from './project-state.ts';
import {
  deployedEnvironment,
  type DeployableEnvironment,
  type DeployedState,
  type DeployProjectEnvironmentOptions,
  type ProjectDeployOutcome,
} from './project-types.ts';
import { DEPLOY_RECIPES } from './recipes.ts';
export { composeProjectName } from '../render/env.ts';
export { COMPOSE_APPS_FILE, COMPOSE_FILE_WITH_APPS, renderComposeApps } from './compose-apps.ts';
export type { DeployStatusReport } from './gcp-status.ts';
export { resolveIpv4 } from './project-prerequisites.ts';
export {
  deployStatus,
  destroyProjectEnvironment,
  showOwnerPassword,
} from './project-stack-commands.ts';
export type {
  DeployStatusOptions,
  DestroyProjectEnvironmentOptions,
  ShowOwnerPasswordOptions,
} from './project-stack-commands.ts';
export type {
  DeployableEnvironment,
  DeployProjectEnvironmentOptions,
  ProjectDeployOutcome,
} from './project-types.ts';

/**
 * The v1 profile `environment` of `project` deploys as. Pure: it reads nothing and writes nothing.
 * The bootstrap Owner is the `local` environment's, because `production` carries only `target`
 * and `url`.
 *
 * @throws {ProfileError} when the project has no such environment, or the derived profile fails
 * the CLI's profile schema.
 */
export function projectToDeploymentProfile(
  project: ProjectDocument,
  environment: DeployableEnvironment,
): DeploymentProfile {
  const recipe = DEPLOY_RECIPES[deployedEnvironment(project, environment).target];
  recipe.checkProject(project);
  return validateProfile({
    ...recipe.profile(project.name),
    identity: project.environments.local.identity,
  });
}

/**
 * `aw deploy <env>`: bridge the environment to its v1 profile, keep the internal deployment at
 * `stateDirectory` in step with it, and run `agent-workspace deploy` over it in-process. Plans
 * unless `apply`.
 *
 * @throws {ProfileError} when the environment is missing or its profile is refused.
 * @throws {Error} naming the missing Owner prerequisite, or the deploy step that failed.
 */
export async function deployProjectEnvironment(
  options: DeployProjectEnvironmentOptions,
): Promise<ProjectDeployOutcome> {
  const { project, environment, apply, stateDirectory } = options;
  const deployed = deployedEnvironment(project, environment);
  const recipe = DEPLOY_RECIPES[deployed.target];
  // Refused before the state is claimed; the kubernetes target builds no v1 profile to refuse it.
  recipe.checkProject(project);
  if (options.projectDirectory !== undefined) {
    await claimState(stateDirectory, options.projectDirectory);
  }
  if (deployed.target === 'kubernetes') {
    assertNodeVersion(options);
    return finishProjectDeploy(options, deployed, await deployToKubernetes(options, deployed));
  }
  const profile = projectToDeploymentProfile(project, environment);
  assertNodeVersion(options);
  const envFile = path.join(stateDirectory, '.env');
  const created = !(await isPresent(stateDirectory));
  const adminEmail = profile.identity.bootstrapAdmin;
  const prepared = await prepareProjectTarget(options, deployed, profile, created);
  if (prepared.done !== null) {
    const { webUrl, loadBalancerIp, seededLocation, appUrls, ...state } = prepared.done;
    return finishProjectDeploy(options, deployed, state, {
      webUrl,
      loadBalancerIp,
      seededLocation: seededLocation ?? null,
      ...(appUrls === undefined ? {} : { appUrls }),
    });
  }
  const { infra, moduleDirectory, toolEnvironment, images, frontend } = prepared;

  await syncDeploymentState(options, deployed, profile, {
    created,
    images: () => images ?? options.images ?? resolveDeploymentImages(profile.cloud, options.env),
  });

  const outcome = await runDeployCommand(
    [stateDirectory, ...(apply ? ['--yes'] : []), ...(infra === null ? [] : ['--infra', infra])],
    {
      ...(options.runner === undefined ? {} : { runner: options.runner }),
      ...(toolEnvironment === undefined ? {} : { environment: toolEnvironment }),
    },
  );
  const state = { ...outcome, created, adminEmail, envFile, moduleDirectory };
  const webUrl =
    deployed.target === 'gcp-cloudrun' && moduleDirectory !== null
      ? await stackWebUrl(options, toolEnvironment, moduleDirectory, outcome)
      : null;
  return finishProjectDeploy(options, deployed, state, { frontend, webUrl });
}

interface DeploymentNextSteps {
  readonly frontend?: boolean;
  readonly webUrl?: string | null;
  readonly loadBalancerIp?: string | null;
  readonly seededLocation?: VertexLocation | null;
  readonly appUrls?: Readonly<Record<string, string>>;
}

function finishProjectDeploy(
  options: DeployProjectEnvironmentOptions,
  deployed: ProductionEnvironment,
  state: DeployedState,
  details: DeploymentNextSteps = {},
): ProjectDeployOutcome {
  return {
    ...state,
    nextSteps: DEPLOY_RECIPES[deployed.target].nextSteps({
      projectName: options.project.name,
      url: deployed.url,
      adminEmail: state.adminEmail,
      envFile: state.envFile,
      moduleDirectory: state.moduleDirectory,
      managedStack: deployed.gcp !== undefined && options.infraDirectory === undefined,
      webUrl: details.webUrl ?? null,
      oidcIssuer: deployed.gcp?.oidc?.issuer ?? null,
      domain: deployed.gcp?.domain ?? null,
      loadBalancerIp: details.loadBalancerIp ?? null,
      seededLocation: details.seededLocation ?? null,
      frontend: details.frontend ?? false,
      apps: deployed.apps ?? {},
      appUrls: details.appUrls ?? {},
    }),
  };
}

type ProjectPreparation =
  | { readonly done: GcpStackState }
  | {
      readonly done: null;
      readonly infra: string | null;
      readonly moduleDirectory: string | null;
      readonly images: DeploymentImages | null;
      readonly frontend: boolean;
      readonly toolEnvironment: NodeJS.ProcessEnv | undefined;
    };

async function prepareProjectTarget(
  options: DeployProjectEnvironmentOptions,
  deployed: ProductionEnvironment,
  profile: DeploymentProfile,
  created: boolean,
): Promise<ProjectPreparation> {
  const recipe = DEPLOY_RECIPES[deployed.target];
  if (recipe.infraRefusal !== null && options.infraDirectory !== undefined) {
    throw new Error(recipe.infraRefusal);
  }
  const basic = {
    done: null,
    infra: null,
    moduleDirectory: null,
    images: null,
    frontend: false,
    toolEnvironment: options.env,
  };
  if (deployed.target === 'single-vm') {
    await assertSingleVmPrerequisites(options, deployed.url);
    return basic;
  }
  if (deployed.target !== 'vercel') {
    const prepared = await prepareCloudRun(options, deployed, profile, created);
    return prepared.done !== null ? prepared : { ...prepared, frontend: false };
  }
  // The control plane's own URL is the project file's `url`; the Vercel target reads it here.
  const frontend =
    options.projectDirectory === undefined ? null : path.join(options.projectDirectory, 'web');
  const hasFrontend = frontend !== null && (await isPresent(path.join(frontend, 'package.json')));
  return {
    ...basic,
    frontend: hasFrontend,
    toolEnvironment: {
      ...(options.env ?? process.env),
      CONTROL_PLANE_URL: deployed.url,
      AGENT_WORKSPACE_PROJECT_NAME: options.project.name,
      ...(frontend !== null && hasFrontend ? { AGENT_WORKSPACE_FRONTEND: frontend } : {}),
    },
  };
}
