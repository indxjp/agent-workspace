import {
  ApiProblemError,
  ContractsVersionUnsupportedError,
  ContractViolationError,
  InvalidArgumentError,
  TransportError,
} from '@indx-workspace/sdk';

import type { ParsedArguments } from './args.js';
import { isLoopbackUrl } from './config.js';
import {
  ChangesPendingError,
  CommandRefusedError,
  InterruptedError,
  PlatformFieldsDroppedError,
  RunFailedError,
  UsageError,
  type CliIo,
} from './io.js';
import { contractsVersionRefusalText } from './version.js';

/**
 * §7.3: `0` success, `1` a refused request, `2` usage, `3` drift (also `aw deploy`'s pending
 * changes), `4` no response, `5` `--strict` found dropped fields (aw platforms), `130` SIGINT.
 */
export const EXIT_CODE = {
  ok: 0,
  problem: 1,
  usage: 2,
  contract: 3,
  transport: 4,
  dropped: 5,
  interrupted: 130,
} as const;

export type ExitCode = (typeof EXIT_CODE)[keyof typeof EXIT_CODE];

/** How stdout is rendered: the table is the default, the rest are opt-in switches. */
export interface OutputMode {
  /** Exactly the SDK's returned value, as JSON. */
  readonly json: boolean;
  /** One JSON object per line; streams honour it, and a listing prints one row per line. */
  readonly jsonl: boolean;
  /** Streams print the classified frames instead of the neutral `AgentEvent` view. */
  readonly raw: boolean;
  /** No informational notices on stderr. */
  readonly quiet: boolean;
}

export function outputMode(args: ParsedArguments): OutputMode {
  return {
    json: args.switches.has('json'),
    jsonl: args.switches.has('jsonl'),
    raw: args.switches.has('raw'),
    quiet: args.switches.has('quiet'),
  };
}

type Row = Readonly<Record<string, unknown>>;

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function padded(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** Aligned columns with a header and a rule; the last column is never padded. */
export function renderTable(rows: readonly Row[], columns: readonly string[]): string {
  const cells = rows.map((row) => columns.map((column) => cell(row[column])));
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...cells.map((line) => line[index]?.length ?? 0)),
  );
  const line = (parts: readonly string[]): string =>
    parts
      .map((part, index) => (index === parts.length - 1 ? part : padded(part, widths[index] ?? 0)))
      .join('  ')
      .trimEnd();
  return [line(columns), line(widths.map((width) => '-'.repeat(width))), ...cells.map(line)].join(
    '\n',
  );
}

/** One resource as a `field  value` listing, in the contract's field order. */
export function renderRecord(row: Row): string {
  const keys = Object.keys(row);
  const width = Math.max(0, ...keys.map((key) => key.length));
  return keys.map((key) => `${padded(key, width)}  ${cell(row[key])}`.trimEnd()).join('\n');
}

/**
 * The human rendering of any value a command returns: a listing as a table (with the columns
 * the command chose, else every field of the first row), one resource as a record, a list of
 * scalars one per line, a scalar as itself, and nothing for `undefined`/`null`.
 */
export function renderHuman(value: unknown, columns: readonly string[] | undefined): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    if (items.length === 0) return '(none)';
    const rows = items.filter(isRow);
    if (rows.length === items.length) {
      const first = rows[0];
      return renderTable(rows, columns ?? (first === undefined ? [] : Object.keys(first)));
    }
    return items.map(cell).join('\n');
  }
  if (isRow(value)) return renderRecord(value);
  return cell(value);
}

/** Write a command's result to stdout in the selected mode. Nothing is written for `undefined`. */
export function writeResult(
  io: CliIo,
  mode: OutputMode,
  value: unknown,
  columns?: readonly string[],
): void {
  if (value === undefined) return;
  if (mode.jsonl && Array.isArray(value)) {
    const items: readonly unknown[] = value;
    for (const item of items) io.stdout(`${JSON.stringify(item)}\n`);
    return;
  }
  if (mode.jsonl) {
    // An envelope (`{ runs, nextCursor }`) is one object, so one line.
    io.stdout(`${JSON.stringify(value)}\n`);
    return;
  }
  if (mode.json) {
    io.stdout(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  const text = renderHuman(value, columns);
  if (text !== '') io.stdout(`${text}\n`);
}

/** An informational line for a human, suppressed by `--quiet` and never mixed into stdout. */
export function notice(io: CliIo, mode: OutputMode, text: string): void {
  if (!mode.quiet) io.stderr(`${text}\n`);
}

/** Issue #661: the variable `aw dev` makes the `default` connection from. */
const MODEL_KEY_FIX =
  'on aw dev, set ANTHROPIC_API_KEY to a valid Anthropic key and restart aw dev; ' +
  "elsewhere, set the model connection's key under Models";

/** Issue #661: a provider that could not be connected to — the key is not the problem. */
const MODEL_REACH_FIX =
  "check the model connection's base URL and that this host can reach the provider " +
  '(network, proxy, DNS), then retry';

/** The `fix:` line a model-setup code gets (issue #661), or `undefined` for any other code. */
export function modelFixFor(code: string | null): string | undefined {
  switch (code) {
    case 'model_connection_unresolved':
    case 'model_credential_rejected':
      return MODEL_KEY_FIX;
    case 'model_connection_failed':
      return MODEL_REACH_FIX;
    default:
      return undefined;
  }
}

/**
 * BH061-017: `aw dev`'s own key may not administer API keys, users or memberships; the person who
 * started it can, in the console it serves.
 */
const LOCAL_KEY_FIX =
  "sign in to aw dev's console in a browser and use Administration → API Keys (/admin/api-keys), " +
  'or run this with an owner or admin key in AGENT_WORKSPACE_API_KEY';

function printFix(io: CliIo, code: string | null): void {
  const fix = code === 'local_runtime_key_not_permitted' ? LOCAL_KEY_FIX : modelFixFor(code);
  if (fix !== undefined) io.stderr(`fix: ${fix}\n`);
}

/**
 * Map a failure to the message on stderr and the exit code. `interrupted` is whether SIGINT
 * arrived — a timeout also aborts a request, and that is a transport failure, not an interrupt.
 * The SDK's failure classes carry their own classification. A usage error is the CLI's, and an
 * argument the SDK refused before any request (`InvalidArgumentError`, issue #496) is usage too:
 * its message already names the refused value. Anything else is reported as unexpected with the
 * problem exit code, because it is neither drift nor a transport fault.
 */
export function reportFailure(
  io: CliIo,
  error: unknown,
  interrupted: boolean,
  /** The control plane URL the command was sent to, once one was resolved. */
  url?: string,
): ExitCode {
  if (interrupted || error instanceof InterruptedError) {
    io.stderr('interrupted\n');
    return EXIT_CODE.interrupted;
  }
  if (error instanceof CommandRefusedError) {
    io.stderr(`error: ${error.message}\n`);
    if (error.fix !== undefined) io.stderr(`fix: ${error.fix}\n`);
    return EXIT_CODE.problem;
  }
  if (error instanceof UsageError || error instanceof InvalidArgumentError) {
    io.stderr(`error: ${error.message}\n`);
    if (error instanceof UsageError && error.fix !== undefined) io.stderr(`fix: ${error.fix}\n`);
    io.stderr('run "aw --help" for usage\n');
    return EXIT_CODE.usage;
  }
  if (error instanceof ChangesPendingError) {
    io.stderr(`error: ${error.message}\n`);
    return EXIT_CODE.contract;
  }
  if (error instanceof PlatformFieldsDroppedError) {
    io.stderr(`error: ${error.message}\n`);
    return EXIT_CODE.dropped;
  }
  if (error instanceof RunFailedError) {
    io.stderr(`error: ${error.code ?? 'run_failed'}: ${error.message}\n`);
    printFix(io, error.code);
    return EXIT_CODE.problem;
  }
  if (error instanceof ContractsVersionUnsupportedError) {
    io.stderr(contractsVersionRefusalText(error));
    return EXIT_CODE.problem;
  }
  if (error instanceof ApiProblemError) {
    io.stderr(`error: ${error.code}: ${error.message}\n`);
    for (const detail of error.details) io.stderr(`  ${detail}\n`);
    printFix(io, error.code);
    return EXIT_CODE.problem;
  }
  if (error instanceof ContractViolationError) {
    io.stderr(`error: contract_violation: ${error.message}\n`);
    return EXIT_CODE.contract;
  }
  if (error instanceof TransportError) {
    io.stderr(`error: transport: ${error.message}\n`);
    // BH061-040: a local runtime that is not running is the usual reason for a loopback URL.
    if (!error.aborted && url !== undefined && isLoopbackUrl(url)) {
      io.stderr(
        `fix: nothing answers at ${url}: start the local runtime with npm run dev (aw dev)\n`,
      );
    }
    return EXIT_CODE.transport;
  }
  io.stderr(`error: unexpected: ${error instanceof Error ? error.message : String(error)}\n`);
  return EXIT_CODE.problem;
}
