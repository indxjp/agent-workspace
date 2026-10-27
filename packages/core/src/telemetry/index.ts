/** Fields that identify one run consistently in traces and the Runs list. */
export interface RunTelemetryAttributes {
  readonly runId: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly status: string;
  readonly durationMs: number | null;
  readonly costUsd: number | null;
}

export {
  createJsonLogger,
  type JsonLoggerOptions,
  type LogFields,
  type Logger,
  type LogLevel,
} from './logger.js';
export { redacted } from './redact.js';
export { parseTraceparent, traceHeaders, type TraceContext } from './traceparent.js';
