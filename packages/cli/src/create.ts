#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { runAsProcess } from './cli-failure.ts';
import { createHelp, parseCreateArguments } from './create/args.ts';
import { runCreateDeployment, type CreateDeploymentOptions } from './create/deployment-v1.ts';
import { runCreateProject, type CreateProjectOptions } from './create/project-v2.ts';

export {
  DEFAULT_TARGET,
  createHelp,
  parseCreateArguments,
  type CreateCommandArguments,
  type CreateDeploymentArguments,
  type CreateHelpArguments,
  type CreateProjectArguments,
} from './create/args.ts';
export {
  DEFAULT_ANSWERS,
  collectGeneratorAnswers,
  type CreateTerminal,
  type GeneratorAnswers,
} from './create/prompts.ts';
export {
  PACKAGE_MANAGERS,
  detectPackageManager,
  packageManagerSpawn,
  spawnInProject,
  type PackageManager,
  type RunInProject,
} from './create/package-manager.ts';
export { nextStepLines, shellArgument } from './create/output.ts';
export {
  TEMPLATES_DIRECTORY,
  createWorkspace,
  pinCliDependency,
  type CreateDeploymentOptions,
  type CreateWorkspaceOptions,
  type GeneratedWorkspace,
} from './create/deployment-v1.ts';
export {
  createProject,
  type CreatedProject,
  type CreateProjectOptions,
} from './create/project-v2.ts';

/**
 * Whether this file is the script Node was asked to execute.
 *
 * Package managers expose bins through symlinks, while Node resolves `import.meta.url` to the real
 * file. Canonicalising both paths keeps those normal invocations working and fails closed if
 * either path cannot be resolved.
 */
export function isMainModule(entry: string | undefined, moduleUrl: string): boolean {
  if (entry === undefined || entry.length === 0) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

export { runAsProcess };

export interface RunCreateCommandOptions extends CreateProjectOptions, CreateDeploymentOptions {}

export async function runCreateCommand(
  argv = process.argv.slice(2),
  options: RunCreateCommandOptions = {},
): Promise<void> {
  const parsed = parseCreateArguments(argv);
  if (parsed.kind === 'help') {
    process.stdout.write(createHelp());
    return;
  }
  if (parsed.kind === 'project') {
    await runCreateProject(parsed, options);
    return;
  }
  await runCreateDeployment(parsed, options);
}

if (isMainModule(process.argv[1], import.meta.url)) {
  process.exitCode = await runAsProcess(() => runCreateCommand());
}
