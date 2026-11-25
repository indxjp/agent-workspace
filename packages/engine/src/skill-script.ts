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
 * A script may import a built-in skill's module by its package path (ADR-0173,
 * {@link builtinImportHook}); the process's one `--import` maps it to the placed built-in skill.
 *
 * A call may name an earlier tool call of the run (`input: { fromToolUse }`, ADR-0176): the engine
 * writes that call's answer, as the model received it, into a directory of the call's own that the
 * script may read and not write, and names the file in `SKILL_SCRIPT_INPUT`. The model chooses the
 * answer; it cannot change a byte of it.
 *
 * The script must resolve — symbolic links included — inside the placed skill's `scripts/`
 * directory. The permission model follows links that already exist, so the containment check is
 * ours; it is the second check after the runner refusing to place a link at all.
 */
import { normaliseGrants } from './path-grant.js';
import type { EngineRunRequest } from './port.js';
import type { ToolAnswers } from './tool-answers.js';

export const RUN_SKILL_SCRIPT_TOOL = 'run_skill_script';

/**
 * The package name a skill script imports a built-in skill's module by (ADR-0173):
 * `<package>/<skill>/scripts/lib/<file>.mjs`. In this repository, the use cases install the
 * skills-office package under this name, so the path resolves through `node_modules`. A run's
 * sandbox has no `node_modules`, so {@link builtinImportHook} maps the same path to the built-in
 * skill as it is placed beside the script's own skill: one specifier, both places. The name is in
 * the platform's own npm scope, so no package someone else publishes can answer to it.
 */
export const BUILTIN_SKILL_PACKAGE = '@indx-workspace/builtin-skills';

/**
 * What a skill script may import from each built-in skill, and the sha256 of every file those
 * modules load, as this platform ships them (ADR-0173). A skill a person imported or edited under a
 * built-in's name is theirs (`apps/web/server/skills/builtin.ts`), so the hook imports from a placed
 * built-in only when each of these files is byte for byte the shipped one.
 * `tests/engine/run-skill-script.test.ts` fails when a shipped file and this table differ.
 */
export const BUILTIN_IMPORTS: Readonly<
  Record<
    string,
    { readonly modules: readonly string[]; readonly sha256: Readonly<Record<string, string>> }
  >
> = {
  'office-reader': {
    modules: ['scripts/lib/cli.mjs', 'scripts/lib/public-source.mjs', 'scripts/lib/table.mjs'],
    sha256: {
      'scripts/lib/cli.mjs': '58723c51defa158b7610d24334abc3737b265b4743720f27af4809c524a6ed67',
      'scripts/lib/public-source.mjs':
        '5f8bcdd34b41edddc5888b359197cdc9846449b238fe61e6f32624dab50611d7',
      'scripts/lib/table.mjs': 'ee5c8534533cbe449fe3f86f137780d399327250ff3f04c5ee442348718777e0',
      'scripts/ooxml.mjs': 'b45288c1cd8d486b578f7c94499d4070fc2b7249d3a0165f72be51f492a4bd85',
    },
  },
};

/**
 * The `--import` argument that installs, before the script runs, a resolve hook for
 * {@link BUILTIN_SKILL_PACKAGE}. `<package>/<skill>/<module>`, for a module {@link BUILTIN_IMPORTS}
 * lists, resolves to `<skillsRoot>/<skill>/<module>`, a placed file the process may already read,
 * once every file the table lists for that skill hashes to the shipped digest. Otherwise the
 * script stops with one JSON line on stderr and exit code 1, as a refused script does:
 *
 * - `not_importable`: any other specifier of the package, so none falls through to a
 *   `node_modules` folder the workspace could hold;
 * - `builtin_skill_not_granted`: the skill is not placed, because the run does not grant it;
 * - `builtin_skill_modified`: the placed skill is a person's own under the built-in's name.
 *
 * The hook is a `data:` module (`module.registerHooks`, Node 22.15 and later), so it needs no
 * permission of its own; it reads only placed files.
 *
 * @param skillsRoot the absolute directory skills are placed in.
 */
export function builtinImportHook(skillsRoot: string): string {
  const offered = Object.entries(BUILTIN_IMPORTS)
    .flatMap(([skill, { modules }]) => modules.map((module) => `${skill}/${module}`))
    .join(', ');
  const source = [
    `import{registerHooks}from'node:module';import{pathToFileURL}from'node:url';`,
    `import{readFileSync}from'node:fs';import{createHash}from'node:crypto';`,
    `const root=${JSON.stringify(skillsRoot)};`,
    `const imports=${JSON.stringify(BUILTIN_IMPORTS)};`,
    `const name=${JSON.stringify(BUILTIN_SKILL_PACKAGE)};`,
    `const offered=${JSON.stringify(offered)};`,
    `const checked=new Set();`,
    `const refuse=(error,message)=>{process.stderr.write(JSON.stringify({error,message})+String.fromCharCode(10));process.exit(1);};`,
    `registerHooks({resolve(specifier,context,nextResolve){`,
    `if(specifier!==name&&!specifier.startsWith(name+'/'))return nextResolve(specifier,context);`,
    `const rest=specifier.slice(name.length+1);const slash=rest.indexOf('/');`,
    `const skill=rest.slice(0,slash);const module=rest.slice(slash+1);`,
    `const entry=slash>0&&Object.hasOwn(imports,skill)?imports[skill]:undefined;`,
    `if(entry===undefined||!entry.modules.includes(module))`,
    `refuse('not_importable',specifier+' is not a module a built-in skill offers ('+name+'/: '+offered+')');`,
    `if(!checked.has(skill)){for(const[file,digest]of Object.entries(entry.sha256)){let bytes;`,
    `try{bytes=readFileSync(root+'/'+skill+'/'+file);}catch{`,
    `refuse('builtin_skill_not_granted',specifier+" needs the built-in skill "+skill+", which this run does not grant: the agent grants builtinSkill('"+skill+"')");}`,
    `if(createHash('sha256').update(bytes).digest('hex')!==digest)`,
    `refuse('builtin_skill_modified','the skill '+skill+' in this run is not the built-in one ('+file+' differs), so '+specifier+' is not imported');}`,
    `checked.add(skill);}`,
    `return{url:pathToFileURL(root+'/'+skill+'/'+module).href,shortCircuit:true};`,
    `}});`,
  ].join('');
  return `--import=data:text/javascript,${encodeURIComponent(source)}`;
}

/** The limits one call runs under. */
export type SkillScriptLimits = {
  readonly timeoutMs: number;
  /** Per stream (`stdout`, `stderr`): `execFile`'s `maxBuffer`. */
  readonly maxOutputBytes: number;
  readonly maxArguments: number;
  readonly maxArgumentBytes: number;
  /** The largest tool answer a call may hand its script by reference (ADR-0176). */
  readonly maxInputBytes: number;
};

export const SKILL_SCRIPT_LIMITS: SkillScriptLimits = {
  timeoutMs: 120_000,
  maxOutputBytes: 1024 * 1024,
  maxArguments: 64,
  maxArgumentBytes: 8 * 1024,
  maxInputBytes: 2 * 1024 * 1024,
};

/** The environment variable that names the file holding a referenced tool answer (ADR-0176). */
export const SKILL_SCRIPT_INPUT_ENV = 'SKILL_SCRIPT_INPUT';

/** The file name of a referenced answer in the call's input directory. */
const INPUT_FILE = 'tool-answer.txt';

/** How many held answers a refusal names; the oldest are left out past it. */
const NAMED_ANSWERS = 20;

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
  /** `input.fromToolUse` names no tool call whose answer this run received (ADR-0176). */
  'unknown_tool_answer',
  /** The referenced answer is an error, or larger than `maxInputBytes` (ADR-0176). */
  'unusable_tool_answer',
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
  /** Write `content` as UTF-8 to `path`, a new file in a directory {@link makeScratchDirectory} made. */
  writeFile(path: string, content: string): Promise<void>;
  /** `mkdir -p`: creates `path` and its missing parents; resolves when it already exists. */
  makeDirectory(path: string): Promise<void>;
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
  /**
   * The members of `writable` that are folders (directory grants and `outputs`), which the tool
   * creates before a call when they are missing. A file grant is never one: making a folder with a
   * file's name would break the grant and its write-back.
   */
  readonly writableDirectories: readonly string[];
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

/** The working-directory folder a run's collected files live in. */
const RUN_OUTPUTS_DIRECTORY = 'outputs';

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
  const writableGrants =
    permissions.writeFiles && grants.ok
      ? grants.grants.filter((grant) => grant.access === 'read-write')
      : [];
  const grantedPaths = writableGrants.map((grant) => grant.path);
  const grantedDirectories = writableGrants
    .filter((grant) => grant.kind === 'directory')
    .map((grant) => grant.path);
  // `outputs` is where a completed run's files are collected into the run's record, so a script of a
  // `writeFiles` agent may write there without a grant — unless a read-only grant is `outputs` or lies
  // under it, because `--allow-fs-write` never names a read-only grant (ADR-0137).
  const outputsHoldsReadOnly =
    grants.ok &&
    grants.grants.some(
      (grant) => grant.access !== 'read-write' && grant.segments[0] === RUN_OUTPUTS_DIRECTORY,
    );
  const outputs = permissions.writeFiles && grants.ok && !outputsHoldsReadOnly;
  const writable = outputs ? [...new Set([...grantedPaths, RUN_OUTPUTS_DIRECTORY])] : grantedPaths;
  const writableDirectories = outputs
    ? [...new Set([...grantedDirectories, RUN_OUTPUTS_DIRECTORY])]
    : grantedDirectories;
  return {
    cwd: request.cwd.replace(/\/+$/u, ''),
    skillsDirectory: `${protectedConfigDirectory}/skills`,
    skills: granted.map((skill) => ({ name: skill.name, scripts: directScripts(skill.files) })),
    writable,
    writableDirectories,
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
    `To give a script the answer of an earlier tool call of this run, pass input: { fromToolUse: "<that call's id>" } instead of copying the answer into args: the script reads it, unchanged, from the file named in $${SKILL_SCRIPT_INPUT_ENV}. A call that needs approval is approved with that id, and runs on the answer the id names.`,
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
    input: {
      type: 'object',
      properties: {
        fromToolUse: {
          type: 'string',
          description:
            'The id of an earlier tool call in this run. Its answer, exactly as you received it, is given to the script as a file; you cannot change it.',
        },
      },
      required: ['fromToolUse'],
      additionalProperties: false,
      description:
        'Hand the script the answer of an earlier tool call instead of copying it into args.',
    },
  },
  required: ['skill', 'script'],
  additionalProperties: false,
} as const;

export type RunSkillScriptInput = {
  readonly skill: string;
  readonly script: string;
  readonly args: readonly string[];
  /** The tool call whose answer the script reads (ADR-0176); absent when the call names none. */
  readonly fromToolUse?: string;
};

/** The longest tool call id a reference may carry; engine ids are far shorter. */
const MAX_TOOL_USE_ID_CHARACTERS = 256;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const INPUT_KEYS: ReadonlySet<string> = new Set(['skill', 'script', 'args', 'input']);

/**
 * `input`: absent or `null` (OpenAI's strict schema sends `null`) means no reference; otherwise
 * exactly `{ fromToolUse }`, a non-empty id without NUL.
 */
function parseReference(
  value: unknown,
):
  | { readonly ok: true; readonly fromToolUse?: string }
  | { readonly ok: false; readonly reason: string } {
  if (value === undefined || value === null) return { ok: true };
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'fromToolUse')) {
    return { ok: false, reason: 'input must be { fromToolUse: "<tool call id>" }.' };
  }
  const id = value['fromToolUse'];
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > MAX_TOOL_USE_ID_CHARACTERS ||
    id.includes('\0')
  ) {
    return { ok: false, reason: 'input.fromToolUse must be the id of an earlier tool call.' };
  }
  return { ok: true, fromToolUse: id };
}

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
      reason: `${JSON.stringify(unknownKey)} is not a field of this tool (skill, script, args, input).`,
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
  const reference = parseReference(record['input']);
  if (!reference.ok) {
    return { ok: false, refusal: 'unusable_arguments', reason: reference.reason };
  }
  return {
    ok: true,
    input: {
      skill,
      script,
      args,
      ...(reference.fromToolUse === undefined ? {} : { fromToolUse: reference.fromToolUse }),
    },
  };
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

/** Whether `real`, a resolved path, is `root` or lies under it. */
function isInside(path: SkillScriptHost['path'], root: string, real: string): boolean {
  const inside = path.relative(root, real);
  return inside === '' || (!path.isAbsolute(inside) && !/^\.\.(?:[\\/]|$)/u.test(inside));
}

/**
 * Whether the nearest existing ancestor of `relative` (itself included), links resolved, is inside
 * `root`: a link already in a parent path would otherwise carry the folder made under it out of
 * the run directory. Nothing below `root` existing means `root` itself, which is real.
 */
async function ancestorInside(
  host: SkillScriptHost,
  root: string,
  relative: string,
): Promise<boolean> {
  const segments = relative.split('/');
  for (let length = segments.length; length > 0; length -= 1) {
    let real: string;
    try {
      real = await host.realpath(host.path.join(root, ...segments.slice(0, length)));
    } catch (error) {
      if (isMissing(error)) continue;
      return false;
    }
    return isInside(host.path, root, real);
  }
  return true;
}

/**
 * Creates each writable directory (`setup.writableDirectories`, never a file grant) that does not
 * exist yet, before the process starts. Node's permission model reads an `--allow-fs-write` path
 * that is missing at start as one file, not a folder: the script may then create the folder but
 * nothing in it (`ERR_ACCESS_DENIED`). That is how a run's first `outputs/` file was refused (an
 * `office-writer` render, R1 run 44985488322): nothing makes `outputs/` before the script, since
 * `Write` there is denied to such an agent. A directory whose nearest existing ancestor resolves
 * outside `root`, or that cannot be made (a file holds the name), is left to the script, which then
 * meets the permission model's refusal and reports it as its own answer.
 */
async function makeWritableDirectories(
  host: SkillScriptHost,
  root: string,
  directories: readonly string[],
): Promise<void> {
  for (const directory of directories) {
    if (!(await ancestorInside(host, root, directory))) continue;
    try {
      await host.makeDirectory(host.path.join(root, directory));
    } catch {
      // Left to the script: its write is refused there, and the refusal is its answer.
    }
  }
}

/**
 * The answer `fromToolUse` names, as the model received it, or the refusal: no such answer in this
 * run (the refusal names the ones it holds, so the model can correct the id), an error answer, or
 * one over `maxInputBytes`. A run without a record of answers holds none.
 */
async function referencedAnswer(
  answers: ToolAnswers | undefined,
  fromToolUse: string,
  limits: SkillScriptLimits,
  signal: AbortSignal | undefined,
): Promise<{ readonly ok: true; readonly output: string } | (SkillScriptOutcome & { ok: false })> {
  const answer = (await answers?.find(fromToolUse, signal)) ?? null;
  if (answer === null) {
    const held = (answers?.held() ?? []).slice(-NAMED_ANSWERS);
    return {
      ok: false,
      refusal: 'unknown_tool_answer',
      reason: `this run received no answer to a tool call ${JSON.stringify(fromToolUse)}. ${
        held.length === 0
          ? 'It has received no tool answer yet.'
          : `Answers it holds: ${held.map((call) => `${call.toolCallId} (${call.name === '' ? 'unnamed' : call.name})`).join(', ')}.`
      }`,
    };
  }
  if (answer.isError) {
    return {
      ok: false,
      refusal: 'unusable_tool_answer',
      reason: `the answer to ${JSON.stringify(fromToolUse)} (${answer.name}) is an error, not a result a script can read.`,
    };
  }
  const bytes = new TextEncoder().encode(answer.output).length;
  if (bytes > limits.maxInputBytes) {
    return {
      ok: false,
      refusal: 'unusable_tool_answer',
      reason: `the answer to ${JSON.stringify(fromToolUse)} is ${String(bytes)} bytes; a script may be handed at most ${String(limits.maxInputBytes)}.`,
    };
  }
  return { ok: true, output: answer.output };
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
  answers?: ToolAnswers,
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
  const reference =
    input.fromToolUse === undefined
      ? null
      : await referencedAnswer(answers, input.fromToolUse, limits, signal);
  if (reference !== null && !reference.ok) return reference;
  await makeWritableDirectories(host, root, setup.writableDirectories);
  const scratch = await host.makeScratchDirectory();
  // The answer sits in a directory of its own that the process may read and never write, so the
  // script reads exactly what the model received. It is made, like `scratch`, for this call only.
  let inputDirectory: string | null = null;
  try {
    let inputFile: string | null = null;
    if (reference !== null) {
      inputDirectory = await host.makeScratchDirectory();
      inputFile = path.join(inputDirectory, INPUT_FILE);
      await host.writeFile(inputFile, reference.output);
    }
    const { stdout, stderr } = await host.execFile(
      host.execPath,
      [
        '--permission',
        `--allow-fs-read=${root}`,
        `--allow-fs-read=${scratch}`,
        ...(inputDirectory === null ? [] : [`--allow-fs-read=${inputDirectory}`]),
        `--allow-fs-write=${scratch}`,
        ...setup.writable.map((grant) => `--allow-fs-write=${path.join(root, grant)}`),
        builtinImportHook(path.join(root, setup.skillsDirectory)),
        realScript,
        ...input.args,
      ],
      {
        cwd: root,
        timeout: limits.timeoutMs,
        maxBuffer: limits.maxOutputBytes,
        env:
          inputFile === null
            ? { TMPDIR: scratch }
            : { TMPDIR: scratch, [SKILL_SCRIPT_INPUT_ENV]: inputFile },
        killSignal: 'SIGKILL',
        ...(signal === undefined ? {} : { signal }),
      },
    );
    return { ok: true, exitCode: 0, stdout, stderr };
  } catch (error) {
    return classifyFailure(error, limits);
  } finally {
    // Each directory is removed even when removing the other fails.
    try {
      await host.removeDirectory(scratch);
    } finally {
      if (inputDirectory !== null) await host.removeDirectory(inputDirectory);
    }
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
  answers?: ToolAnswers,
): Promise<{ readonly text: string; readonly isError: boolean }> {
  const parsed = parseRunSkillScriptInput(input);
  return skillScriptResultText(
    parsed.ok
      ? await runSkillScript(host, setup, parsed.input, SKILL_SCRIPT_LIMITS, signal, answers)
      : parsed,
  );
}
