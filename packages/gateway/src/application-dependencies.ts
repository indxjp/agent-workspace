import type { GatewayAdmission, GatewayRunResolver, UsageRecorder } from './auth.js';
import type { ProviderRegistryOptions } from './providers/registry.js';
import type { AwControlResolver } from './tools/aw-control.js';
import type { ToolConnectorResolver } from './tools/authorize.js';
import type { PostgresToolExecutor } from './tools/postgres.js';
import type { ToolSandboxResolver } from './tools/sandbox.js';

export type GatewayApplicationDependencies = {
  readonly resolver: GatewayRunResolver;
  readonly tokenSecret: string;
  readonly providers?: ProviderRegistryOptions;
  readonly usage?: UsageRecorder;
  /** `request` is the one whose usage failed to settle, for its trace id. */
  readonly onUsageError?: (error: unknown, request: Request) => void;
  /** Refuses a model call of a run that has spent its spend ceiling (ADR-0162); asked first. */
  readonly runCeiling?: GatewayAdmission;
  /** Refuses a model call over the workspace's daily cost cap; without it no call is gated. */
  readonly dailyCost?: GatewayAdmission;
  /** Serves `POST /v1/tools/:connectorId/mcp`. Without it that path is an unknown route. */
  readonly tools?: ToolConnectorResolver;
  /** Serves `POST /v1/tool-sandbox/mcp` and `POST /v1/tool-sandbox/endpoint/mcp`. Without it those paths are unknown routes. */
  readonly toolSandbox?: ToolSandboxResolver;
  /** Replaces the global `fetch` the tool sandbox route forwards with. */
  readonly toolSandboxFetch?: typeof fetch;
  /** The runner manager's token, for a tool sandbox the manager serves (ADR-0132). */
  readonly runnerManagerToken?: string;
  /** Mints the Google ID token a Cloud Run tool sandbox (`*.run.app`) requires; see `GATEWAY_TOOL_SANDBOX_AUTH`. */
  readonly toolSandboxIdToken?: (audience: string) => Promise<string>;
  /** Runs `postgres` tool calls and owns their pools; one is created when this is omitted. */
  readonly postgres?: PostgresToolExecutor;
  /**
   * The control plane's origin, set at deploy time and parsed by `parseControlPlaneOrigin`. Without
   * it, or without `awControl`, every `POST /v1/tools/aw-control/mcp` is refused.
   */
  readonly controlPlaneOrigin?: string;
  /** Authorises a run token for `aw-control`, on every request. */
  readonly awControl?: AwControlResolver;
  /** Replaces the global `fetch` the `aw-control` route forwards with. */
  readonly awControlFetch?: typeof fetch;
};
