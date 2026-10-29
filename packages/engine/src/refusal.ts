import type { EngineRefusalCode } from './port.js';

/**
 * A refusal an adapter can only reach in {@link AgentEngine.start}: translating its own compiled
 * options into its engine's (the Claude boundary's `tools`, `skills` and MCP transports). It is
 * thrown before any frame, subprocess or SDK call, so the runner answers it exactly like a
 * `compile` refusal — its code and message on a `run-error` frame — and never as the generic
 * `run_rejected`. The message reaches the caller, so it must name no host path and no secret.
 */
export class EngineRefusalError extends Error {
  override readonly name: string = 'EngineRefusalError';
  readonly code: EngineRefusalCode;

  constructor(code: EngineRefusalCode, message: string) {
    super(message);
    this.code = code;
  }
}
