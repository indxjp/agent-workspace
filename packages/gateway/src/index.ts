/**
 * `@agent-workspace/gateway` — the model gateway server, router and provider adapters.
 *
 * Production composition root for the authenticated provider gateway.
 */
import { pathToFileURL } from 'node:url';

import { createJsonLogger } from '@agent-workspace/core/telemetry';
import { startTracing } from '@agent-workspace/core/tracing';
import {
  GATEWAY_TOOL_ROUTE,
  GATEWAY_TOOL_SANDBOX_ROUTE,
} from '@indx-workspace/contracts/tool-connectors';

import type { GatewayApplicationDependencies } from './application-dependencies.js';
import { createAuthenticatedGateway, firstRefusalOf, type GatewayAdmission } from './auth.js';
import {
  createDatabaseApplicationDependencies,
  openGatewayStores,
} from './database-dependencies.js';
import { createProviderRegistry } from './providers/registry.js';
import { createRouter, ROUTES } from './router.js';
import { createGatewayServer } from './server.js';
import {
  createEndpointGrantCodec,
  GATEWAY_TOOL_SANDBOX_ENDPOINT_ROUTE,
} from './tokens/endpoint-grant.js';
import { createRunTokenCodec } from './tokens/run-token.js';
import { createPostgresExecutor } from './tools/postgres.js';
import { createGoogleAdcTokenSource } from './providers/google-adc-token.js';
import { createToolRouteDispatcher } from './tool-routes.js';
import {
  readGatewayServerSettings,
  readGatewaySettings,
  type GatewaySettings,
  startFailureFields,
} from './settings.js';
import type { GatewayRoute, GatewayRouter, TokenSource } from './types.js';

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

export type { GatewayApplicationDependencies } from './application-dependencies.js';

export const PACKAGE_NAME = '@agent-workspace/gateway';

const log = createJsonLogger({ service: 'gateway' });

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
    undefined,
    // ADR-0162 decision 1: the run ceiling needs no read of its own, so it is asked first.
    firstRefusalOf(
      [dependencies.runCeiling, dependencies.dailyCost].filter(
        (admission): admission is GatewayAdmission => admission !== undefined,
      ),
    ),
  );
  const dispatchToolRoute = createToolRouteDispatcher({
    dependencies,
    router,
    tokens,
    grants,
    postgres: dependencies.postgres ?? createPostgresExecutor(),
  });
  return {
    routes: GATEWAY_ROUTES,
    fetch(request) {
      const { pathname } = new URL(request.url);
      // Health is a process probe, not a model operation. Every provider-bearing route crosses
      // the run-token boundary below.
      if (request.method === 'GET' && pathname === '/health') {
        return router.fetch(request);
      }
      const toolResponse = dispatchToolRoute(request, pathname);
      return toolResponse ?? authenticated.fetch(request);
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
  /**
   * The cloud identity keyless (`vertex`) connections use. Together with `GATEWAY_VERTEX_PROJECT_ID`,
   * the one project it may act on, it enables them; without either they are refused with a 503.
   */
  tokens?: TokenSource,
): Promise<GatewayFromEnvironment> {
  // Every setting is parsed before the database opens, so a bad value stops start-up without a
  // connection and names each refused variable (refactoring part 03).
  return await createGatewayFromSettings(readGatewaySettings(env), env, tokens);
}

/**
 * {@link createGatewayFromEnvironment} over settings already parsed. `env` is passed on only to the
 * database and the master key, whose readers live in `packages/core`.
 */
async function createGatewayFromSettings(
  settings: GatewaySettings,
  env: Readonly<Record<string, string | undefined>>,
  tokens: TokenSource | undefined,
): Promise<GatewayFromEnvironment> {
  const stores = await openGatewayStores(env);
  const application = createGatewayApplication(
    createDatabaseApplicationDependencies({ settings, tokens, log, ...stores }),
  );
  return {
    application,
    close: async () => {
      await Promise.all([stores.database.close(), stores.secrets.close(), stores.postgres.close()]);
    },
  };
}

/** Start the production gateway. Missing encryption, token, or database configuration fails fast. */
export async function startGateway(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<RunningGateway> {
  const {
    gateway: settings,
    listen: { host, port },
  } = readGatewayServerSettings(env);

  const { application, close: closeStores } = await createGatewayFromSettings(
    settings,
    env,
    // Keyless connections are opt-in: only a deployment that names its project gets the identity.
    settings.vertexProjectId === undefined ? undefined : createGoogleAdcTokenSource(),
  );
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
      log.error('model gateway failed to start', startFailureFields(error));
      process.exitCode = 1;
    });
}
