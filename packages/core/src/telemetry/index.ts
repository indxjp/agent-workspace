/** Fields that identify one run consistently in traces and the Runs list. */
export interface RunTelemetryAttributes {
  readonly runId: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly status: string;
  readonly durationMs: number | null;
  readonly costUsd: number | null;
}
