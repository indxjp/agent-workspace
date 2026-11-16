import { describe, expect, it } from 'vitest';
import type { EndpointClientResource } from '@indx-workspace/contracts/endpoint-clients';
import { CLIENT } from './export.test-support';
import { toolEndpointOf } from './project';

describe('toolEndpointOf', () => {
  const origin = 'https://aw.example.com';
  const publishing = (overrides: Partial<EndpointClientResource> = {}): EndpointClientResource => ({
    ...CLIENT,
    agentIds: ['root'],
    ...overrides,
  });

  it('names the one live mcp-project client publishing the agent, with a secret reference', () => {
    expect(toolEndpointOf([publishing()], 'root', origin)).toStrictEqual({
      kind: 'found',
      endpoint: {
        url: 'https://aw.example.com/mcp/projects/ide',
        auth: { scheme: 'bearer', secretRef: 'TOOL_ENDPOINT_IDE' },
      },
    });
  });

  it.each([
    ['a revoked client', [publishing({ revokedAt: '2026-02-01T00:00:00.000Z' })], origin],
    ['an a2a-agent client', [publishing({ kind: 'a2a-agent' })], origin],
    ['a client of another agent', [publishing({ agentIds: ['other'] })], origin],
    ['no public origin', [publishing()], null],
    ['a plain http origin', [publishing()], 'http://localhost:3000'],
  ])('finds no endpoint for %s', (_name, clients, publicOrigin) => {
    expect(toolEndpointOf(clients, 'root', publicOrigin)).toStrictEqual({ kind: 'none' });
  });

  it('reports every publishing client rather than guessing between them', () => {
    expect(
      toolEndpointOf([publishing({ name: 'zed' }), publishing({ name: 'ide' })], 'root', origin),
    ).toStrictEqual({ kind: 'ambiguous', names: ['ide', 'zed'] });
  });
});
