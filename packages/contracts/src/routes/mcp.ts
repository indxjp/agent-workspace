import type { ApiRoute } from './definition.js';
import { json, ok } from './definition.js';
export const mcpRoutes: readonly ApiRoute[] = [
  // ADR-0134 part 2 — an mcp-project endpoint client's public MCP endpoint, outside /api (spec §34)
  {
    method: 'POST',
    path: '/mcp/projects/:name',
    operationId: 'mcp.projectRpc',
    tag: 'mcp',
    feature: 'projects',
    summary:
      "MCP JSON-RPC to an endpoint client's production code tools (initialize, ping, tools/list, tools/call)",
    request: json('A2aJsonRpcRequestSchema'),
    // The JSON-RPC 2.0 envelope is protocol-neutral; a notification (no `id`) is answered 202.
    success: ok(json('A2aJsonRpcResponseSchema')),
    security: 'endpoint-credential',
  },

  // Builder design §04 (#1846 slice 5b) — the read-only door for an outside MCP client (a `builder` OAuth client)
  {
    method: 'POST',
    path: '/mcp/builder',
    operationId: 'mcp.builderRpc',
    tag: 'mcp',
    feature: 'builder',
    summary:
      "MCP JSON-RPC to the Builder's read tools (initialize, ping, tools/list, tools/call) for an outside client",
    request: json('A2aJsonRpcRequestSchema'),
    success: ok(json('A2aJsonRpcResponseSchema')),
    security: 'endpoint-credential',
  },
];
