import { readFileSync } from 'node:fs';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  withRecommendedAnswers,
  type CompleteSetupAnswers,
  type SetupAnswers,
} from '@indx-workspace/contracts/setup';
import {
  askSetupQuestions,
  confirmMenu,
  MenuCancelledError,
  mergeSetupAnswers,
  parseSetupAnswersFile,
  projectNameFor,
  ProjectRenderError,
  renderProjectFiles,
  renderProjectShell,
  setupSecretNames,
  unansweredSetupRefusal,
  type ProjectFile,
} from '@indx-workspace/sdk/project';

import { CreateUsageError, errorCode } from '../cli-failure.ts';
import { CLI_VERSION } from '../version.ts';
import { DEFAULT_TARGET, type CreateProjectArguments } from './args.ts';
import { nextStepLines, paint, windowsDriveWarning } from './output.ts';
import {
  detectPackageManager,
  spawnInProject,
  type PackageManager,
  type RunInProject,
} from './package-manager.ts';
import {
  YES_ANSWERS,
  askProjectName,
  confirmYes,
  terminalFor,
  type CreateTerminal,
} from './prompts.ts';

/** What `createProject` wrote. */
export interface CreatedProject {
  readonly destination: string;
  /** Paths written, relative to the destination, in the order they were written. */
  readonly files: readonly string[];
}

/**
 * The v2 project's files for `destination`: the shell that makes it installable, then the three
 * files the setup answers are written into, exactly as `aw init` renders them. A refused answer
 * or name becomes a plain refusal carrying the renderer's own message.
 */
function renderProject(destination: string, answers: CompleteSetupAnswers): readonly ProjectFile[] {
  try {
    const name = projectNameFor(path.basename(destination));
    return [
      ...renderProjectShell({ name, version: CLI_VERSION, engine: answers['content.engine'] }),
      ...renderProjectFiles(answers, { name, version: CLI_VERSION }),
    ];
  } catch (error) {
    if (error instanceof ProjectRenderError) throw new Error(error.message, { cause: error });
    throw error;
  }
}

function existingDirectoryRefusal(destination: string): Error {
  return new Error(
    `${destination} already exists; create writes a new directory. Choose another name, or ` +
      'run `aw init` inside the existing directory.',
  );
}

/**
 * Create the one new directory `create` writes into. The errors an operator can cause with the
 * name they pass become plain refusals instead of a raw errno string: an existing directory, a
 * missing parent (create makes one directory, never its parents) and a name the file system
 * refuses.
 */
async function makeNewDirectory(destination: string): Promise<void> {
  try {
    await mkdir(destination, { recursive: false });
  } catch (error) {
    const code = errorCode(error);
    if (code === 'EEXIST') throw existingDirectoryRefusal(destination);
    if (code === 'ENOENT') {
      throw new Error(
        `${path.dirname(destination)} does not exist; create writes one new directory and ` +
          'never its parents. Create the parent first, or choose a name without a slash.',
        { cause: error },
      );
    }
    if (code === 'EINVAL' || code === 'ENAMETOOLONG') {
      throw new Error(
        `${JSON.stringify(path.basename(destination))} is not a valid directory name here; ` +
          'choose another name.',
        { cause: error },
      );
    }
    throw error;
  }
}

/** Refuse a destination that already exists, before any question is asked. */
async function assertAbsent(destination: string): Promise<void> {
  try {
    await lstat(destination);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  throw existingDirectoryRefusal(destination);
}

/**
 * Write the v2 project `aw dev` runs into a new directory (S1-16): `package.json`,
 * `pnpm-workspace.yaml`, `.gitignore`, `agent-workspace.yaml`, the agent and the surface.
 *
 * Everything renders before anything touches the disk, the directory itself must not exist, and
 * every file is written with `wx`, so nothing is ever overwritten. No `.env` is written and no
 * secret is generated: `aw dev` reads the model key from its own environment.
 */
export async function createProject(
  target: string,
  answers: CompleteSetupAnswers,
): Promise<CreatedProject> {
  const destination = path.resolve(target);
  const files = renderProject(destination, answers);
  await makeNewDirectory(destination);
  for (const file of files) {
    await mkdir(path.dirname(path.join(destination, file.path)), { recursive: true });
  }
  for (const file of files) {
    await writeFile(path.join(destination, file.path), file.contents, { flag: 'wx' });
  }
  return { destination, files: files.map((file) => file.path) };
}

/** Whether this Linux process runs under WSL, where `/mnt/<drive>` is a Windows drive. */
function isWsl(): boolean {
  if ((process.env['WSL_DISTRO_NAME'] ?? '') !== '') return true;
  try {
    return /microsoft/iu.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/** `listed` false: the person just confirmed the same list, so it is not printed twice (BH061-073). */
function printCreatedProject(
  created: CreatedProject,
  answers: CompleteSetupAnswers,
  listed: boolean,
): void {
  process.stdout.write(
    `\n${paint('green', `Created ${created.destination}`)}\n` +
      (listed ? created.files.map((file) => `  ${file}\n`).join('') : '') +
      `aw dev reads ${setupSecretNames(answers).join(', ')} from its environment; no key is ` +
      'written to a file.\n',
  );
}

/** What `create` may do after writing: the terminal and the process it runs in. */
interface Finish {
  readonly terminal: CreateTerminal | null;
  readonly run: RunInProject;
  readonly manager: PackageManager;
  readonly platform: NodeJS.Platform;
}

/**
 * After the files are written: install, then start, as the flags and the terminal decide, and
 * print the steps for whatever is left. `--yes` installs and never starts (a coding agent or CI
 * must not block on a foreground server); with no terminal and no flag nothing runs.
 */
async function finishProject(
  { target, yes, install, start }: CreateProjectArguments,
  destination: string,
  answers: CompleteSetupAnswers,
  { terminal, run, manager, platform }: Finish,
): Promise<void> {
  let installed = false;
  let startNow = false;
  try {
    const wantInstall =
      install ??
      (yes ? true : terminal !== null && (await confirmYes(terminal, 'Install dependencies now?')));
    if (wantInstall) {
      const code = await run(manager, ['install'], destination);
      installed = code === 0;
      if (!installed) {
        process.exitCode = 1;
        process.stderr.write(
          `${manager} install failed (exit ${String(code)}); fix the error above, then run it again.\n`,
        );
      }
    }
    startNow =
      installed &&
      (start ?? (!yes && terminal !== null && (await confirmYes(terminal, 'Start it now?'))));
  } catch (error) {
    if (!(error instanceof MenuCancelledError)) throw error;
    process.exitCode = 130;
  }
  if (startNow) {
    process.stdout.write(`${paint('dim', `${manager} run dev`)}\n`);
    const code = await run(manager, ['run', 'dev'], destination);
    if (code !== 0) process.exitCode = code;
    return;
  }
  const keyName = setupSecretNames(answers)[0];
  const missingKey = keyName !== undefined && (process.env[keyName] ?? '') === '' ? keyName : null;
  const lines = nextStepLines({ target, manager, installed, missingKey, platform });
  process.stdout.write(
    `${paint('bold', 'Next steps:')}\n${lines.map((line) => `  ${line}\n`).join('')}`,
  );
}

/**
 * The answers the flags give over the `--answers` file, which is read relative to the working
 * directory. A file or value that is not accepted is a usage error naming it (#879).
 */
async function presetAnswers({
  answers,
  answersFile,
}: CreateProjectArguments): Promise<SetupAnswers> {
  if (answersFile === undefined) return answers;
  let text: string;
  try {
    text = await readFile(path.resolve(answersFile), 'utf8');
  } catch (error) {
    throw new CreateUsageError(
      `--answers ${answersFile}: the file ${errorCode(error) === 'ENOENT' ? 'does not exist' : 'cannot be read'}`,
    );
  }
  try {
    return mergeSetupAnswers(parseSetupAnswersFile(text, answersFile), answers);
  } catch (error) {
    if (error instanceof Error) throw new CreateUsageError(error.message);
    throw error;
  }
}

export interface CreateProjectOptions {
  /** Injected by the suite; production asks the v2 setup questions on this process's terminal. */
  readonly terminal?: CreateTerminal;
  /** Injected by the suite; production runs the package manager in the new project. */
  readonly run?: RunInProject;
  /** Injected by the suite; production uses this process's platform. */
  readonly platform?: NodeJS.Platform;
}

/**
 * The v2 path: `--yes` takes the recommended answers; otherwise the questions the flags did not
 * answer are asked on a terminal and the file list is confirmed, as `aw init` confirms it. With
 * no terminal nobody can answer, so the recommended answers are taken and one line on stderr says
 * so (issue #689, D49). The project name is asked first when no directory was given.
 */
export async function runCreateProject(
  args: CreateProjectArguments,
  options: CreateProjectOptions,
): Promise<void> {
  const { yes } = args;
  const preset = await presetAnswers(args);
  const io = yes ? null : terminalFor(options.terminal);
  if (io === null) {
    // Nobody can be asked, so a question with no usable default is refused before anything is written.
    const refusal = unansweredSetupRefusal(preset);
    if (refusal !== null) throw new CreateUsageError(refusal.message, refusal.fix);
  }
  let target = args.target;
  if (!args.named) {
    if (io === null) {
      process.stderr.write(`no directory given: using ${DEFAULT_TARGET}\n`);
    } else {
      try {
        target = await askProjectName(io);
      } catch (error) {
        if (!(error instanceof MenuCancelledError)) throw error;
        process.exitCode = 130;
        process.stdout.write('nothing written\n');
        return;
      }
    }
  }
  const destination = path.resolve(target);
  const directoryName = path.basename(destination);
  const projectName = projectNameFor(directoryName);
  // A name the project file cannot hold as it is (`エージェント`, `My Agent`) is said, never
  // silently replaced (BH061-053).
  if (projectName !== directoryName) {
    process.stdout.write(
      `project name: ${projectName} (the directory stays ${JSON.stringify(directoryName)})\n`,
    );
  }
  const asked =
    io === null
      ? null
      : await (async () => {
          await assertAbsent(destination);
          const answers = await askSetupQuestions(
            (question) => io.prompt(question),
            (line) => process.stdout.write(`${line}\n`),
            preset,
            io.choose,
          );
          const files = renderProject(destination, answers);
          process.stdout.write(
            `create will write:\n${files.map((file) => `  ${file.path}\n`).join('')}`,
          );
          const confirmed =
            io.choose === undefined
              ? YES_ANSWERS.has(
                  (
                    await io.prompt(
                      `write these ${String(files.length)} files into ${destination}? [y/N] `,
                    )
                  )
                    .trim()
                    .toLowerCase(),
                )
              : await confirmMenu(
                  io.choose,
                  `Write these ${String(files.length)} files into ${destination}?`,
                );
          return confirmed ? answers : ('declined' as const);
        })().catch((error: unknown) => {
          if (!(error instanceof MenuCancelledError)) throw error;
          process.exitCode = 130;
          return 'declined' as const;
        });
  if (asked === 'declined') {
    process.stdout.write('nothing written\n');
    return;
  }
  if (asked === null && !yes) {
    process.stderr.write(
      Object.keys(preset).length > 0
        ? 'no terminal: used your flags and the recommended answers for the rest (to choose others, pass more flags or --answers <file>; see --help)\n'
        : 'no terminal: used the recommended answers (to choose others, pass flags or --answers <file>; see --help)\n',
    );
  }
  const answers = asked ?? withRecommendedAnswers(preset);
  const created = await createProject(target, answers);
  printCreatedProject(created, answers, asked === null);
  const platform = options.platform ?? process.platform;
  const driveWarning = windowsDriveWarning(created.destination, platform === 'linux' && isWsl());
  if (driveWarning !== null) process.stderr.write(driveWarning);
  // The name typed at the prompt, not the default `args` still carries, is the `cd` (BH061-015).
  await finishProject({ ...args, target }, created.destination, answers, {
    terminal: io,
    run:
      options.run ??
      ((manager, command, cwd) => spawnInProject(manager, command, cwd, 'inherit', platform)),
    manager: detectPackageManager(),
    platform,
  });
}
