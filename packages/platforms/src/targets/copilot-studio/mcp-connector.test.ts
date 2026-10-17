import { describe, expect, it } from 'vitest';

import { buildMcpConnector } from './mcp-connector.js';

function build(url: string, secretRef?: string) {
  const result = buildMcpConnector({ name: 'zendesk', agentName: 'support', url, secretRef });
  if (!result.ok) throw new Error(result.reason);
  return result;
}

describe('buildMcpConnector', () => {
  it('splits the URL into host and path, keeping a port', () => {
    const { swagger } = build('https://mcp.example.com:8443/zendesk');
    expect(swagger['host']).toBe('mcp.example.com:8443');
    expect(Object.keys(swagger['paths'] as object)).toEqual(['/zendesk']);
  });

  it('keeps a nested path and drops a trailing slash', () => {
    const { swagger } = build('https://aw.example.com/mcp/projects/acme/');
    expect(Object.keys(swagger['paths'] as object)).toEqual(['/mcp/projects/acme']);
    expect(Object.keys(build('https://aw.example.com').swagger['paths'] as object)).toEqual(['/']);
  });

  it('refuses a URL with a query string', () => {
    const result = buildMcpConnector({
      name: 'zendesk',
      agentName: 'support',
      url: 'https://mcp.example.com/x?key=1',
      secretRef: undefined,
    });
    expect(result.ok).toBe(false);
  });

  it('has no security definition and no connection parameter without auth', () => {
    const { swagger, apiProperties } = build('https://mcp.example.com/zendesk');
    expect(swagger).not.toHaveProperty('securityDefinitions');
    expect(swagger).not.toHaveProperty('security');
    expect(apiProperties['properties']).toHaveProperty('connectionParameters', {});
  });

  it('names the secret, and only names it, when there is a secretRef', () => {
    const { swagger, apiProperties } = build('https://mcp.example.com/zendesk', 'ZENDESK_TOKEN');
    expect(swagger['security']).toEqual([{ api_key: [] }]);
    const text = JSON.stringify(apiProperties);
    expect(text).toContain('ZENDESK_TOKEN');
    expect(text).toContain('securestring');
  });
});
