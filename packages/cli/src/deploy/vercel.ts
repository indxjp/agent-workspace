import { statSync } from 'node:fs';
import path from 'node:path';
import { ENV_IMAGE_KEYS } from '../render/env.ts';
import { type DeployContext, type DeployOutcome, runStep } from './steps.ts';
import { allowFrontendOrigin, assertPartsStageable, deployPart } from './vercel-deployment.ts';
import {
  MIGRATE_AND_SEED,
  MIGRATION_VARIABLES,
  assertE2bTemplatePinned,
  assertObjectStorageConfigured,
  assertVercelSandboxImagePinned,
  selected,
  withoutIgnoredStorageSettings,
} from './vercel-environment.ts';
import type { Part } from './vercel-parts.ts';
import { type VercelTarget, partsOf } from './vercel-parts.ts';
import { frontendNote, planOffline, rootDirectoryNote } from './vercel-plan.ts';
import { type PartState, configurePart, inspectPart } from './vercel-projects.ts';
import {
  VERCEL_TEAM_ID_VARIABLE,
  VERCEL_TOKEN_VARIABLE,
  namedTarget,
  requiredEnvironment,
} from './vercel-settings.ts';
import { VERCEL_SOURCE_VARIABLE, assertOneRelease } from './vercel-source.ts';

function deploymentSource(
  context: DeployContext,
  dotEnv: Readonly<Record<string, string>>,
  apply: boolean,
): string | null {
  if (!apply) return null;
  const source = path.resolve(
    context.directory,
    requiredEnvironment(context.env, VERCEL_SOURCE_VARIABLE, 'the platform checkout to deploy'),
  );
  if (
    source !== null &&
    statSync(path.join(source, 'apps', 'web'), { throwIfNoEntry: false })?.isDirectory() !== true
  ) {
    throw new Error(
      `${VERCEL_SOURCE_VARIABLE} is ${source}, which has no apps/web directory: point it at a ` +
        'platform checkout. Nothing was run.',
    );
  }
  if (source !== null) assertOneRelease(source, dotEnv);
  return source;
}

function migrationSettings(
  dotEnv: Readonly<Record<string, string>>,
  target: VercelTarget,
  apply: boolean,
) {
  const migration = Object.fromEntries(selected(dotEnv, MIGRATION_VARIABLES));
  const webImage = dotEnv[ENV_IMAGE_KEYS.web]?.trim() ?? '';
  if (apply) {
    assertE2bTemplatePinned(dotEnv);
    assertVercelSandboxImagePinned(dotEnv, target.projectName);
    for (const [name, value] of [
      [ENV_IMAGE_KEYS.web, webImage],
      ['DATABASE_URL', migration['DATABASE_URL'] ?? ''],
      ['BOOTSTRAP_ADMIN', migration['BOOTSTRAP_ADMIN'] ?? ''],
    ] as const) {
      if (value === '') {
        throw new Error(
          `${name} is empty in .env: the migration step needs it` +
            (name === 'DATABASE_URL'
              ? ' (a Neon integration sets DATABASE_URL on Vercel, not in this file)'
              : '') +
            '. Set it and run again. Nothing was run.',
        );
      }
    }
    assertObjectStorageConfigured(dotEnv);
  }

  return { migration, webImage };
}

interface VercelApply {
  readonly context: DeployContext;
  readonly parts: readonly Part[];
  readonly states: readonly PartState[];
  readonly team: string;
  readonly source: string;
  readonly migration: Record<string, string>;
  readonly webImage: string;
}

async function applyDeployment(input: VercelApply): Promise<void> {
  const { context, parts, states, team, migration, webImage } = input;
  for (const [index, part] of parts.entries()) {
    await configurePart(context, part, team, states[index] ?? { exists: true, missing: [] });
  }
  await runStep(
    context,
    'docker',
    [
      'run',
      '--rm',
      ...Object.keys(migration).flatMap((name) => ['-e', name]),
      webImage,
      'sh',
      '-c',
      MIGRATE_AND_SEED,
    ],
    { show: true, env: migration },
  );
  await deployProjects(input);
}

async function deployProjects({ context, parts, source, team }: VercelApply): Promise<void> {
  // The gateway and the manager are up before the control plane that calls them, and the frontend
  // before it too: its origin is written to the control plane before that is deployed.
  const controlPlane = parts.find((candidate) => candidate.label === 'control plane');
  for (const label of ['gateway', 'manager', 'frontend', 'control plane'] as const) {
    const part = parts.find((candidate) => candidate.label === label);
    if (part === undefined) continue;
    const deployed = await deployPart(context, part, source, team);
    if (label === 'frontend' && controlPlane !== undefined) {
      await allowFrontendOrigin(context, { frontend: part, controlPlane, team, deployed });
    }
  }
}

export async function deployWithVercel(
  context: DeployContext,
  selected: VercelTarget,
  projectEnv: Readonly<Record<string, string>>,
  apply: boolean,
): Promise<DeployOutcome> {
  const target = namedTarget(context, selected);
  const dotEnv = withoutIgnoredStorageSettings(context, projectEnv);
  const unset = [VERCEL_TOKEN_VARIABLE, VERCEL_TEAM_ID_VARIABLE].filter(
    (name) => (context.env[name]?.trim() ?? '') === '',
  );
  if (!apply && unset.length > 0) return planOffline(context, target, dotEnv, unset);
  requiredEnvironment(context.env, VERCEL_TOKEN_VARIABLE, 'the Vercel token');
  const team = requiredEnvironment(context.env, VERCEL_TEAM_ID_VARIABLE, 'the Vercel team id');

  const source = deploymentSource(context, dotEnv, apply);
  const { migration, webImage } = migrationSettings(dotEnv, target, apply);

  const { parts, addresses } = partsOf(context, target, team, dotEnv);
  await assertPartsStageable(source, parts);
  const states: PartState[] = [];
  for (const part of parts) states.push(await inspectPart(context, part, team));
  context.out(rootDirectoryNote(parts));
  context.out(
    `The control plane reaches the gateway at ${addresses.get('MODEL_GATEWAY_URL') ?? ''} and ` +
      `the runner manager at ${addresses.get('RUNNER_MANAGER_URL') ?? ''} (set MODEL_GATEWAY_URL ` +
      'or RUNNER_MANAGER_URL in .env for a custom domain). Applying also runs the database ' +
      'migrations once, then `vercel deploy --prod` for each project: every apply creates a ' +
      `deployment of each.${frontendNote(parts)}\n`,
  );

  if (!apply || source === null) return { changes: true, applied: false };

  await applyDeployment({ context, parts, states, team, source, migration, webImage });
  return { changes: true, applied: true };
}

export { NOT_PROJECT_VARIABLES } from './vercel-environment.ts';

export { MANAGER_VARIABLES } from './vercel-environment.ts';

export { assertE2bTemplatePinned } from './vercel-environment.ts';

export { toolHostVariables } from './vercel-environment.ts';

export { gatewayVariables } from './vercel-environment.ts';

export { managerEnvironment } from './vercel-environment.ts';

export { MIGRATION_VARIABLES } from './vercel-environment.ts';

export { MIGRATE_AND_SEED } from './vercel-environment.ts';

export { awsCredentials } from './vercel-environment.ts';

export { selected } from './vercel-environment.ts';

export { withoutIgnoredStorageSettings } from './vercel-environment.ts';

export type { StorageTarget } from './vercel-environment.ts';

export { storageTarget } from './vercel-environment.ts';

export { FRONTEND_BASE_URL_VARIABLE } from './vercel-parts.ts';

export { addressOf } from './vercel-parts.ts';

export { frontendDirectory } from './vercel-parts.ts';

export { VERCEL_TOKEN_VARIABLE } from './vercel-settings.ts';

export { FRONTEND_ORIGIN_VARIABLE } from './vercel-settings.ts';
