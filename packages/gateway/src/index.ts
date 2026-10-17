/**
 * `@agent-workspace/gateway` — the model gateway server, router and provider adapters.
 *
 * Production composition root for the authenticated provider gateway.
 */
import { pathToFileURL } from 'node:url';

import { openDatabaseRoot, type DatabaseRoot } from '@agent-workspace/core/db';
import { createSecretsService, type SecretsService } from '@agent-workspace/core/secrets';
import {
  GATEWAY_TOOL_ROUTE,
  GATEWAY_TOOL_SANDBOX_ROUTE,
  parseGatewayToolPath,
} from '@indx-workspace/contracts/tool-connectors';

import {
  createAuthenticatedGateway,
  type GatewayRunResolver,
  type GatewayUsageRecord,
  type RunResolution,
  type UsageRecorder,
} from './auth.js';
import {
  calculateUsageCost,
  parsePricingCatalog,
  priceFor,
  type ModelPrice,
  type PricingCatalog,
} from './pricing.js';
import {
  createProviderRegistry,
  registryProviderId,
  type ProviderRegistryOptions,
} from './providers/registry.js';
import { createRouter, ROUTES } from './router.js';
import { createGatewayServer } from './server.js';
import {
  createEndpointGrantCodec,
  GATEWAY_TOOL_SANDBOX_ENDPOINT_ROUTE,
} from './tokens/endpoint-grant.js';
import { createRunTokenCodec } from './tokens/run-token.js';
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

export type GatewayApplicationDependencies = {
  readonly resolver: GatewayRunResolver;
  readonly tokenSecret: string;
  readonly providers?: ProviderRegistryOptions;
  readonly usage?: UsageRecorder;
  readonly onUsageError?: (error: unknown) => void;
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
};

/** The application's public routes, spec §9's block: the model routes, then the tool, tool-sandbox and endpoint tool-sandbox routes. */
const GATEWAY_ROUTES: readonly GatewayRoute[] = [
  ...ROUTES,
  GATEWAY_TOOL_ROUTE,
  GATEWAY_TOOL_SANDBOX_ROUTE,
  GATEWAY_TOOL_SANDBOX_ENDPOINT_ROUTE,
];

/** Bind normalized gateway usage to the tenant-scoped, idempotent run repository. */
export function createDatabaseUsageRecorder(
  database: DatabaseRoot,
  pricing: PricingCatalog,
): UsageRecorder {
  // Best-effort: only takes effect while the run is still `pending` (see
  // `RunRepository.markAccountingFailed`), so it can never clobber usage a successful `record`
  // already settled. Failures here are swallowed — the caller's own error is what must propagate
  // to `onUsageError`, and a broken failure-mark must not mask it.
  const markFailed = async (runId: string, reason: string): Promise<void> => {
    try {
      const workspaceId = await database.findRunWorkspace(runId);
      if (workspaceId === null) return;
      const scope = await database.scopes.forWorkspaceId(workspaceId);
      if (scope === null) return;
      await database.runs.forScope(scope).markAccountingFailed(runId, reason);
    } catch {
      // Best-effort; see above.
    }
  };

  return {
    async record(usage: GatewayUsageRecord): Promise<void> {
      try {
        const workspaceId = await database.findRunWorkspace(usage.runId);
        if (workspaceId === null) {
          throw new Error(`cannot settle usage for missing run ${usage.runId}`);
        }
        const scope = await database.scopes.forWorkspaceId(workspaceId);
        if (scope === null) {
          throw new Error(`cannot settle usage for run ${usage.runId}: workspace no longer exists`);
        }
        // A missing catalogue entry is not a settlement failure (issue #134): the response is
        // still recorded, at zero cost, with the run's accounting state saying that zero is
        // unpriced rather than measured. `priceFor` fails closed for every OTHER caller — the
        // one place a missing price is expected and handled is here.
        //
        // An upstream that finished but reported no usage is priced the same way, for the same
        // reason: its zeros were never measured, so the run settles `unavailable` rather than
        // claiming a real zero-cost turn (ADR-0068 D9).
        let price: ModelPrice | null;
        try {
          price = usage.metered ? priceFor(pricing, usage.provider, usage.model) : null;
        } catch {
          price = null;
        }
        const outcome = await database.runs.forScope(scope).recordUsage(usage.runId, {
          providerResponseId: usage.providerResponseId,
          provider: usage.provider,
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
          toolCalls: usage.toolCalls,
          wireProtocol: usage.wireProtocol,
          costUsd: price === null ? '0.000000' : calculateUsageCost(price, usage),
          costCurrency: 'USD',
          priceTableVersion: price === null ? null : pricing.version,
        });
        if (outcome.kind === 'not-found') {
          throw new Error(`cannot settle usage for missing run ${usage.runId}`);
        }
        if (outcome.kind === 'price-version-conflict') {
          throw new Error(
            `run ${usage.runId} was already settled with pricing ${outcome.existingVersion}; refusing mixed pricing ${pricing.version}`,
          );
        }
      } catch (error) {
        await markFailed(usage.runId, error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
    fail(runId: string, reason: string): Promise<void> {
      return markFailed(runId, reason);
    },
  };
}

function modelConnectionSecretName(id: string): string {
  return `MODEL_CONNECTION_${id.replace(/-/g, '').toUpperCase()}`;
}

/** Resolve the token subject through tenant-scoped repositories and decrypt its one provider key. */
export function createDatabaseGatewayRunResolver(
  database: DatabaseRoot,
  secrets: SecretsService,
): GatewayRunResolver {
  return {
    async resolve(claims, tokenHash): Promise<RunResolution> {
      const scope = await database.scopes.forWorkspaceId(claims.workspaceId);
      if (scope === null) return { state: 'missing' };

      const active = await database.runTokens
        .forScope(scope)
        .isActive(claims.tokenId, claims.runId, tokenHash);
      if (!active) return { state: 'revoked' };

      const [run, agent, connection] = await Promise.all([
        database.runs.forScope(scope).get(claims.runId),
        database.agents.forScope(scope).get(claims.agentId),
        database.modelConnections.forScope(scope).get(claims.modelConnectionId),
      ]);
      if (run === null) return { state: 'missing' };
      if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
        return { state: 'revoked' };
      }
      if (agent === null || connection === null) return { state: 'deleted' };
      if (run.agentId !== claims.agentId || connection.workspaceId !== claims.workspaceId) {
        return { state: 'missing' };
      }

      const secret = await secrets.resolveByName(
        scope,
        modelConnectionSecretName(claims.modelConnectionId),
      );
      if (secret === null) return { state: 'deleted' };
      return {
        state: 'active',
        providerId: registryProviderId(connection.provider),
        connectionProvider: connection.provider,
        credential: secret.value.toString('utf8'),
        settings: connection.config,
      };
    },
  };
}

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
    resolver: createDatabaseGatewayRunResolver(database, secrets),
    tools: createDatabaseToolResolver(database, secrets),
    toolSandbox: createDatabaseToolSandboxResolver(database),
    postgres,
    tokenSecret,
    usage: createDatabaseUsageRecorder(database, pricing),
    onUsageError(error) {
      process.stderr.write(
        `gateway usage settlement failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
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
  const server = createGatewayServer(application);
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
  startGateway()
    .then((gateway) => {
      process.stdout.write(`model gateway listening on 0.0.0.0:${String(gateway.port)}\n`);
      const stop = () => void gateway.close().then(() => process.exit(0));
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `model gateway failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
