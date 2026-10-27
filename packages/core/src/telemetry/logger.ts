import { redacted } from './redact.js';

/**
 * The logging half of the telemetry port (F-04). Production code logs through a `Logger` it was
 * given; only a composition root or entry point chooses the implementation.
 */
export type LogLevel = 'info' | 'warn' | 'error';
export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger whose every line also carries `fields` (a `runId`, a `traceId`). */
  child(fields: LogFields): Logger;
}

export interface JsonLoggerOptions {
  /** The `service` field of every line: `web`, `runner`, `gateway`. */
  readonly service: string;
  /** Receives one finished JSON line, without a newline. Defaults to stdout, or stderr for warn/error. */
  readonly write?: (level: LogLevel, line: string) => void;
  readonly now?: () => Date;
}

// Trace ids are 16/32 hex characters, which the long-token rule below would otherwise mask.
const TRACE_KEYS = new Set(['traceId', 'spanId']);
const TRACE_ID = /^[0-9a-f]{16}(?:[0-9a-f]{16})?$/u;
const MAX_DEPTH = 4;

function errorFields(error: Error, depth: number): Record<string, unknown> {
  // No stack: an ESM frame is a `file://` URL the redactor masks anyway, and a message is enough
  // to find the throw site together with `component`/`operation`.
  return {
    name: error.name,
    message: redacted(error.message, []),
    ...(error.cause === undefined || depth >= MAX_DEPTH
      ? {}
      : { cause: safeValue(error.cause, depth + 1) }),
  };
}

/** A copy of `value` fit for a log line: strings pass through {@link redacted}, depth is bounded. */
function safeValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return redacted(value, []);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return errorFields(value, depth);
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.map((item: unknown) => safeValue(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, safeValue(item, depth + 1)]),
    );
  }
  return undefined; // functions, symbols, bigint, undefined: dropped by JSON.stringify
}

function safeFields(fields: LogFields): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      TRACE_KEYS.has(key) && typeof value === 'string' && TRACE_ID.test(value)
        ? value
        : safeValue(value, 0),
    ]),
  );
}

function defaultWrite(level: LogLevel, line: string): void {
  (level === 'info' ? process.stdout : process.stderr).write(`${line}\n`);
}

/** One JSON object per line: `time`, `level`, `service`, `msg`, then the (redacted) fields. */
export function createJsonLogger(options: JsonLoggerOptions, bound: LogFields = {}): Logger {
  const write = options.write ?? defaultWrite;
  const now = options.now ?? (() => new Date());
  const log =
    (level: LogLevel) =>
    (message: string, fields: LogFields = {}): void => {
      const fixed = { time: now().toISOString(), level, service: options.service, msg: message };
      // The fixed keys lead the line and a field cannot overwrite them.
      const line = JSON.stringify({ ...fixed, ...safeFields({ ...bound, ...fields }), ...fixed });
      try {
        write(level, line);
      } catch {
        // A log sink must never turn the thing being logged into a crash.
      }
    };
  return {
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child: (fields) => createJsonLogger(options, { ...bound, ...fields }),
  };
}
