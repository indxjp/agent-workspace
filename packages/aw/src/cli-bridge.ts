import { CommandRefusedError } from './io.js';
import { errorCode } from './local-runtime/project.js';
import { AW_VERSION } from './version.js';

/** The package that holds `agent-workspace deploy` and the platform publishers; an optional peer of `aw` (ADR-0103). */
const CLI_PACKAGE = '@indx-workspace/cli';

type DeploySteps = typeof import('@indx-workspace/cli/deploy');
type PublishSteps = typeof import('@indx-workspace/cli/publish');

/**
 * The one file of `aw` that reaches `@indx-workspace/cli` (ADR-0103, ADR-0133 D11). The CLI is an
 * optional peer and brings the S3, GCS and PostgreSQL clients every other `aw` command does
 * without, so each subpath loads only when its command runs. The specifiers stay literal so
 * bundlers and knip see them.
 */
async function loadOptionalCli<Steps>(load: () => Promise<Steps>, command: string): Promise<Steps> {
  try {
    return await load();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    // A package the installed CLI imports is missing too: that is a broken install, not this one.
    const missingCli =
      errorCode(error) === 'ERR_MODULE_NOT_FOUND' && error.message.includes(`'${CLI_PACKAGE}'`);
    // A CLI from before this subpath existed resolves, but does not export it.
    const olderCli =
      errorCode(error) === 'ERR_PACKAGE_PATH_NOT_EXPORTED' &&
      error.message.replaceAll('\\', '/').includes(`/${CLI_PACKAGE}/package.json`);
    if (!missingCli && !olderCli) throw error;
    // An ESM import never resolves a global install, so the fix is the project's own dependency.
    throw new CommandRefusedError(
      `${CLI_PACKAGE} is ${missingCli ? 'not installed' : 'older than aw'}; aw ${command} runs its steps`,
      `npm install --save-dev ${CLI_PACKAGE}@${AW_VERSION}`,
    );
  }
}

/** The CLI's deploy steps, for `aw deploy`. `load` is the suite's seam. */
export function loadDeploySteps(
  load: () => Promise<DeploySteps> = () => import('@indx-workspace/cli/deploy'),
): Promise<DeploySteps> {
  return loadOptionalCli(load, 'deploy');
}

/** The CLI's publish executors, for `aw platforms publish` and `aw platforms doctor`. */
export function loadPublishSteps(
  load: () => Promise<PublishSteps> = () => import('@indx-workspace/cli/publish'),
): Promise<PublishSteps> {
  return loadOptionalCli(load, 'platforms publish');
}
