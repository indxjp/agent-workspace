import { API_ROUTES } from '@indx-workspace/contracts/routes';
import { describe, expect, it } from 'vitest';

import { isAgentEndpointRoute } from './agent-endpoint-routes';

describe('isAgentEndpointRoute', () => {
  it('is true for exactly the catalogue routes that declare endpoint-credential security', () => {
    const declared = API_ROUTES.filter((route) => route.security === 'endpoint-credential');
    expect(declared.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      'GET /api/a2a/agents/:agentName/.well-known/agent-card.json',
      'POST /api/a2a/agents/:agentName',
      'POST /mcp/projects/:name',
    ]);
    for (const route of declared) {
      const path = route.path.replace(':agentName', 'bot').replace(':name', 'bot');
      expect(isAgentEndpointRoute(route.method, path)).toBe(true);
    }
  });

  it('treats HEAD as the GET it shadows and refuses other methods, depths and prefixes', () => {
    const card = '/api/a2a/agents/bot/.well-known/agent-card.json';
    expect(isAgentEndpointRoute('HEAD', card)).toBe(true);
    expect(isAgentEndpointRoute('POST', card)).toBe(false);
    expect(isAgentEndpointRoute('GET', '/api/a2a/agents/bot')).toBe(false);
    expect(isAgentEndpointRoute('POST', '/api/a2a/agents/bot/extra')).toBe(false);
    expect(isAgentEndpointRoute('POST', '/api/a2a/agents/')).toBe(false);
    expect(isAgentEndpointRoute('POST', '/api/agents/bot')).toBe(false);
  });

  it('admits the MCP project endpoint on POST and on that exact path only', () => {
    expect(isAgentEndpointRoute('POST', '/mcp/projects/support')).toBe(true);
    expect(isAgentEndpointRoute('GET', '/mcp/projects/support')).toBe(false);
    expect(isAgentEndpointRoute('POST', '/mcp/projects/support/extra')).toBe(false);
    expect(isAgentEndpointRoute('POST', '/mcp/projects/')).toBe(false);
    expect(isAgentEndpointRoute('POST', '/mcp/projectsx')).toBe(false);
    expect(isAgentEndpointRoute('POST', '/mcp/other/support')).toBe(false);
  });
});
