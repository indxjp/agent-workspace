/**
 * `run_skill_script` — run one Node script a skill shipped, with no shell (ADR-0137, #1089).
 *
 * A read-only file grant withholds every shell tool, because a redirect writes through the grant and
 * nothing can tell a redirect from a read (`./tool-plan.ts`). That also took away the way an agent
 * runs its skill scripts. This tool is the one use of `runCommands` a read-only grant leaves
 * standing: the process is `node --permission --allow-fs-read=<cwd> --allow-fs-write=<writable>
 * <script> ...args`, started with `execFile`, so there is no redirect, no pipe and no expansion, and
 * Node's permission model refuses a write outside the paths named — a read-only grant is never named.
 *
 * What lives here is the **decision**: when the tool is offered, what a call may name, how the
 * command line is built, and how a result is classified. What needs a process and a disk is the
 * injected {@link SkillScriptHost}, the way `./resolved-path.ts` takes its filesystem: this package
 * has no `@types/node`, and each adapter hands over ten lines of `node:child_process` and
 * `node:fs/promises`.
 *
 * The script must resolve — symbolic links included — inside the placed skill's `scripts/`
 * directory. The permission model follows links that already exist, so the containment check is
 * ours; it is the second check after the runner refusing to place a link at all.
 */
import { normaliseGrants, type NormalisedGrant } from './path-grant.js';
import type { EngineRunRequest } from './port.js';

export const RUN_SKILL_SCRIPT_TOOL = 'run_skill_script';

/** The limits one call runs under. */
export type SkillScriptLimits = {
  readonly timeoutMs: number;
  /** Per stream (`stdout`, `stderr`): `execFile`'s `maxBuffer`. */
  readonly maxOutputBytes: number;
  readonly maxArguments: number;
  readonly maxArgumentBytes: number;
};

export const SKILL_SCRIPT_LIMITS: SkillScriptLimits = {
  timeoutMs: 120_000,
  maxOutputBytes: 1024 * 1024,
  maxArguments: 64,
  maxArgumentBytes: 8 * 1024,
};

/** Why a call was refused. A script that merely exits non-zero is not a refusal. */
export const SKILL_SCRIPT_REFUSALS = [
  /** The input is not `{ skill, script, args }` of strings within the argument limits. */
  'unusable_arguments',
  /** The run does not grant this skill (or it ships no script). */
  'unknown_skill',
  /** `script` is not one plain file name, or names no file in the skill's `scripts/`. */
  'unusable_script',
  /** The script's real path, links resolved, is not inside the skill's `scripts/` directory. */
  'outside_skill_directory',
  'timeout',
  'output_too_large',
] as const;
export type SkillScriptRefusal = (typeof SKILL_SCRIPT_REFUSALS)[number];

/** The members of `node:child_process` / `node:fs/promises` the tool uses, structurally. */
export type SkillScriptHost = {
  /** The Node binary that runs the script: `process.execPath`. */
  readonly execPath: string;
  /**
   * `execFile`, promisified. Resolves with the output of a process that exited 0; rejects with the
   * error Node raises otherwise (`code`, `killed`, `signal`, `stdout`, `stderr`). An aborted
   * `signal` stops the process with `SIGKILL` and rejects with `ABORT_ERR`; Node's own abort sends
   * `SIGTERM` whatever `killSignal` says, so the host must send the kill itself. It rejects only
   * once the process has exited (or a bounded wait has passed), so the caller's cleanup of the
   * process's directory does not race a process that is still dying.
   */
  execFile(
    file: string,
    args: readonly string[],
    options: {
      readonly cwd: string;
      readonly timeout: number;
      readonly maxBuffer: number;
      readonly env: Readonly<Record<string, string>>;
      /** `SIGKILL`: a script cannot trap the kill a timeout, an overflow or an abort sends. */
      readonly killSignal: 'SIGKILL';
      readonly signal?: AbortSignal;
    },
  ): Promise<{ readonly stdout: string; readonly stderr: string }>;
  realpath(path: string): Promise<string>;
  /**
   * `node:path` (the platform's own: `win32` on Windows), so containment is decided with the
   * separator and case rules of the paths `realpath` returns.
   */
  readonly path: {
    join(...segments: string[]): string;
    relative(from: string, to: string): string;
    isAbsolute(path: string): boolean;
  };
  /** A new, empty, real directory the call may write to. */
  makeScratchDirectory(): Promise<string>;
  removeDirectory(path: string): Promise<void>;
};

/** What a run needs to offer and run the tool. Plain data, built once per run. */
export type SkillScriptSetup = {
  /** The sandbox root, without a trailing slash. */
  readonly cwd: string;
  /** Where skills are placed, relative to `cwd` (`<config>/skills`). */
  readonly skillsDirectory: string;
  /**
   * The granted skills that ship at least one file under `scripts/`, with the sorted file names the
   * tool can call: direct children of `scripts/` only, since the tool takes one plain file name.
   */
  readonly skills: readonly { readonly name: string; readonly scripts: readonly string[] }[];
  /** Workspace-relative read-write grants a script may write; empty unless `writeFiles` is on. */
  readonly writable: readonly string[];
};

export type SkillScriptOutcome =
  | {
      readonly ok: true;
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly ok: false; readonly refusal: SkillScriptRefusal; readonly reason: string };

function refuse(refusal: SkillScriptRefusal, reason: string): SkillScriptOutcome {
  return { ok: false, refusal, reason };
}

function directScripts(files: readonly { readonly path: string }[]): readonly string[] {
  const names = files
    .filter((file) => file.path.startsWith('scripts/'))
    .map((file) => file.path.slice('scripts/'.length))
    .filter((name) => name !== '' && !name.includes('/'));
  return [...new Set(names)].sort();
}

/**
 * The tool's setup for a run, or `null` when it is not offered: `runCommands` is off, or no granted
 * skill ships a script. Whether a read-only grant exists does not matter — that is the point.
 */
export function skillScriptSetup(
  request: Pick<EngineRunRequest, 'cwd' | 'portable' | 'resources'>,
  protectedConfigDirectory: string,
): SkillScriptSetup | null {
  const { permissions, skills: policy } = request.portable;
  if (!permissions.runCommands) return null;
  const granted = request.resources.skills.filter(
    (skill) =>
      (policy.mode === 'all' || policy.names.includes(skill.name)) &&
      skill.files.some((file) => file.path.startsWith('scripts/')),
  );
  if (granted.length === 0) return null;
  // A grant that does not normalise already refuses the run in every adapter's compile; offering no
  // write access is the safe reading if one reaches here anyway.
  const grants = normaliseGrants(request.resources.files, protectedConfigDirectory);
  const writable: readonly NormalisedGrant[] =
    permissions.writeFiles && grants.ok
      ? grants.grants.filter((grant) => grant.access === 'read-write')
      : [];
  return {
    cwd: request.cwd.replace(/\/+$/u, ''),
    skillsDirectory: `${protectedConfigDirectory}/skills`,
    skills: granted.map((skill) => ({ name: skill.name, scripts: directScripts(skill.files) })),
    writable: writable.map((grant) => grant.path),
  };
}

/** How many script names the description lists per skill; the refusal for one skill lists all. */
const DESCRIBED_SCRIPTS_PER_SKILL = 20;

function listedScripts(scripts: readonly string[]): string {
  const listed = scripts.slice(0, DESCRIBED_SCRIPTS_PER_SKILL).join(', ');
  const more = scripts.length - DESCRIBED_SCRIPTS_PER_SKILL;
  return more > 0 ? `${listed}, +${String(more)} more` : listed;
}

/** The tool's description, as the model reads it. */
export function skillScriptToolDescription(setup: SkillScriptSetup): string {
  return [
    `Run one Node script that a skill ships in its scripts/ directory, with the given arguments.`,
    `There is no shell: no pipes, redirects, globs or stdin, and the script cannot start other programs.`,
    `Paths in args are relative to the working directory. The script can read the whole working directory`,
    `and write only where this agent may write${setup.writable.length === 0 ? ' (a temporary directory, $TMPDIR)' : ` (${setup.writable.join(', ')} and a temporary directory, $TMPDIR)`}.`,
    `It is stopped after ${String(SKILL_SCRIPT_LIMITS.timeoutMs / 1000)} seconds, and output beyond ${String(SKILL_SCRIPT_LIMITS.maxOutputBytes / 1024)} KiB per stream is refused.`,
    `Scripts by skill: ${setup.skills.map((skill) => `${skill.name} (${skill.scripts.length === 0 ? 'none directly in scripts/' : listedScripts(skill.scripts)})`).join('; ')}.`,
    `Read the skill (its SKILL.md) for a script's arguments before the first call.`,
  ].join(' ');
}

/** The input schema as plain JSON Schema, which an adapter's own validator must agree with. */
export const RUN_SKILL_SCRIPT_INPUT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    skill: { type: 'string', description: 'The skill name.' },
    script: {
      type: 'string',
      description: 'A file name in the skill’s scripts/ directory, for example "check.mjs".',
    },
    args: { type: 'array', items: { type: 'string' }, description: 'Arguments, one string each.' },
  },
  required: ['skill', 'script'],
  additionalProperties: false,
} as const;

export type RunSkillScriptInput = {
  readonly skill: string;
  readonly script: string;
  readonly args: readonly string[];
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const INPUT_KEYS: ReadonlySet<string> = new Set(['skill', 'script', 'args']);

/** A strict parse of a model-supplied call: unknown keys, non-strings and oversize arguments are refused. */
export function parseRunSkillScriptInput(
  input: unknown,
  limits: SkillScriptLimits = SKILL_SCRIPT_LIMITS,
):
  | { readonly ok: true; readonly input: RunSkillScriptInput }
  | (SkillScriptOutcome & { ok: false }) {
  if (!isRecord(input)) {
    return { ok: false, refusal: 'unusable_arguments', reason: 'the input must be an object.' };
  }
  const record = input;
  const unknownKey = Object.keys(record).find((key) => !INPUT_KEYS.has(key));
  if (unknownKey !== undefined) {
    return {
      ok: false,
      refusal: 'unusable_arguments',
      reason: `${JSON.stringify(unknownKey)} is not a field of this tool (skill, script, args).`,
    };
  }
  const skill = record['skill'];
  const script = record['script'];
  const args = record['args'] ?? [];
  if (typeof skill !== 'string' || typeof script !== 'string') {
    return {
      ok: false,
      refusal: 'unusable_arguments',
      reason: 'skill and script must be strings.',
    };
  }
  if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === 'string')) {
    return {
      ok: false,
      refusal: 'unusable_arguments',
      reason: 'args must be an array of strings.',
    };
  }
  if (args.length > limits.maxArguments) {
    return {
      ok: false,
      refusal: 'unusable_arguments',
      reason: `at most ${String(limits.maxArguments)} arguments are allowed; got ${String(args.length)}.`,
    };
  }
  if (args.some((arg) => new TextEncoder().encode(arg).length > limits.maxArgumentBytes)) {
    return {
      ok: false,
      refusal: 'unusable_arguments',
      reason: `an argument is longer than ${String(limits.maxArgumentBytes)} bytes.`,
    };
  }
  if (args.some((arg) => arg.includes('\0'))) {
    return { ok: false, refusal: 'unusable_arguments', reason: 'an argument contains NUL.' };
  }
  return { ok: true, input: { skill, script, args } };
}

/** A name that is not a file name at all: empty, too long, or holding NUL. */
function isUnusableName(name: string): boolean {
  return name.length === 0 || name.length > 255 || name.includes('\0');
}

/** A name that points somewhere else: a separator, or `.`/`..`. */
function leavesDirectory(name: string): boolean {
  return name === '.' || name === '..' || /[\\/]/u.test(name);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

type ExecFailure = {
  readonly code?: unknown;
  readonly killed?: unknown;
  readonly signal?: unknown;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
};

/**
 * The numbers POSIX fixes for the signals a script can die of on its own (an abort, a crash, a
 * self-kill), so `128 + n` reads the same on Linux and macOS. Any other signal reports `128`; the
 * name is in `stderr` either way.
 */
const SIGNAL_NUMBERS: Readonly<Record<string, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGSEGV: 11,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
};

function failureOf(error: unknown): ExecFailure | null {
  return typeof error === 'object' && error !== null ? error : null;
}

/**
 * Classify what `execFile` rejected with: an output overflow and a timeout are refusals named for
 * what happened; a numeric exit status, or a signal the script died of on its own, is the script's
 * own answer; the run's abort propagates, and so does anything else (the binary would not start),
 * which is an infrastructure fault.
 */
function classifyFailure(error: unknown, limits: SkillScriptLimits): SkillScriptOutcome {
  const failure = failureOf(error);
  if (failure?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return refuse(
      'output_too_large',
      `the script wrote more than ${String(limits.maxOutputBytes)} bytes to stdout or stderr and was stopped.`,
    );
  }
  if (failure?.killed === true) {
    return refuse(
      'timeout',
      `the script ran longer than ${String(limits.timeoutMs / 1000)} seconds and was stopped.`,
    );
  }
  if (failure === null || failure.code === 'ABORT_ERR') throw error;
  const stdout = typeof failure.stdout === 'string' ? failure.stdout : '';
  const stderr = typeof failure.stderr === 'string' ? failure.stderr : '';
  if (typeof failure.code === 'number') {
    return { ok: true, exitCode: failure.code, stdout, stderr };
  }
  if (failure.code === null && typeof failure.signal === 'string') {
    const separator = stderr.length === 0 || stderr.endsWith('\n') ? '' : '\n';
    return {
      ok: true,
      exitCode: 128 + (SIGNAL_NUMBERS[failure.signal] ?? 0),
      stdout,
      stderr: `${stderr}${separator}the script was ended by ${failure.signal}.\n`,
    };
  }
  throw error;
}

/**
 * Run one call. Returns a named refusal or the script's exit code and output; throws only when the
 * host itself fails (the Node binary does not start, the scratch directory cannot be made) or the
 * run's `signal` aborts, which stops the script.
 */
export async function runSkillScript(
  host: SkillScriptHost,
  setup: SkillScriptSetup,
  input: RunSkillScriptInput,
  limits: SkillScriptLimits = SKILL_SCRIPT_LIMITS,
  signal?: AbortSignal,
): Promise<SkillScriptOutcome> {
  const skill = setup.skills.find((candidate) => candidate.name === input.skill);
  if (skill === undefined) {
    return refuse(
      'unknown_skill',
      `${JSON.stringify(input.skill)} is not a skill with scripts in this run. Skills with scripts: ${setup.skills.map((candidate) => candidate.name).join(', ')}.`,
    );
  }
  if (isUnusableName(input.script)) {
    return refuse('unusable_script', `${JSON.stringify(input.script)} is not a file name.`);
  }
  if (leavesDirectory(input.script)) {
    return refuse(
      'outside_skill_directory',
      `${JSON.stringify(input.script)} is not a plain file name in the skill's scripts/ directory.`,
    );
  }
  const { path } = host;
  const root = await host.realpath(setup.cwd);
  const scriptsDirectory = path.join(root, setup.skillsDirectory, input.skill, 'scripts');
  let realScripts: string;
  let realScript: string;
  try {
    realScripts = await host.realpath(scriptsDirectory);
    realScript = await host.realpath(path.join(scriptsDirectory, input.script));
  } catch (error) {
    if (!isMissing(error)) throw error;
    return refuse(
      'unusable_script',
      `skill ${JSON.stringify(input.skill)} has no ${JSON.stringify(`scripts/${input.script}`)}. ${
        skill.scripts.length === 0
          ? 'It ships no script directly in scripts/.'
          : `Available: ${skill.scripts.join(', ')}.`
      }`,
    );
  }
  // `scripts/` itself may be a link out of the skill; the real directory must be the placed one.
  // Both comparisons go through `path.relative`, which knows the platform's separator and case rules.
  const inside = path.relative(realScripts, realScript);
  if (
    path.relative(scriptsDirectory, realScripts) !== '' ||
    inside === '' ||
    path.isAbsolute(inside) ||
    /^\.\.(?:[\\/]|$)/u.test(inside)
  ) {
    return refuse(
      'outside_skill_directory',
      `scripts/${input.script} of skill ${JSON.stringify(input.skill)} resolves outside the skill's scripts/ directory.`,
    );
  }
  const scratch = await host.makeScratchDirectory();
  try {
    const { stdout, stderr } = await host.execFile(
      host.execPath,
      [
        '--permission',
        `--allow-fs-read=${root}`,
        `--allow-fs-read=${scratch}`,
        `--allow-fs-write=${scratch}`,
        ...setup.writable.map((grant) => `--allow-fs-write=${path.join(root, grant)}`),
        realScript,
        ...input.args,
      ],
      {
        cwd: root,
        timeout: limits.timeoutMs,
        maxBuffer: limits.maxOutputBytes,
        env: { TMPDIR: scratch },
        killSignal: 'SIGKILL',
        ...(signal === undefined ? {} : { signal }),
      },
    );
    return { ok: true, exitCode: 0, stdout, stderr };
  } catch (error) {
    return classifyFailure(error, limits);
  } finally {
    await host.removeDirectory(scratch);
  }
}

/** The text a model reads for an outcome, and whether it is an error. */
export function skillScriptResultText(outcome: SkillScriptOutcome): {
  readonly text: string;
  readonly isError: boolean;
} {
  if (!outcome.ok) {
    return { text: `refused (${outcome.refusal}): ${outcome.reason}`, isError: true };
  }
  const sections = [`exit code ${String(outcome.exitCode)}`];
  if (outcome.stdout.length > 0) sections.push(`stdout:\n${outcome.stdout}`);
  if (outcome.stderr.length > 0) sections.push(`stderr:\n${outcome.stderr}`);
  return { text: sections.join('\n\n'), isError: outcome.exitCode !== 0 };
}

/** Parse and run one model-supplied call; the one function an adapter's tool body needs. */
export async function executeRunSkillScript(
  host: SkillScriptHost,
  setup: SkillScriptSetup,
  input: unknown,
  signal?: AbortSignal,
): Promise<{ readonly text: string; readonly isError: boolean }> {
  const parsed = parseRunSkillScriptInput(input);
  return skillScriptResultText(
    parsed.ok
      ? await runSkillScript(host, setup, parsed.input, SKILL_SCRIPT_LIMITS, signal)
      : parsed,
  );
}
