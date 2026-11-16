import type { ApiRoute } from './definition.js';
import { json, ok } from './definition.js';
export const a2aRoutes: readonly ApiRoute[] = [
  // ADR-0135 — published agents over A2A v0.3
  {
    method: 'POST',
    path: '/api/a2a/agents/:agentName',
    operationId: 'a2a.rpc',
    tag: 'a2a',
    feature: 'core',
    summary:
      'A2A v0.3 JSON-RPC to a published agent (message/send, message/stream, tasks/get, tasks/cancel)',
    request: json('A2aJsonRpcRequestSchema'),
    // message/stream answers `text/event-stream`, each `data:` one A2aJsonRpcResponseSchema; one
    // status carries one body kind in this catalogue, so the stream is described in ADR-0135.
    success: ok(json('A2aJsonRpcResponseSchema')),
    security: 'endpoint-credential',
  },

  {
    method: 'GET',
    path: '/api/a2a/agents/:agentName/.well-known/agent-card.json',
    operationId: 'a2a.agentCard',
    tag: 'a2a',
    feature: 'core',
    summary: "Read a published agent's A2A v0.3 agent card",
    success: ok(json('A2aAgentCardSchema')),
    security: 'endpoint-credential',
  },
];
