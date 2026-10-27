/**
 * `POST /v1/tools/:connectorId/mcp` (ADR-0113 C16): a stateless streamable-HTTP MCP endpoint for
 * one tool connector, authenticated by the run token. Every request re-runs C16 through the
 * resolver, builds a fresh server and transport, and never reaches the model resolver, the model
 * key or the usage recorder.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { verifyRunToken } from '../auth.js';
import type { RunTokenCodec } from '../tokens/run-token.js';
import type { ToolConnectorResolver, ToolRefusal } from './authorize.js';
import { callTool, listTools, type ToolCallOptions } from './openapi.js';
import { listPostgresTools, type PostgresToolExecutor } from './postgres.js';

export type ToolEndpointDependencies = {
  readonly tokens: RunTokenCodec;
  readonly tools: ToolConnectorResolver;
  readonly postgres: PostgresToolExecutor;
  readonly options?: ToolCallOptions;
};

const REFUSAL_MESSAGES: Readonly<Record<ToolRefusal['code'], string>> = {
  tool_run_not_active: 'The run named by this gateway token is not active.',
  tool_not_in_run: 'This run cannot use the requested tool connector.',
};

function refusal({ status, code }: ToolRefusal): Response {
  return Response.json(
    {
      type: 'error',
      error: {
        type: status === 401 ? 'authentication_error' : 'permission_error',
        code,
        message: REFUSAL_MESSAGES[code],
      },
    },
    { status },
  );
}

function methodNotAllowed(method: string): Response {
  return Response.json(
    {
      type: 'error',
      error: {
        type: 'method_not_allowed',
        message: `${method} is not allowed for a tool connector; this endpoint is stateless.`,
      },
    },
    { status: 405, headers: { allow: 'POST' } },
  );
}

/** Serve one MCP request for `connectorId`. */
export async function handleToolRequest(
  request: Request,
  connectorId: string,
  dependencies: ToolEndpointDependencies,
): Promise<Response> {
  if (request.method.toUpperCase() !== 'POST') return methodNotAllowed(request.method);
  const verified = await verifyRunToken(request, dependencies.tokens);
  if (!verified.ok) return verified.response;
  const resolved = await dependencies.tools.resolve(
    verified.claims,
    verified.tokenHash,
    connectorId,
  );
  if (!resolved.ok) return refusal(resolved);
  const { connector } = resolved;

  const mcp = new McpServer(
    { name: 'agent-workspace-tools', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools:
      connector.kind === 'postgres'
        ? listPostgresTools(connector.config)
        : listTools(connector.config, connector.parameters),
  }));
  mcp.server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      if (connector.kind === 'postgres') {
        return await dependencies.postgres.call(
          connectorId,
          connector.config,
          connector.credential,
          params.name,
          params.arguments,
        );
      }
      return await callTool(
        connector.config,
        connector.parameters,
        connector.credential,
        params.name,
        params.arguments,
        {
          ...dependencies.options,
          ...(connector.approval === undefined ? {} : { approval: connector.approval }),
          ...(connector.identity === undefined ? {} : { identity: connector.identity }),
        },
      );
    } catch {
      // The SDK would answer a thrown error with its message, which may name a secret or a host.
      throw new McpError(ErrorCode.InternalError, 'The gateway request failed.');
    }
  });
  // No `sessionIdGenerator`: the SDK's stateless mode, so no client is ever handed a session id.
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await mcp.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await mcp.close();
  }
}
