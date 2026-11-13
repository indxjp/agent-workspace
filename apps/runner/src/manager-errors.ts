import { type IncomingMessage, type ServerResponse } from 'node:http';
import { RuntimeRefusalError } from '@agent-workspace/runtime/driver';
import {
  ClientAbortedError,
  json,
  ManagerRequestError,
  RunnerShuttingDownError,
} from './manager-support.js';
import { ToolSandboxUnavailableError } from './tool-sandbox.js';

export function sendManagerFailure(
  req: IncomingMessage,
  res: ServerResponse,
  thrown: unknown,
): void {
  // A cleanup that failed too is logged here; the status is the operation's own failure's.
  const error = thrown instanceof AggregateError ? (thrown.errors[0] as unknown) : thrown;
  // Nobody is left to read an answer, and the client leaving is not a manager failure.
  if (error instanceof ClientAbortedError) {
    res.destroy();
    return;
  }
  if (thrown instanceof AggregateError) {
    process.stderr.write(`runner manager request failed: ${messagesOf(thrown)}\n`);
  }
  if (res.headersSent) {
    // A runtime that died mid-response leaves the client a truncated answer; say why here.
    if (!(thrown instanceof AggregateError)) {
      process.stderr.write(`runner manager request failed: ${messagesOf(error)}\n`);
    }
    res.destroy();
    return;
  }
  if (error instanceof ManagerRequestError) {
    json(res, 400, { error: error.code, message: error.message });
    return;
  }
  if (error instanceof RuntimeRefusalError) {
    json(res, 422, { error: error.code, message: error.message });
    return;
  }
  if (error instanceof ToolSandboxUnavailableError) {
    // The request log shows only the 503: the reason goes to the manager's own log. The
    // message never carries a value (see ToolSandboxUnavailableError).
    if (!(thrown instanceof AggregateError)) {
      process.stderr.write(
        `runner manager tool sandbox unavailable (${req.method ?? 'UNKNOWN'} ${requestPathOf(req)}): ${error.message}\n`,
      );
    }
    json(res, 503, { error: 'tool_sandbox_unavailable', message: error.message });
    return;
  }
  if (error instanceof RunnerShuttingDownError) {
    res.setHeader('retry-after', '5');
    json(res, 503, { error: 'runner_shutting_down', message: error.message });
    return;
  }
  if (!(thrown instanceof AggregateError)) {
    process.stderr.write(`runner manager request failed: ${messagesOf(error)}\n`);
  }
  json(res, 500, { error: 'internal_error' });
}

/** The request's path without its query, which may name a workspace. */
function requestPathOf(req: IncomingMessage): string {
  return (req.url ?? '/').split('?', 1)[0] ?? '/';
}

/** Every message an error carries, an `AggregateError`'s own and each of its errors'. */
function messagesOf(error: unknown): string {
  if (error instanceof AggregateError) {
    return [error.message, ...(error.errors as unknown[]).map(messagesOf)].join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}
