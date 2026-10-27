/**
 * `@agent-workspace/gateway` — the model gateway server, router and provider adapters.
 *
 * Production composition root for the authenticated provider gateway.
 */
import { pathToFileURL } from 'node:url';

import { openDatabaseRoot } from '@agent-workspace/core/db';
import { createSecretsService, type SecretsService } from '@agent-workspace/core/secrets';
import { createJsonLogger } from '@agent-workspace/core/telemetry';
import { startTracing } from '@agent-workspace/core/tracing';
import {
  GATEWAY_AW_CONTROL_PATH,
  GATEWAY_TOOL_ROUTE,
  GATEWAY_TOOL_SANDBOX_ROUTE,
  parseGatewayToolPath,
} from '@indx-workspace/contracts/tool-connectors';

import { createAuthenticatedGateway, type GatewayRunResolver, type UsageRecorder } from './auth.js';
import { createDatabaseGatewayRunResolver, createDatabaseUsageRecorder } from './database.js';
import { parsePricingCatalog, type PricingCatalog } from './pricing.js';
import { createProviderRegistry, type ProviderRegistryOptions } from './providers/registry.js';
import { createRouter, ROUTES } from './router.js';
import { createGatewayServer, requestLogger } from './server.js';
import {
  createEndpointGrantCodec,
  GATEWAY_TOOL_SANDBOX_ENDPOINT_ROUTE,
} from './tokens/endpoint-grant.js';
import { createRunTokenCodec } from './tokens/run-token.js';
import {
  createDatabaseAwControlResolver,
  handleAwControlRequest,
  parseControlPlaneOrigin,
  type AwControlResolver,
} from './tools/aw-control.js';
import { createDatabaseToolResolver, type ToolConnectorResolver } from './tools/authorize.js';
import { handleToolRequest } from './tools/endpoint.js';
import { createPostgresExecutor, type PostgresToolExecutor } from './tools/postgres.js';
import {
  createDatabaseToolSandboxResolver,
  handleEndpointToolSandboxRequest,
  handleToolSandboxRequest,
  type ToolSandboxResolver,
} from './tools/sandbox.js';
import type { GatewayRoute, GatewayRouter } from './types.js';

export type {
  AnthropicMessageRequest,
  GatewayRoute,
  ModelCapabilities,
  ModelProvider,
  RequestContext,
  WireProtocol,
} from './types.js';

// The router, the response-usage extractor and the authentication boundary are reachable through the
// package export so the `gateway-ingress` vector replay can drive the real implementation (decision
// D-012). The tool route's authorisation and the Node server are reachable for the same reason: the
// root `tests/gateway-tool-clients.test.ts` serves the application to the engines' MCP clients, which
// only the root tests may import. This list is exactly what those tests import: every other module
// stays internal, because a name exported here is a stability promise
// (docs/sdk/site/concepts/public-surface.mdx).
export { createRouter } from './router.js';
export { extractResponseUsage } from './usage/index.js';
export { createAuthenticatedGateway } from './auth.js';
export { createGatewayServer } from './server.js';
export { authorizeToolCall } from './tools/authorize.js';
export type {
  GatewayRunResolver,
  GatewayUsageRecord,
  RunResolution,
  UsageRecorder,
} from './auth.js';
export type { ToolConnectorResolver } from './tools/authorize.js';
export type { ToolSandboxResolver } from './tools/sandbox.js';

export const PACKAGE_NAME = '@agent-workspace/gateway';

const log = createJsonLogger({ service: 'gateway' });

export type GatewayApplicationDependencies = {
  readonly resolver: GatewayRunResolver;
  readonly tokenSecret: string;
  readonly providers?: ProviderRegistryOptions;
  readonly usage?: UsageRecorder;
  /** `request` is the one whose usage failed to settle, for its trace id. */
  readonly onUsageError?: (error: unknown, request: Request) => void;
  /** Serves `POST /v1/tools/:connectorId/mcp`. Without it that path is an unknown route. */
  readonly tools?: ToolConnectorResolver;
  /** Serves `POST /v1/tool-sandbox/mcp` and `POST /v1/tool-sandbox/endpoint/mcp`. Without it those paths are unknown routes. */
  readonly toolSandbox?: ToolSandboxResolver;
  /** Replaces the global `fetch` the tool sandbox route forwards with. */
  readonly toolSandboxFetch?: typeof fetch;
  /** The runner manager's token, for a tool sandbox the manager serves (ADR-0132). */
  readonly runnerManagerToken?: string;
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

/** The application's public routes, spec §9's block: the model routes, then the tool, tool-sandbox and endpoint tool-sandbox routes. */
const GATEWAY_ROUTES: readonly GatewayRoute[] = [
  ...ROUTES,
  GATEWAY_TOOL_ROUTE,
  GATEWAY_TOOL_SANDBOX_ROUTE,
  GATEWAY_TOOL_SANDBOX_ENDPOINT_ROUTE,
];

/** Compose the closed provider registry, router, and per-run authentication boundary. */
export function createGatewayApplication(
  dependencies: GatewayApplicationDependencies,
): GatewayRouter {
  const router = createRouter(createProviderRegistry(dependencies.providers));
  const tokens = createRunTokenCodec({ secret: dependencies.tokenSecret });
  const grants = createEndpointGrantCodec({ secret: dependencies.tokenSecret });
  const authenticated = createAuthenticatedGateway(
    router,
    tokens,
    dependencies.resolver,
    dependencies.usage,
    dependencies.onUsageError,
  );
  const { tools, toolSandbox } = dependencies;
  const postgres = dependencies.postgres ?? createPostgresExecutor();
  return {
    routes: GATEWAY_ROUTES,
    fetch(request) {
      const { pathname } = new URL(request.url);
      // Health is a process probe, not a model operation. Every provider-bearing route crosses
      // the run-token boundary below.
      if (request.method === 'GET' && pathname === '/health') {
        return router.fetch(request);
      }
      // The tool route is dispatched before the model boundary, so it never resolves the model
      // key and is never metered (ADR-0113 C16).
      if (pathname === GATEWAY_TOOL_SANDBOX_ROUTE.path) {
        return toolSandbox === undefined
          ? router.fetch(request)
          : handleToolSandboxRequest(request, {
              tokens,
              sandbox: toolSandbox,
              tokenSecret: dependencies.tokenSecret,
              ...(dependencies.runnerManagerToken === undefined
                ? {}
                : { managerToken: dependencies.runnerManagerToken }),
              ...(dependencies.toolSandboxFetch === undefined
                ? {}
                : { fetch: dependencies.toolSandboxFetch }),
            });
      }
      if (pathname === GATEWAY_TOOL_SANDBOX_ENDPOINT_ROUTE.path) {
        return toolSandbox === undefined
          ? router.fetch(request)
          : handleEndpointToolSandboxRequest(request, {
              grants,
              tokenSecret: dependencies.tokenSecret,
              ...(dependencies.runnerManagerToken === undefined
                ? {}
                : { managerToken: dependencies.runnerManagerToken }),
              ...(dependencies.toolSandboxFetch === undefined
                ? {}
                : { fetch: dependencies.toolSandboxFetch }),
            });
      }
      // Before the connector route: `aw-control` is the platform's, so no workspace connector can
      // ever receive its calls, whatever it is named.
      if (pathname === GATEWAY_AW_CONTROL_PATH) {
        return handleAwControlRequest(request, {
          tokens,
          ...(dependencies.controlPlaneOrigin === undefined
            ? {}
            : { origin: dependencies.controlPlaneOrigin }),
          ...(dependencies.awControl === undefined ? {} : { runs: dependencies.awControl }),
          ...(dependencies.awControlFetch === undefined
            ? {}
            : { fetch: dependencies.awControlFetch }),
        });
      }
      const connectorId = parseGatewayToolPath(pathname);
      if (connectorId !== null) {
        return tools === undefined
          ? router.fetch(request)
          : handleToolRequest(request, connectorId, { tokens, tools, postgres });
      }
      return authenticated.fetch(request);
    },
  };
}

export type RunningGateway = {
  readonly close: () => Promise<void>;
  readonly port: number;
};

function listen(server: ReturnType<typeof createGatewayServer>, port: number, host: string) {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function requireTokenSecret(env: Readonly<Record<string, string | undefined>>): string {
  const tokenSecret = env['GATEWAY_TOKEN_SECRET'];
  if (tokenSecret === undefined || tokenSecret.length < 32) {
    throw new Error('GATEWAY_TOKEN_SECRET must contain at least 32 characters.');
  }
  return tokenSecret;
}

export type GatewayFromEnvironment = {
  readonly application: GatewayRouter;
  readonly close: () => Promise<void>;
};

/**
 * The production gateway application and the stores behind it, composed from the environment and
 * not yet listening. `startGateway` serves it from a Node server; the Vercel Function entry serves
 * `application.fetch` directly (ADR-0126). Missing encryption, token, or database configuration
 * fails fast.
 */
export async function createGatewayFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<GatewayFromEnvironment> {
  const tokenSecret = requireTokenSecret(env);
  const controlPlaneOrigin = parseControlPlaneOrigin(env['GATEWAY_CONTROL_PLANE_ORIGIN']);
  const database = await openDatabaseRoot(env);
  let secrets: SecretsService;
  try {
    secrets = await createSecretsService(env);
  } catch (error) {
    await database.close();
    throw error;
  }
  let pricing: PricingCatalog;
  try {
    pricing = parsePricingCatalog(env['GATEWAY_PRICING_JSON']);
  } catch (error) {
    await Promise.all([database.close(), secrets.close()]);
    throw error;
  }
  const postgres = createPostgresExecutor();
  const runnerManagerToken = env['RUNNER_MANAGER_TOKEN'] ?? '';
  const application = createGatewayApplication({
    ...(runnerManagerToken === '' ? {} : { runnerManagerToken }),
    ...(controlPlaneOrigin === undefined ? {} : { controlPlaneOrigin }),
    resolver: createDatabaseGatewayRunResolver(database, secrets),
    tools: createDatabaseToolResolver(database, secrets),
    toolSandbox: createDatabaseToolSandboxResolver(database),
    awControl: createDatabaseAwControlResolver(database),
    postgres,
    tokenSecret,
    usage: createDatabaseUsageRecorder(database, pricing),
    onUsageError(error, request) {
      requestLogger(log, request).error('usage settlement failed', { error });
    },
  });
  return {
    application,
    close: async () => {
      await Promise.all([database.close(), secrets.close(), postgres.close()]);
    },
  };
}

/** Start the production gateway. Missing encryption, token, or database configuration fails fast. */
export async function startGateway(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<RunningGateway> {
  requireTokenSecret(env);
  const portText = env['PORT'] ?? '4000';
  const port = /^\d+$/.test(portText) ? Number(portText) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer from 1 through 65535.');
  }
  const host = env['HOST'] ?? '0.0.0.0';

  const { application, close: closeStores } = await createGatewayFromEnvironment(env);
  const server = createGatewayServer(application, undefined, log);
  try {
    await listen(server, port, host);
  } catch (error) {
    await closeStores();
    throw error;
  }

  let closed = false;
  return {
    port,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      await closeStores();
    },
  };
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  startTracing('agent-workspace-gateway', process.env, log)
    .then(async (tracing) => {
      const gateway = await startGateway();
      log.info('model gateway listening', { port: gateway.port });
      const stop = () =>
        void gateway
          .close()
          .then(() => tracing?.shutdown())
          .catch((error: unknown) => log.error('model gateway did not close cleanly', { error }))
          .then(() => process.exit(0));
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    })
    .catch((error: unknown) => {
      log.error('model gateway failed to start', { error });
      process.exitCode = 1;
    });
}
