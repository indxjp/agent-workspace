import type {
  LauncherProject,
  LauncherServices,
  LauncherStartupContext,
  LauncherStep,
} from './launcher-contract.js';

import { type LocalRuntimeStartMessage } from '@indx-workspace/contracts/local-runtime';

import {
  type LauncherDatabaseRoot,
  type LauncherRuntimeProfileOutcome,
  type LocalLauncherDeps,
} from './launcher-contract.js';
import { isInterruption } from './launcher-lifecycle.js';
import {
  refuseDockerSessionOffDocker,
  runtimeProfileConflictWarning,
  runtimeProfileUnenforceableWarning,
} from './launcher-setup.js';
import type { LocalRuntimeProfileDriver } from './local-runtime-profile.js';
import { LocalLauncherError, sendChildMessage } from './runtime-messages.js';

/** The workspace slug the seed uses when `WORKSPACE_SLUG` is unset or blank. */
const DEFAULT_WORKSPACE_SLUG = 'default';

/**
 * ADR-0161 amendment DI8: link the development issuer's `(issuer, ownerSubject)` to the bootstrap
 * Owner, so an app's token exchange finds them before anyone signed in to the console. Only when
 * `start` carries `devIssuer`, in the local posture.
 */
async function linkDevIssuerOwner<Directory, Root extends LauncherDatabaseRoot<Directory>>(
  deps: LocalLauncherDeps<Directory, Root>,
  database: Root,
  start: LocalRuntimeStartMessage,
  userId: string,
): Promise<void> {
  const { devIssuer } = start.environment;
  if (devIssuer === undefined || deps.env['AW_DEPLOYMENT_POSTURE'] !== 'local') return;
  await deps.linkIdentity(database, {
    issuer: devIssuer.issuer,
    subject: devIssuer.ownerSubject,
    userId,
  });
}

async function prepareLauncherProfile<
  Directory,
  Root extends LauncherDatabaseRoot<Directory>,
>(context: {
  readonly deps: LocalLauncherDeps<Directory, Root>;
  readonly database: Root;
  readonly workspaceId: string;
  readonly sandbox: LocalRuntimeProfileDriver;
  readonly step: LauncherStep;
}): Promise<void> {
  const { deps, database, workspaceId, sandbox, step } = context;
  let profile: LauncherRuntimeProfileOutcome;
  try {
    profile = await step(deps.prepareLocalRuntimeProfile(workspaceId, database, sandbox));
  } catch (error) {
    if (isInterruption(error)) throw error;
    throw new LocalLauncherError('runtime_profile_not_prepared', { cause: error });
  }
  refuseDockerSessionOffDocker(sandbox, profile);
  if (profile.kind === 'name-conflict') {
    deps.stderr(runtimeProfileConflictWarning(profile.name));
  } else if (profile.kind === 'unenforceable') {
    deps.stderr(runtimeProfileUnenforceableWarning(profile.name, profile.settings));
  }
}

export async function authorizeLauncherWorkspace<
  Directory,
  Root extends LauncherDatabaseRoot<Directory>,
>(
  context: LauncherStartupContext<Directory, Root>,
  project: LauncherProject,
  services: LauncherServices<Directory, Root>,
) {
  const { deps, step } = context;
  const { state } = context.lifecycle;
  const { start } = project;
  const { workspace, database, sandbox } = services;
  const workspaceSlug = deps.env['WORKSPACE_SLUG']?.trim() || DEFAULT_WORKSPACE_SLUG;
  const email = (deps.env['BOOTSTRAP_ADMIN'] ?? start.environment.bootstrapAdmin).toLowerCase();
  const membership = await step(database.resolveMembership(email, workspaceSlug));
  if (
    membership?.workspaceId !== workspace.seed.workspaceId ||
    membership.userId !== workspace.seed.adminUserId
  ) {
    throw new LocalLauncherError('workspace_mismatch');
  }
  await step(linkDevIssuerOwner(deps, database, start, workspace.seed.adminUserId));

  await prepareLauncherProfile({
    deps,
    database,
    workspaceId: workspace.seed.workspaceId,
    sandbox,
    step,
  });

  const issued = await step(
    deps
      .issueLocalCredential(
        { workspaceId: workspace.seed.workspaceId, userId: workspace.seed.adminUserId },
        { directory: database.directory },
      )
      .then((value) => {
        state.credential = value;
        return value;
      }),
  );
  await step(
    sendChildMessage(deps.channel, {
      type: 'credential',
      token: issued.token,
      expiresAt: issued.expiresAt.toISOString(),
      workspaceId: workspace.seed.workspaceId,
      workspaceSlug,
    }),
  );
  return { email };
}
