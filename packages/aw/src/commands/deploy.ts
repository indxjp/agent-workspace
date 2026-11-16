import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  PROJECT_DEPLOY_TARGETS,
  type ProductionEnvironment,
  type ProjectDocument,
} from '@indx-workspace/contracts/project-file';
import {
  GENERATED_MANIFEST_FILE,
  parseGeneratedManifest,
  PROJECT_FILE_NAME,
  ProjectRenderError,
} from '@indx-workspace/sdk/project';

import { loadDeploySteps } from '../cli-bridge.js';
import { command, isOn, type LocalCommand, type LocalCommandContext } from '../command.js';
import { ChangesPendingError, CommandRefusedError, UsageError } from '../io.js';
import { errorCode, readLocalProject } from '../local-runtime/project.js';

const APP_ENTRY_PREFIX = 'app:';

/**
 * The apps a generator wrote into the project, by name, from its `aw-generated.json` (issue
 * #1505's strict parser); a project with no such file has none. A file the parser refuses is a
 * usage error, never read as "no apps".
 */
async function generatedAppNames(cwd: string): Promise<readonly string[]> {
  let text: string;
  try {
    text = await readFile(path.join(cwd, GENERATED_MANIFEST_FILE), 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw new UsageError(`could not read ${GENERATED_MANIFEST_FILE}`);
  }
  let entries: readonly string[];
  try {
    entries = Object.keys(parseGeneratedManifest(text).entries);
  } catch (error) {
    if (error instanceof ProjectRenderError) throw new UsageError(error.message);
    throw error;
  }
  return entries
    .filter((key) => key.startsWith(APP_ENTRY_PREFIX))
    .map((key) => key.slice(APP_ENTRY_PREFIX.length));
}

/**
 * Issue #1512: every app the project generated is deployed with production, so one that
 * `environments.production.apps` does not list is refused before any deploy step, rather than
 * shipping a platform whose app is missing.
 */
async function refuseUnlistedApps(cwd: string, production: ProductionEnvironment): Promise<void> {
  for (const name of await generatedAppNames(cwd)) {
    if (production.apps === undefined || !Object.hasOwn(production.apps, name)) {
      throw new CommandRefusedError(
        `the project has app ${name} but environments.production.apps.${name} is not set`,
        `add apps: { ${name}: { image: <registry>/${name}@sha256:…, url: https://<host> } } under environments.production`,
      );
    }
  }
}

/**
 * Issue #621, ADR-0103: deploy the project's `production` environment through
 * `agent-workspace deploy`. The environment's v1 deployment is internal state under
 * `~/.config/agent-workspace/deployments/<project>/<env>`; the project file is all a customer
 * edits. Without `--yes` it only plans, and a plan with changes exits 3.
 */
async function runDeploy(context: LocalCommandContext): Promise<void> {
  const { io, cwd, positionals } = context;
  const [environment, ...extra] = positionals;
  const subcommand = subcommandOf(environment);
  if (subcommand !== undefined) return subcommand(context, extra);
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
  const showPassword = isOn(context, 'show-owner-password');
  if (showPassword && (apply || isOn(context, 'plan') || context.args.values.has('infra'))) {
    throw new UsageError('--show-owner-password stands alone: it deploys nothing');
  }

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
  if (cwd !== undefined) await refuseUnlistedApps(cwd, deployed);
  const stateDirectory = path.join(
    io.homeDir,
    '.config',
    'agent-workspace',
    'deployments',
    project.name,
    environment,
  );

  if (showPassword) {
    const steps = await loadDeploySteps();
    try {
      io.stdout(
        `${await steps.showOwnerPassword({ project, environment, stateDirectory, env: { ...io.env } })}\n`,
      );
    } catch (error) {
      if (error instanceof Error) throw new CommandRefusedError(error.message);
      throw error;
    }
    return;
  }

  const infra = context.args.values.get('infra');
  if (infra?.trim() === '') throw new UsageError('--infra must not be empty');
  const infraDirectory = infra === undefined ? undefined : path.resolve(cwd ?? '', infra);

  const readSecret = secretReader(io);
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
      ...(readSecret === undefined ? {} : { readSecret }),
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

/** Asks for a value without echo, but only at a terminal; a pipe or CI gets none. */
function secretReader(
  io: LocalCommandContext['io'],
): ((question: string) => Promise<string>) | undefined {
  const { promptSecret } = io;
  if (!io.isTty || promptSecret === undefined) return undefined;
  return (question) => promptSecret(`${question}: `);
}

/** The project file and the state directory of the stack a stack command (destroy, status) works on. */
async function readStackProject(
  { io, cwd }: LocalCommandContext,
  environment: 'production',
): Promise<{ project: ProjectDocument; stateDirectory: string }> {
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
  const stateDirectory = path.join(
    io.homeDir,
    '.config',
    'agent-workspace',
    'deployments',
    project.name,
    environment,
  );
  return { project, stateDirectory };
}

/**
 * BYOC GCP P1: `aw deploy destroy production` plans the destruction of the stack `aw deploy`
 * made and applies it after the Owner types the Google Cloud project id: at the terminal, or as
 * one line on standard input.
 */
async function runDestroy(
  context: LocalCommandContext,
  [environment, ...extra]: readonly string[],
): Promise<void> {
  const { io } = context;
  if (environment !== 'production') {
    throw new UsageError(`destroy takes production; got ${JSON.stringify(environment ?? '')}`);
  }
  if (extra.length > 0) throw new UsageError(`unexpected argument ${JSON.stringify(extra[0])}`);
  const { project, stateDirectory } = await readStackProject(context, environment);
  const confirm = async (question: string): Promise<string> => {
    if (io.isTty && io.prompt !== undefined) return io.prompt(`${question}: `, context.signal);
    return ((await context.readStdin('destroy')).split('\n')[0] ?? '').trim();
  };
  const steps = await loadDeploySteps();
  try {
    await steps.destroyProjectEnvironment({
      project,
      environment,
      stateDirectory,
      env: { ...io.env },
      confirm,
    });
  } catch (error) {
    if (error instanceof Error) throw new CommandRefusedError(error.message);
    throw error;
  }
  io.stdout(`destroyed ${environment} (state in ${stateDirectory} is kept)\n`);
}

/**
 * BYOC GCP P6: `aw deploy status production` reports the versions, revision health, data
 * protection and drift of the stack `aw deploy` made, and creates nothing. It exits 0 when every
 * service is ready and the plan is empty, 3 when the plan has changes and 1 otherwise refused.
 */
async function runStatus(
  context: LocalCommandContext,
  [environment, ...extra]: readonly string[],
): Promise<void> {
  const { io } = context;
  if (environment !== 'production') {
    throw new UsageError(`status takes production; got ${JSON.stringify(environment ?? '')}`);
  }
  if (extra.length > 0) throw new UsageError(`unexpected argument ${JSON.stringify(extra[0])}`);
  const { project, stateDirectory } = await readStackProject(context, environment);
  const steps = await loadDeploySteps();
  let report: Awaited<ReturnType<typeof steps.deployStatus>>;
  try {
    report = await steps.deployStatus({ project, environment, stateDirectory, env: { ...io.env } });
  } catch (error) {
    if (error instanceof Error) throw new CommandRefusedError(error.message);
    throw error;
  }
  io.stdout(report.text);
  if (!report.ready) {
    throw new CommandRefusedError(
      'a service is not ready',
      'read the revision health above, then run aw deploy status production again',
    );
  }
  if (report.changes)
    throw new ChangesPendingError('the plan has changes; aw deploy production shows them');
}

/** The `aw deploy` words that name a stack command, not an environment. */
type StackCommand = (context: LocalCommandContext, rest: readonly string[]) => Promise<void>;

const SUBCOMMANDS: ReadonlyMap<string, StackCommand> = new Map([
  ['destroy', runDestroy],
  ['status', runStatus],
]);

function subcommandOf(word: string | undefined): StackCommand | undefined {
  return word === undefined ? undefined : SUBCOMMANDS.get(word);
}

export const deployCommands: readonly LocalCommand[] = [
  command(
    'deploy',
    '<environment> [--plan | --yes] [--infra <dir>] | production --show-owner-password | destroy production | status production',
    "Deploy the project's production environment through agent-workspace deploy; plans unless --yes; --infra names a checkout's infra/ whose gcp-cloudrun module or kubernetes chart is used instead of the one shipped with @indx-workspace/cli; --show-owner-password prints the Owner password of a gcp-cloudrun stack; destroy production deletes that stack after you type the Google Cloud project id; status production reports its versions, revision health, data protection and drift, creates nothing, and exits 3 when the plan has changes",
    { controlPlane: 'none', run: runDeploy },
  ),
];
