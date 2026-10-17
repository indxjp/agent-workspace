import path from 'node:path';

import { PROJECT_DEPLOY_TARGETS } from '@indx-workspace/contracts/project-file';
import { PROJECT_FILE_NAME } from '@indx-workspace/sdk/project';

import { loadDeploySteps } from '../cli-bridge.js';
import { command, isOn, type LocalCommand, type LocalCommandContext } from '../command.js';
import { ChangesPendingError, CommandRefusedError, UsageError } from '../io.js';
import { readLocalProject } from '../local-runtime/project.js';

/**
 * Issue #621, ADR-0103: deploy the project's `production` environment through
 * `agent-workspace deploy`. The environment's v1 deployment is internal state under
 * `~/.config/agent-workspace/deployments/<project>/<env>`; the project file is all a customer
 * edits. Without `--yes` it only plans, and a plan with changes exits 3.
 */
async function runDeploy(context: LocalCommandContext): Promise<void> {
  const { io, cwd, positionals } = context;
  const [environment, ...extra] = positionals;
  if (environment === undefined) throw new UsageError('missing <environment>');
  if (extra.length > 0) throw new UsageError(`unexpected argument ${JSON.stringify(extra[0])}`);
  if (environment === 'local') {
    throw new CommandRefusedError('the local environment is not deployed', 'aw dev');
  }
  if (environment !== 'production') {
    throw new UsageError(`<environment> must be production; got ${JSON.stringify(environment)}`);
  }
  const apply = isOn(context, 'yes');
  if (apply && isOn(context, 'plan')) throw new UsageError('--plan and --yes contradict');

  const read = cwd === undefined ? null : await readLocalProject(cwd);
  if (read === null) {
    throw new CommandRefusedError(`no ${PROJECT_FILE_NAME} in this directory`, 'aw init --yes');
  }
  if (read.lifted) {
    throw new CommandRefusedError(
      `${PROJECT_FILE_NAME} is a v1 deployment profile; aw deploy takes a kind: Project file`,
      'agent-workspace deploy',
    );
  }
  const { project } = read;
  const deployed = project.environments[environment];
  if (deployed === undefined) {
    throw new CommandRefusedError(
      `${PROJECT_FILE_NAME} has no environments.${environment}`,
      `add ${environment}: { target: ${PROJECT_DEPLOY_TARGETS.join(' | ')}, url: https://<host> } under environments`,
    );
  }
  const stateDirectory = path.join(
    io.homeDir,
    '.config',
    'agent-workspace',
    'deployments',
    project.name,
    environment,
  );

  const infra = context.args.values.get('infra');
  if (infra?.trim() === '') throw new UsageError('--infra must not be empty');
  const infraDirectory = infra === undefined ? undefined : path.resolve(cwd ?? '', infra);

  const steps = await loadDeploySteps();
  let outcome;
  try {
    outcome = await steps.deployProjectEnvironment({
      project,
      environment,
      apply,
      stateDirectory,
      ...(cwd === undefined ? {} : { projectDirectory: cwd }),
      ...(infraDirectory === undefined ? {} : { infraDirectory }),
      env: { ...io.env },
    });
  } catch (error) {
    if (error instanceof Error) throw new CommandRefusedError(error.message);
    throw error;
  }
  if (outcome.changes && !outcome.applied) {
    // `--yes` stops before applying only after copying Cloud Run images, so a plan is shown first.
    throw new ChangesPendingError(
      apply
        ? 'nothing was applied; run --plan to review the changes, then --yes'
        : 'changes are pending; re-run with --yes to apply them',
    );
  }
  io.stdout(
    [`deployed ${environment} from ${stateDirectory}`, ...outcome.nextSteps, ''].join('\n'),
  );
}

export const deployCommands: readonly LocalCommand[] = [
  command(
    'deploy',
    '<environment> [--plan | --yes] [--infra <dir>]',
    "Deploy the project's production environment through agent-workspace deploy; plans unless --yes; --infra names a checkout's infra/ whose gcp-cloudrun module or kubernetes chart is used instead of the one shipped with @indx-workspace/cli",
    { controlPlane: 'none', run: runDeploy },
  ),
];
