import { lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  withRecommendedAnswers,
  type CompleteSetupAnswers,
  type SetupAnswers,
} from '@indx-workspace/contracts/setup';
import {
  askSetupQuestions,
  confirmMenu,
  mergeSetupAnswers,
  parseSetupAnswersFile,
  parseSetupFlags,
  ProjectFileError,
  projectDependencies,
  projectNameFor,
  ProjectRenderError,
  renderProjectFiles,
  setupSecretNames,
  unansweredSetupRefusal,
  type ProjectFile,
} from '@indx-workspace/sdk/project';
import { z } from 'zod';

import {
  command,
  isOn,
  singleValue,
  type LocalCommand,
  type LocalCommandContext,
} from '../command.js';
import { CommandRefusedError, UsageError, type CliIo } from '../io.js';
import { errorCode } from '../local-runtime/project.js';
import { AW_VERSION } from '../version.js';

/**
 * The two dependency maps `aw init` reads from `package.json` to tell what is missing. It is the
 * developer's file with many other keys, so the object is deliberately not strict; it is only
 * read, never written.
 */
const PackageManifestSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

/** The answers that mean yes to the `[y/N]` question; anything else, including nothing, is no. */
const YES_ANSWERS: ReadonlySet<string> = new Set(['y', 'yes']);

/** The last line of setup, identical in `create` (ADR-0107 SD9): what `aw login` cannot do yet. */
const HANDOFF =
  'to share a workspace later: aw login --url <url> (reads workspaces; pushing with it is not supported yet)';

/** The rendered files an existing project may already have: its own README and AGENTS.md are kept. */
const KEPT = ['README.md', 'AGENTS.md'] as const;

function isKept(file: string): boolean {
  return (KEPT as readonly string[]).includes(file);
}

function render(cwd: string, answers: CompleteSetupAnswers): readonly ProjectFile[] {
  try {
    return renderProjectFiles(answers, {
      name: projectNameFor(path.basename(cwd)),
      version: AW_VERSION,
    });
  } catch (error) {
    if (error instanceof ProjectRenderError) throw new UsageError(error.message);
    throw error;
  }
}

/**
 * What already occupies a path `aw init` needs: a rendered file that exists (`lstat`, so a
 * dangling symlink counts too), or a parent such as `agents` that exists but is not a directory.
 * An existing `README.md` or `AGENTS.md` is not a conflict (`runInit` keeps them). Every conflict
 * is found before anything is written, so a refusal never leaves a half-written project behind.
 */
async function conflicts(cwd: string, files: readonly ProjectFile[]): Promise<string[]> {
  const found = new Set<string>();
  for (const file of files) {
    const parts = file.path.split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
      const parent = parts.slice(0, depth).join('/');
      if (!(await isDirectoryOrAbsent(path.join(cwd, parent)))) found.add(parent);
    }
    if (!isKept(file.path) && (await occupied(path.join(cwd, file.path)))) found.add(file.path);
  }
  return [...found];
}

/** `true` when nothing is at `target` or it is a directory (a symlink to one counts). */
async function isDirectoryOrAbsent(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return true;
    if (errorCode(error) === 'ENOTDIR') return false;
    throw error;
  }
}

/** `true` when anything, a dangling symlink included, is at `target`. */
async function occupied(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    // ENOTDIR: a parent is a file, which `conflicts` already lists by the parent's own path.
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return false;
    throw error;
  }
}

/** The terminal's prompt; without one, `aw init` is refused before anything is asked. */
function terminalPrompt(io: CliIo): (question: string) => Promise<string> {
  const { prompt } = io;
  if (!io.isTty || prompt === undefined) {
    throw new CommandRefusedError(
      'aw init writes files; pass --yes when no person is at a terminal (no terminal, or CI is set)',
      'aw init --yes',
    );
  }
  return prompt;
}

/** The answers file, `--answers <file>` read relative to `cwd`; `{}` when none was given. */
async function fileAnswers(context: LocalCommandContext, cwd: string): Promise<SetupAnswers> {
  const file = context.args.values.get('answers');
  if (file === undefined) return {};
  let text: string;
  try {
    text = await readFile(path.resolve(cwd, file), 'utf8');
  } catch (error) {
    const missing = errorCode(error) === 'ENOENT';
    throw new UsageError(
      `--answers ${file}: the file ${missing ? 'does not exist' : 'cannot be read'}`,
    );
  }
  try {
    return parseSetupAnswersFile(text, file);
  } catch (error) {
    if (error instanceof ProjectFileError) throw new UsageError(error.message);
    throw error;
  }
}

/** The answers given as flags (issue #689) over the answers file, refused with the interview's own message. */
async function presetAnswers(context: LocalCommandContext, cwd: string): Promise<SetupAnswers> {
  try {
    const fromFile = await fileAnswers(context, cwd);
    const agent = singleValue(context, 'agent');
    return mergeSetupAnswers(
      fromFile,
      parseSetupFlags({
        ...Object.fromEntries(context.args.values),
        ...(agent === undefined ? {} : { agent }),
      }),
    );
  } catch (error) {
    if (error instanceof Error && !(error instanceof UsageError)) {
      throw new UsageError(error.message);
    }
    throw error;
  }
}

/** `--yes` cannot take a default a question does not have; refused before anything is rendered. */
function assertNothingUnanswered(preset: SetupAnswers): void {
  const refusal = unansweredSetupRefusal(preset);
  if (refusal !== null) throw new UsageError(refusal.message, refusal.fix);
}

/**
 * `--yes` takes the recommended answers for what no flag or answers-file entry answered; a
 * terminal is asked the setup questions none of them answered through the one loop `create` asks
 * through (C20).
 */
async function answersFor(
  context: LocalCommandContext,
  cwd: string,
): Promise<CompleteSetupAnswers> {
  const { io } = context;
  const preset = await presetAnswers(context, cwd);
  if (isOn(context, 'yes')) {
    assertNothingUnanswered(preset);
    return withRecommendedAnswers(preset);
  }
  return askSetupQuestions(
    terminalPrompt(io),
    (line) => {
      io.stdout(`${line}\n`);
    },
    preset,
    io.choose,
  );
}

async function confirmed(
  context: LocalCommandContext,
  cwd: string,
  files: readonly ProjectFile[],
): Promise<boolean> {
  const { io } = context;
  if (isOn(context, 'yes')) return true;
  const lines = files.map((file) => `  ${file.path}\n`).join('');
  io.stdout(`aw init will write:\n${lines}${gitignoreLine(await gitignorePlan(cwd))}`);
  const title = `Write these ${String(files.length)} files?`;
  if (io.isTty && io.choose !== undefined) return confirmMenu(io.choose, title);
  const answer = await terminalPrompt(io)(`write these ${String(files.length)} files? [y/N] `);
  return YES_ANSWERS.has(answer.trim().toLowerCase());
}

/** A path that appeared since the check: refused by name, never overwritten. */
function appeared(relative: string): CommandRefusedError {
  return new CommandRefusedError(`${relative} appeared while aw init was writing`);
}

async function writeFiles(cwd: string, files: readonly ProjectFile[], io: CliIo): Promise<void> {
  // Every directory first, so a parent that turned into a file is refused before any file exists.
  for (const file of files) {
    const directory = path.dirname(file.path);
    try {
      await mkdir(path.join(cwd, directory), { recursive: true });
    } catch (error) {
      const code = errorCode(error);
      if (code === 'EEXIST' || code === 'ENOTDIR') throw appeared(directory);
      throw error;
    }
  }
  for (const file of files) {
    try {
      // `wx`: a file that appeared since the check is never overwritten.
      await writeFile(path.join(cwd, file.path), file.contents, { flag: 'wx' });
    } catch (error) {
      if (errorCode(error) === 'EEXIST') throw appeared(file.path);
      throw error;
    }
    io.stdout(`wrote ${file.path}\n`);
  }
}

/** What `aw dev` writes or reads that must never be committed, as `.gitignore` lines. */
const IGNORED = ['node_modules/', '.agent-workspace/', '.aw/', '.env'] as const;

/**
 * Makes sure `.gitignore` lists the same four entries as the `.gitignore` of `npm create` does
 * (BH061-043): `node_modules/`, `.agent-workspace/` (the console password), `.aw/` (the runtime's
 * logs) and `.env` (the key file). It creates it, or appends what is missing and leaves every line
 * of the developer's own file as it is. One line says what it did.
 */
async function gitignorePlan(
  cwd: string,
): Promise<{ readonly text: string; readonly missing: readonly string[] }> {
  let text = '';
  try {
    text = await readFile(path.join(cwd, '.gitignore'), 'utf8');
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  const listed = new Set(text.split(/\r?\n/u).map((line) => line.trim().replace(/^\//u, '')));
  const missing = IGNORED.filter(
    (entry) => !listed.has(entry) && !listed.has(entry.replace(/\/$/u, '')),
  );
  return { text, missing };
}

/** The confirmation's line for `.gitignore`: what `ensureGitignore` will do, or nothing. */
function gitignoreLine({ text, missing }: Awaited<ReturnType<typeof gitignorePlan>>): string {
  if (missing.length === 0) return '';
  return text === ''
    ? 'and create .gitignore\n'
    : `and add ${missing.join(', ')} to the existing .gitignore\n`;
}

async function ensureGitignore(cwd: string, io: CliIo): Promise<void> {
  const plan = await gitignorePlan(cwd);
  if (plan.missing.length === 0) return;
  const { text, missing } = plan;
  const separator = text === '' || text.endsWith('\n') ? '' : '\n';
  await writeFile(path.join(cwd, '.gitignore'), `${text}${separator}${missing.join('\n')}\n`);
  io.stdout(text === '' ? 'wrote .gitignore\n' : `added ${missing.join(', ')} to .gitignore\n`);
}

/** A spec that installs `version`, or one a protocol (`workspace:`, `file:`) pins. */
function installsVersion(spec: string, version: string): boolean {
  return spec.includes(':') || spec.replace(/^[\^~=]/u, '') === version;
}

type PinnedPackage = readonly [name: string, version: string];

/**
 * The `wanted` packages `package.json` does not list at their version yet; `null` when there is no
 * `package.json`. A file that cannot be read or parsed tells nothing, so every one is listed.
 */
async function missingPackages(
  cwd: string,
  wanted: readonly PinnedPackage[],
): Promise<readonly PinnedPackage[] | null> {
  let text: string;
  try {
    text = await readFile(path.join(cwd, 'package.json'), 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    return wanted;
  }
  let json: unknown;
  try {
    // npm accepts a byte-order mark; `JSON.parse` does not.
    json = JSON.parse(text.replace(/^\uFEFF/u, ''));
  } catch {
    json = {};
  }
  const manifest = PackageManifestSchema.safeParse(json);
  const listed: Readonly<Record<string, string>> = manifest.success
    ? { ...manifest.data.dependencies, ...manifest.data.devDependencies }
    : {};
  return wanted.filter(([name, version]) => {
    const spec = listed[name];
    return spec === undefined || !installsVersion(spec, version);
  });
}

/**
 * What to run next: install the missing packages, the chosen engine's among them. `package.json`
 * itself is never written.
 */
async function printInstallHint(
  cwd: string,
  io: CliIo,
  answers: CompleteSetupAnswers,
): Promise<void> {
  const wanted = Object.entries(projectDependencies(AW_VERSION, answers['content.engine']));
  const missing = await missingPackages(cwd, wanted);
  if (missing === null) io.stderr('next: npm init -y\n');
  const install = missing ?? wanted;
  if (install.length === 0) return;
  const specs = install.map(([name, version]) => `${name}@${version}`);
  io.stderr(`next: npm install -D ${specs.join(' ')}\n`);
}

async function runInit(context: LocalCommandContext): Promise<void> {
  const { io, cwd } = context;
  if (cwd === undefined) {
    throw new CommandRefusedError('aw init needs a current directory to write the project into');
  }
  const answers = await answersFor(context, cwd);
  const files = render(cwd, answers);
  const existing = await conflicts(cwd, files);
  if (existing.length > 0) {
    throw new CommandRefusedError(
      `aw init would overwrite existing files:\n${existing.map((file) => `  ${file}`).join('\n')}`,
      'run aw init in an empty directory, or move these files away',
    );
  }
  const kept: string[] = [];
  const toWrite: ProjectFile[] = [];
  for (const file of files) {
    if (isKept(file.path) && (await occupied(path.join(cwd, file.path)))) kept.push(file.path);
    else toWrite.push(file);
  }
  if (!(await confirmed(context, cwd, toWrite))) {
    io.stderr('nothing written\n');
    return;
  }
  await writeFiles(cwd, toWrite, io);
  for (const name of kept) io.stdout(`kept the existing ${name}\n`);
  await ensureGitignore(cwd, io);
  await printInstallHint(cwd, io, answers);
  io.stderr(
    `aw dev reads ${setupSecretNames(answers).join(', ')} from its environment; no key is ` +
      `written to a file.\nnext: npx aw dev\n${HANDOFF}\n`,
  );
}

/**
 * Issue #451 (S1-13), #544 (S2-06b): write the starter files — `agent-workspace.yaml`, an agent
 * and a surface — rendered from the setup answers, exactly as `create` renders them. A terminal is
 * asked the setup questions; `--yes` takes the recommended answers. `--answers <file>` is a YAML or
 * JSON object of answers keyed by question id, under the flags (#879).
 *
 * It changes files, so it asks first on a terminal and needs `--yes` everywhere else; it never
 * overwrites a file and never edits `package.json`, printing the install line instead. It ends
 * with the hand-off: what to run next and what `aw login` cannot do yet.
 */
export const initCommands: readonly LocalCommand[] = [
  command(
    'init',
    // A literal, for the docs generator; `main.test.ts` pins it to the question set.
    '[--yes] [--theme <theme>] [--sandbox <sandbox>] [--provider <provider>] [--model-base-url <url>] [--agent <agent>] [--engine <engine>] [--tools <tools>] [--openapi <openapi>] [--permissions <permissions>] [--title <title>] [--color <color>] [--platform <platform>] [--features <features>] [--answers <file>]',
    'Write a starter project here: agent-workspace.yaml, an agent and a surface',
    { controlPlane: 'none', run: runInit },
  ),
];
