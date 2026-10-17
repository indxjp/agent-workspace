import { readFile } from 'node:fs/promises';

import type { AgentWorkspaceClient } from '@indx-workspace/sdk';
import { z } from 'zod';

import type { ParsedArguments, RepeatableValueFlag, SwitchFlag, ValueFlag } from './args.js';
import { exact, type Exact } from './inputs.js';
import { UsageError, type CliIo } from './io.js';
import type { OutputMode } from './output.js';

/** What a command sees: the client, the parsed line after its own path, and the process. */
export interface CommandContext {
  readonly client: AgentWorkspaceClient;
  /** The control plane URL the client was built for. */
  readonly baseUrl: string;
  readonly io: CliIo;
  readonly args: ParsedArguments;
  /** The words after the command's path. */
  readonly positionals: readonly string[];
  readonly mode: OutputMode;
  /** Aborted on SIGINT. Always present, so every SDK call can pass it as-is. */
  readonly signal: AbortSignal;
  readonly readStdin: (flag?: string) => Promise<string>;
}

/** A value to print, with the columns a listing shows by default; `undefined` prints nothing. */
export interface CommandResult {
  readonly value: unknown;
  readonly columns?: readonly string[];
  /** The value is printed, and is a failure: a probe that answered `ok: false` exits 1 (BH061-067). */
  readonly failed?: boolean;
}

interface CommandHeader {
  /** The words that select it: `['team', 'members', 'list']`. */
  readonly path: readonly string[];
  /** What follows the path in the help text: `<id> --file <json>`. */
  readonly usage: string;
  readonly summary: string;
}

/** A command that talks to a control plane through a client. */
export interface ApiCommand extends CommandHeader {
  readonly controlPlane?: undefined;
  /** A command that streams writes stdout itself and resolves `undefined`. */
  readonly run: (context: CommandContext) => Promise<CommandResult | undefined>;
  /**
   * `none` for a command that runs before a credential exists or manages the stored one itself
   * (`aw login`, `aw logout`): its client presents no credential at all.
   */
  readonly credential?: 'none';
}

/**
 * What a command that needs no control plane sees (issue #451): the process and the parsed line,
 * but no client and no URL, because none is resolved for it.
 */
export interface LocalCommandContext {
  readonly io: CliIo;
  readonly args: ParsedArguments;
  /** The words after the command's path. */
  readonly positionals: readonly string[];
  readonly mode: OutputMode;
  /** Aborted on SIGINT (and SIGTERM). */
  readonly signal: AbortSignal;
  readonly readStdin: (flag?: string) => Promise<string>;
  /** The directory the command runs in; `undefined` when the process has none (see `CliIo.cwd`). */
  readonly cwd: string | undefined;
}

/**
 * A command that works on the developer's machine and needs no control plane (`aw init`,
 * `aw dev`): configuration is never resolved for it and no client is built. It writes its own
 * output.
 */
export interface LocalCommand extends CommandHeader {
  readonly controlPlane: 'none';
  readonly run: (context: LocalCommandContext) => Promise<void>;
}

export type Command = ApiCommand | LocalCommand;

/** The fourth argument of {@link command} for a {@link LocalCommand}. */
export interface LocalCommandBody {
  readonly controlPlane: 'none';
  readonly run: LocalCommand['run'];
}

/**
 * A command. The path, usage and summary are literal arguments on purpose: the developer docs'
 * CLI reference is generated from these call sites (`scripts/docs/lib/render-cli.mjs`).
 */
export function command(
  path: string,
  usage: string,
  summary: string,
  run: ApiCommand['run'],
): ApiCommand;
export function command(
  path: string,
  usage: string,
  summary: string,
  body: LocalCommandBody,
): LocalCommand;
export function command(
  path: string,
  usage: string,
  summary: string,
  body: ApiCommand['run'] | LocalCommandBody,
): Command {
  const header = { path: path.split(' '), usage, summary };
  return typeof body === 'function'
    ? { ...header, run: body }
    : { ...header, controlPlane: 'none', run: body.run };
}

/** A {@link command} whose client presents no credential. */
export function credentialFreeCommand(
  path: string,
  usage: string,
  summary: string,
  run: ApiCommand['run'],
): ApiCommand {
  return { ...command(path, usage, summary, run), credential: 'none' };
}

/**
 * The flags every command takes: configuration (§7.1) and output (§7.3), as `aw --help` lists
 * them under "Configuration" and "Output".
 */
const GLOBAL_FLAGS: ReadonlySet<string> = new Set([
  'url',
  'api-key-stdin',
  'profile',
  'timeout',
  'json',
  'jsonl',
  'raw',
  'quiet',
  'help',
  'version',
]);

/**
 * The flags a command that needs no control plane takes before its own: configuration and output
 * flags would be accepted and ignored by it (roadmap §5), so only these two are global for it.
 */
const LOCAL_GLOBAL_FLAGS: ReadonlySet<string> = new Set(['help', 'version']);

/**
 * The flags a command supports: the global ones, plus every `--flag` its usage line names. The
 * usage line is the declaration, so the help text and the parser cannot disagree about what a
 * command takes.
 */
export function supportedFlags(target: Command): ReadonlySet<string> {
  const declared = new Set(target.controlPlane === 'none' ? LOCAL_GLOBAL_FLAGS : GLOBAL_FLAGS);
  for (const match of target.usage.matchAll(/--([a-z][a-z-]*)/gu)) {
    const name = match[1];
    if (name !== undefined) declared.add(name);
  }
  return declared;
}

/**
 * Refuse a flag the command does not declare. The parser's tables are global, so without this
 * `aw runs list --all` would parse and then silently print one page — an accepted-and-ignored
 * option. Refusing it with the command's usage line keeps every accepted flag meaningful.
 */
export function assertSupportedFlags(target: Command, args: ParsedArguments): void {
  const declared = supportedFlags(target);
  const given = [...args.values.keys(), ...args.switches, ...args.repeatableValues.keys()];
  const unsupported = given.filter((name) => !declared.has(name));
  if (unsupported.length === 0) return;
  const path = target.path.join(' ');
  const flags = unsupported.map((name) => `--${name}`).join(', ');
  throw new UsageError(
    `aw ${path} does not take ${flags}

Usage: aw ${path}${target.usage === '' ? '' : ` ${target.usage}`}`,
  );
}

/**
 * Issue #416: an empty or blank argument is refused here, by name, rather than sent. `aw runs
 * start ""` used to build `/api/agents//runs`, which the server redirects and then refuses with an
 * authentication error that says nothing about the empty id.
 */
export function positional(context: CommandContext, index: number, name: string): string {
  const value = context.positionals[index];
  if (value === undefined) throw new UsageError(`missing <${name}>`);
  if (value.trim() === '') throw new UsageError(`<${name}> must not be empty`);
  return value;
}

/** The value flags that name a resource by id: an empty one would build a malformed path. */
const ID_VALUE_FLAGS: ReadonlySet<ValueFlag> = new Set(['id', 'project', 'session']);

export function value(context: CommandContext, flag: ValueFlag): string | undefined {
  const given = context.args.values.get(flag);
  if (given !== undefined && ID_VALUE_FLAGS.has(flag) && given.trim() === '') {
    throw new UsageError(`--${flag} must not be empty`);
  }
  return given;
}

/**
 * A repeatable flag that a command takes once: refused when repeated or empty, the same refusals
 * a single-value id flag gets. `--agent` is repeatable only for `aw endpoint-clients`.
 */
export function singleValue(
  context: { readonly args: ParsedArguments },
  flag: RepeatableValueFlag,
): string | undefined {
  const given = context.args.repeatableValues.get(flag) ?? [];
  if (given.length > 1) throw new UsageError(`--${flag} was given more than once`);
  const only = given[0];
  if (only !== undefined && only.trim() === '') throw new UsageError(`--${flag} must not be empty`);
  return only;
}

/** Every occurrence of a repeatable flag, in the order given; `[]` when it was never given. */
export function values(context: CommandContext, flag: RepeatableValueFlag): readonly string[] {
  return context.args.repeatableValues.get(flag) ?? [];
}

/** Whether a switch was given; any command's context, with or without a control plane. */
export function isOn(context: { readonly args: ParsedArguments }, flag: SwitchFlag): boolean {
  return context.args.switches.has(flag);
}

/** A flag whose value is one of a closed set, refused by name otherwise. */
export function enumValue<const Allowed extends readonly string[]>(
  context: CommandContext,
  flag: ValueFlag,
  allowed: Allowed,
): Allowed[number] | undefined {
  const raw = value(context, flag);
  if (raw === undefined) return undefined;
  const match = allowed.find((candidate) => candidate === raw);
  if (match === undefined) {
    throw new UsageError(`--${flag} must be one of ${allowed.join(', ')}`);
  }
  return match;
}

export function integerValue(context: CommandContext, flag: ValueFlag): number | undefined {
  const raw = value(context, flag);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`--${flag} must be a positive integer`);
  }
  return parsed;
}

export function booleanWord(word: string, name: string): boolean {
  if (word === 'true') return true;
  if (word === 'false') return false;
  throw new UsageError(`<${name}> must be true or false`);
}

/** `--file <path>` reads a file, `--file -` reads stdin; `null` when neither was given. */
async function readFileFlag(context: CommandContext): Promise<string | null> {
  const source = value(context, 'file');
  if (source === undefined) return null;
  if (source === '-') return context.readStdin('--file -');
  try {
    return await readFile(source, 'utf8');
  } catch {
    throw new UsageError(`could not read ${source}`);
  }
}

function issuesOf(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join('.') || '$'}: ${issue.message}`)
    .join('; ');
}

/**
 * The body of a create or update: the JSON of `--file` (or stdin), with the scalar flags the
 * command documents laid over it, validated by `schema`. Nothing at all is a usage error, so a
 * bare `aw agents update <id>` explains itself instead of sending an empty patch.
 */
export async function readBody<Schema extends z.ZodType>(
  context: CommandContext,
  schema: Schema,
  overlay: Readonly<Record<string, unknown>> = {},
): Promise<Exact<z.output<Schema>>> {
  const text = await readFileFlag(context);
  const flagged = Object.fromEntries(
    Object.entries(overlay).filter(([, field]) => field !== undefined),
  );
  if (text === null && Object.keys(flagged).length === 0) {
    throw new UsageError('provide the body with --file <json> (or --file - for stdin)');
  }
  let json: unknown = {};
  if (text !== null) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new UsageError('the body is not JSON');
    }
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new UsageError('the body must be a JSON object');
  }
  const merged: unknown = { ...json, ...flagged };
  try {
    return exact(schema, merged);
  } catch (error) {
    if (error instanceof z.ZodError) throw new UsageError(`invalid body: ${issuesOf(error)}`);
    throw error;
  }
}

/**
 * A credential for a create or rotate: `--value-stdin` reads it from stdin, else the body must
 * carry it under `field`. A flag value is never accepted (§7.1's rule applies to every secret,
 * not only the CLI's own key).
 */
export async function readSecretOverlay(
  context: CommandContext,
  field: string,
): Promise<Readonly<Record<string, string>>> {
  return isOn(context, 'value-stdin') ? { [field]: await requireSecretFromStdin(context) } : {};
}

/** The one trailing newline a shell pipe adds is not part of a secret; anything else is. */
export async function requireSecretFromStdin(context: CommandContext): Promise<string> {
  if (!isOn(context, 'value-stdin')) {
    throw new UsageError('--value-stdin is required: the secret value is read from stdin');
  }
  const secret = (await context.readStdin('--value-stdin')).replace(/\r?\n$/u, '');
  if (secret === '') throw new UsageError('--value-stdin read an empty value');
  return secret;
}
