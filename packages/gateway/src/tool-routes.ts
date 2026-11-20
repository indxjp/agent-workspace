import {
  GATEWAY_AW_CONTROL_PATH,
  GATEWAY_TOOL_SANDBOX_ROUTE,
  parseGatewayToolPath,
} from '@indx-workspace/contracts/tool-connectors';

import type { GatewayApplicationDependencies } from './application-dependencies.js';
import type { GatewayRouter } from './types.js';
import type { EndpointGrantCodec } from './tokens/endpoint-grant.js';
import { GATEWAY_TOOL_SANDBOX_ENDPOINT_ROUTE } from './tokens/endpoint-grant.js';
import type { RunTokenCodec } from './tokens/run-token.js';
import { handleAwControlRequest } from './tools/aw-control.js';
import { handleToolRequest } from './tools/endpoint.js';
import type { PostgresToolExecutor } from './tools/postgres.js';
import { handleEndpointToolSandboxRequest, handleToolSandboxRequest } from './tools/sandbox.js';

type ToolRouteContext = {
  readonly dependencies: GatewayApplicationDependencies;
  readonly router: GatewayRouter;
  readonly tokens: RunTokenCodec;
  readonly grants: EndpointGrantCodec;
  readonly postgres: PostgresToolExecutor;
};

/** What both tool sandbox routes forward with, each option present only when configured. */
function sandboxForwardOptions(dependencies: GatewayApplicationDependencies) {
  return {
    tokenSecret: dependencies.tokenSecret,
    ...(dependencies.runnerManagerToken === undefined
      ? {}
      : { managerToken: dependencies.runnerManagerToken }),
    ...(dependencies.toolSandboxFetch === undefined
      ? {}
      : { fetch: dependencies.toolSandboxFetch }),
    ...(dependencies.toolSandboxIdToken === undefined
      ? {}
      : { serverlessIdToken: dependencies.toolSandboxIdToken }),
  };
}

function awControlOptions(context: ToolRouteContext) {
  const { dependencies, tokens } = context;
  return {
    tokens,
    ...(dependencies.controlPlaneOrigin === undefined
      ? {}
      : { origin: dependencies.controlPlaneOrigin }),
    ...(dependencies.awControl === undefined ? {} : { runs: dependencies.awControl }),
    ...(dependencies.awControlFetch === undefined ? {} : { fetch: dependencies.awControlFetch }),
  };
}

/**
 * The tool routes, dispatched before the model boundary so they never resolve the model key and
 * are never metered (ADR-0113 C16). The returned function answers `undefined` for a path that is
 * not a tool route, and the caller then crosses the run-token boundary.
 */
export function createToolRouteDispatcher(
  context: ToolRouteContext,
): (request: Request, pathname: string) => Promise<Response> | undefined {
  const { dependencies, router, tokens, grants, postgres } = context;
  const { tools, toolSandbox } = dependencies;
  return (request, pathname) => {
    if (pathname === GATEWAY_TOOL_SANDBOX_ROUTE.path) {
      return toolSandbox === undefined
        ? router.fetch(request)
        : handleToolSandboxRequest(request, {
            tokens,
            sandbox: toolSandbox,
            ...sandboxForwardOptions(dependencies),
          });
    }
    if (pathname === GATEWAY_TOOL_SANDBOX_ENDPOINT_ROUTE.path) {
      return toolSandbox === undefined
        ? router.fetch(request)
        : handleEndpointToolSandboxRequest(request, {
            grants,
            ...sandboxForwardOptions(dependencies),
          });
    }
    // Before the connector route: `aw-control` is the platform's, so no workspace connector can
    // ever receive its calls, whatever it is named.
    if (pathname === GATEWAY_AW_CONTROL_PATH) {
      return handleAwControlRequest(request, awControlOptions(context));
    }
    const connectorId = parseGatewayToolPath(pathname);
    if (connectorId === null) return undefined;
    return tools === undefined
      ? router.fetch(request)
      : handleToolRequest(request, connectorId, { tokens, tools, postgres });
  };
}
