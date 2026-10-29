import { parseArgs } from 'node:util';

import { SETUP_QUESTIONS, type SetupAnswers } from '@indx-workspace/contracts/setup';
import { parseSetupFlags, setupFlagsHelp } from '@indx-workspace/sdk/project';

import { CreateUsageError, errorCode } from '../cli-failure.ts';
import { DEPLOYMENT_CLOUDS, type DeploymentCloud } from '../profile.ts';

export interface GeneratorAnswers {
  readonly database: string;
  readonly storage: string;
  readonly runtime: string;
  readonly authentication: string;
}

/**
 * The defaults the generator offers, worded as what the generated Compose project runs: PostgreSQL
 * in its own container, and files on the web service's Docker volume (#396). A PostgreSQL 17
 * answer, including the older "embedded PostgreSQL 17", is refused by name (ADR-0159).
 */
export const DEFAULT_ANSWERS: GeneratorAnswers = {
  database: 'PostgreSQL 18 (container)',
  storage: 'local filesystem (Docker volume)',
  runtime: 'docker',
  authentication: 'local administrator',
};

/** `create <dir> [--yes]`: the v2 project `aw dev` runs (S1-16). */
export interface CreateProjectArguments {
  readonly kind: 'project';
  readonly target: string;
  /** Take the recommended setup answers and write without asking. */
  readonly yes: boolean;
  /** The questions the setup flags already answered (issue #689). */
  readonly answers: SetupAnswers;
  /** Whether a directory was given; without one the name is asked, or `DEFAULT_TARGET` is used. */
  readonly named: boolean;
  /** `--install` / `--no-install`; `undefined` is not decided (ask on a terminal). */
  readonly install: boolean | undefined;
  /** `--start` / `--no-start`; `undefined` is not decided (ask on a terminal). */
  readonly start: boolean | undefined;
  /** `--answers <file>`: setup answers keyed by question id, under the flags (#879). */
  readonly answersFile: string | undefined;
}

/** `create --help`: the usage text, generated from the setup questions. */
export interface CreateHelpArguments {
  readonly kind: 'help';
}

/** `create <dir> --cloud <cloud> [--validate]`: the deployment project, unchanged since v1. */
export interface CreateDeploymentArguments {
  readonly kind: 'deployment';
  readonly target: string;
  readonly cloud: DeploymentCloud;
  /** Whether to run the connectivity probes against the generated profile. */
  readonly validate: boolean;
  /** `--yes` with `--cloud local`: take the default of every generator question no flag answered. */
  readonly yes: boolean;
  /** The `--database`, `--storage`, `--runtime` and `--auth` flags given (`--cloud local` only). */
  readonly generator: Partial<GeneratorAnswers>;
  /** `--port` with `--cloud local`: the host port the web service is published on. */
  readonly port?: number;
}

export type CreateCommandArguments =
  CreateProjectArguments | CreateDeploymentArguments | CreateHelpArguments;

export const DEFAULT_TARGET = 'my-agent';
export const CONTROL_CHARACTER = /\p{Cc}/u;

/** The usage `create --help` prints; the setup flags are listed from the question set. */
export function createHelp(): string {
  return [
    'Usage: npm create @indx-workspace <dir> -- [options]',
    '',
    'Writes a project that `aw dev` runs. Each setup question can be answered by a flag; the',
    'rest are asked on a terminal, and take their default with no terminal or with --yes.',
    '',
    'Options:',
    '  --yes       take the default for every question not answered by a flag, ask nothing,',
    '              install the dependencies, and do not start the dev server',
    '  --answers <file>   setup answers in a YAML or JSON file, keyed by question id; flags win',
    '  --install / --no-install   install the dependencies after writing (asked on a terminal)',
    '  --start / --no-start       run `dev` after installing (asked on a terminal); it stays in',
    '                             the foreground until Ctrl-C and create exits with its code',
    '  --help      print this text',
    '',
    'With no terminal, or with CI set, nothing is asked: flags, --answers and defaults are used.',
    '',
    'Setup flags:',
    ...setupFlagsHelp(),
    '',
    'Deployment project (v1):',
    `  --cloud <${DEPLOYMENT_CLOUDS.join(' | ')}>`,
    '  --validate  with --cloud, probe the generated stores',
    '  --yes       with --cloud local, take the default of every question below',
    '  --port <n>  with --cloud local, publish the web service on this host port (default 3000)',
    '  --database <text>, --storage <text>, --runtime <text>, --auth <text>',
    `              with --cloud local, answer the question of that name (defaults: ${Object.values(DEFAULT_ANSWERS).join('; ')})`,
    '',
  ].join('\n');
}

/** The flag of each generator question, and the answer it sets. */
const GENERATOR_FLAGS = [
  ['database', 'database'],
  ['storage', 'storage'],
  ['runtime', 'runtime'],
  ['auth', 'authentication'],
] as const;

const PARSE_ARGS_OPTIONS = {
  cloud: { type: 'string' },
  validate: { type: 'boolean' },
  install: { type: 'boolean' },
  start: { type: 'boolean' },
  yes: { type: 'boolean' },
  help: { type: 'boolean' },
  answers: { type: 'string' },
  database: { type: 'string' },
  storage: { type: 'string' },
  runtime: { type: 'string' },
  auth: { type: 'string' },
  port: { type: 'string' },
  ...Object.fromEntries(SETUP_QUESTIONS.map((question) => [question.flag, { type: 'string' }])),
} as const;

/** `parseArgs`' own refusals, in create's wording. */
function parseArgsFailure(error: unknown): CreateUsageError {
  const message = error instanceof Error ? error.message : String(error);
  const option = /(--?[\w-]+)/u.exec(message)?.[1] ?? '';
  switch (errorCode(error)) {
    case 'ERR_PARSE_ARGS_UNKNOWN_OPTION':
      return new CreateUsageError(`Unknown option ${JSON.stringify(option)}.`);
    case 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE':
      if (
        PARSE_ARGS_OPTIONS[option.slice(2) as keyof typeof PARSE_ARGS_OPTIONS]?.type === 'boolean'
      ) {
        return new CreateUsageError(`${option} takes no value.`);
      }
      return new CreateUsageError(
        `${option} needs a value` +
          (option === '--cloud' ? `: ${DEPLOYMENT_CLOUDS.join(', ')}` : '') +
          '.',
      );
    default:
      return new CreateUsageError(message);
  }
}

/**
 * Parse `<dir> [--yes] [--answers <file>] [--<setup flag> <answer>]…`, `<dir> --cloud
 * aws|gcp|azure|local [--validate]` or `--help`.
 *
 * An unrecognised flag is refused rather than ignored: silently dropping `--clod gcp` would
 * generate a project the operator did not ask for. For the same reason no option is accepted in a
 * combination that would ignore it: the setup flags and `--answers` answer the v2 project's
 * questions, which a `--cloud` project does not ask; `--database`, `--storage`, `--runtime`,
 * `--auth` and (with a cloud) `--yes` answer the four questions of `--cloud local` only; and
 * `--validate` probes the stores only a `--cloud` project names. A setup flag's value is parsed
 * with the question's own answer schema.
 */
export function parseCreateArguments(argv: readonly string[]): CreateCommandArguments {
  let values: ReturnType<typeof parseArgs>['values'];
  let positionals: readonly string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      options: PARSE_ARGS_OPTIONS,
      allowPositionals: true,
      allowNegative: true,
    }));
  } catch (error) {
    throw parseArgsFailure(error);
  }
  const flag = (name: string): string | boolean | undefined => {
    const given = values[name];
    return typeof given === 'string' || typeof given === 'boolean' ? given : undefined;
  };
  if (flag('help') === true) return { kind: 'help' };
  const [target, extra] = positionals;
  if (extra !== undefined)
    throw new CreateUsageError(`Unexpected extra argument ${JSON.stringify(extra)}.`);
  const answersFlag = flag('answers');
  const parsed: ParsedFlags = {
    validate: flag('validate') === true,
    yes: flag('yes') === true,
    answersFile: typeof answersFlag === 'string' ? answersFlag : undefined,
    generator: generatorFlags(flag),
    answers: setupFlags(values),
    cloud: cloudFlag(flag('cloud')),
    install: flag('install') as boolean | undefined,
    start: flag('start') as boolean | undefined,
  };
  if (parsed.start === true && parsed.install === false) {
    throw new CreateUsageError(
      '--start runs the project after its dependencies are installed; drop --no-install.',
    );
  }
  const directory = target ?? DEFAULT_TARGET;
  // A control character in the name is never a directory anyone meant, and a newline in it would
  // let the name forge lines of create's own output ("Created …").
  if (CONTROL_CHARACTER.test(directory)) {
    throw new CreateUsageError(
      `${JSON.stringify(directory)} holds a control character; choose a directory name without one.`,
    );
  }
  const portFlag = flag('port');
  if (portFlag !== undefined && parsed.cloud !== 'local') {
    throw new Error(
      '--port publishes the web service of the Compose project; pass it with --cloud local.',
    );
  }
  const port = typeof portFlag === 'string' ? parsePort(portFlag) : undefined;
  return parsed.cloud === null
    ? projectArguments(parsed, directory, target !== undefined)
    : deploymentArguments(parsed, parsed.cloud, directory, port);
}

/** The flags `parseCreateArguments` read, before they are checked against each other. */
interface ParsedFlags {
  readonly validate: boolean;
  readonly yes: boolean;
  readonly answersFile: string | undefined;
  readonly generator: { -readonly [K in keyof GeneratorAnswers]?: string };
  readonly answers: SetupAnswers;
  readonly cloud: DeploymentCloud | null;
  readonly install: boolean | undefined;
  readonly start: boolean | undefined;
}

function generatorFlags(
  flag: (name: string) => string | boolean | undefined,
): ParsedFlags['generator'] {
  const generator: { -readonly [K in keyof GeneratorAnswers]?: string } = {};
  for (const [name, key] of GENERATOR_FLAGS) {
    const given = flag(name);
    if (typeof given === 'string') generator[key] = given;
  }
  return generator;
}

function setupFlags(values: ReturnType<typeof parseArgs>['values']): SetupAnswers {
  try {
    return parseSetupFlags(
      Object.fromEntries(
        SETUP_QUESTIONS.map((question) => {
          const given = values[question.flag];
          return [question.flag, typeof given === 'string' ? given : undefined] as const;
        }),
      ),
    );
  } catch (error) {
    // A setup flag with a value it does not accept is a usage error, as in `aw init` (BH061-043).
    throw new CreateUsageError(error instanceof Error ? error.message : String(error));
  }
}

function cloudFlag(requested: string | boolean | undefined): DeploymentCloud | null {
  if (typeof requested !== 'string') return null;
  const cloud = DEPLOYMENT_CLOUDS.find((candidate) => candidate === requested);
  if (cloud === undefined) {
    throw new CreateUsageError(
      `Unsupported --cloud ${JSON.stringify(requested)}. ` +
        `Choose one of ${DEPLOYMENT_CLOUDS.join(', ')}.`,
    );
  }
  return cloud;
}

/** Without `--cloud`: the v2 project, which the deployment-only flags would be ignored by. */
function projectArguments(
  parsed: ParsedFlags,
  directory: string,
  named: boolean,
): CreateProjectArguments {
  if (parsed.validate) {
    throw new CreateUsageError(
      '--validate probes the stores of a deployment project; pass it with ' +
        `--cloud ${DEPLOYMENT_CLOUDS.join('|')}.`,
    );
  }
  if (Object.keys(parsed.generator).length > 0) {
    throw new CreateUsageError(
      '--database, --storage, --runtime and --auth answer the questions of the Compose ' +
        'project; pass them with --cloud local.',
    );
  }
  return {
    kind: 'project',
    target: directory,
    yes: parsed.yes,
    answers: parsed.answers,
    named,
    // --start needs the dependencies, so it implies --install unless that was refused above.
    install: parsed.start === true ? true : parsed.install,
    start: parsed.start,
    answersFile: parsed.answersFile,
  };
}

/** With `--cloud`: a deployment project, which the v2 project's flags would be ignored by. */
function deploymentArguments(
  parsed: ParsedFlags,
  cloud: DeploymentCloud,
  directory: string,
  port: number | undefined,
): CreateDeploymentArguments {
  if (parsed.install !== undefined || parsed.start !== undefined) {
    throw new CreateUsageError(
      '--install and --start belong to the project create writes without --cloud.',
    );
  }
  if (Object.keys(parsed.answers).length > 0 || parsed.answersFile !== undefined) {
    throw new CreateUsageError(
      'The setup flags and --answers answer the questions of the project create writes without ' +
        '--cloud; ' +
        (cloud === 'local'
          ? '--cloud local asks four of its own: answer them with --database, --storage, ' +
            '--runtime and --auth, or take the defaults with --yes. '
          : `--cloud ${cloud} asks no setup questions. `) +
        'Pass one or the other.',
    );
  }
  if (parsed.yes && cloud !== 'local') {
    throw new CreateUsageError(
      `--yes answers questions; --cloud ${cloud} asks no setup questions.`,
    );
  }
  if (cloud !== 'local' && Object.keys(parsed.generator).length > 0) {
    throw new CreateUsageError(
      `--database, --storage, --runtime and --auth answer the questions of --cloud local; --cloud ${cloud} asks none.`,
    );
  }
  return {
    kind: 'deployment',
    target: directory,
    cloud,
    validate: parsed.validate,
    yes: parsed.yes,
    generator: parsed.generator,
    ...(port === undefined ? {} : { port }),
  };
}

/** A TCP port, written in decimal: `--port 3000x` or `--port 0` is refused, never truncated. */
function parsePort(value: string): number {
  const port = /^[1-9][0-9]{0,4}$/u.test(value) ? Number(value) : Number.NaN;
  if (!(port <= 65_535)) {
    throw new Error(
      `--port ${JSON.stringify(value)} is not a port; give a number from 1 to 65535.`,
    );
  }
  return port;
}
