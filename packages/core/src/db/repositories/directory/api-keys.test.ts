import { describe, expect, it } from 'vitest';

import type { EndpointClientKind } from '../../schema/endpoint-clients.js';
import { endpointScopeForClient } from './api-keys.js';

const CLIENT_ID = 'client-1';

describe('endpointScopeForClient', () => {
  it('scopes an mcp-project key to its client', () => {
    expect(endpointScopeForClient(CLIENT_ID, { kind: 'mcp-project', agentId: null })).toEqual({
      kind: 'mcp-project',
      clientId: CLIENT_ID,
    });
  });

  it('scopes an a2a-agent key to its client and agent', () => {
    expect(endpointScopeForClient(CLIENT_ID, { kind: 'a2a-agent', agentId: 'agent-1' })).toEqual({
      kind: 'a2a-agent',
      clientId: CLIENT_ID,
      agentId: 'agent-1',
    });
  });

  it('refuses an a2a-agent client that names no agent', () => {
    expect(() => endpointScopeForClient(CLIENT_ID, { kind: 'a2a-agent', agentId: null })).toThrow(
      'An a2a endpoint client must name exactly one agent.',
    );
  });

  it('refuses the clients reached by an OAuth token only', () => {
    expect(() => endpointScopeForClient(CLIENT_ID, { kind: 'builder', agentId: null })).toThrow(
      'A builder endpoint client has no API key.',
    );
    expect(() => endpointScopeForClient(CLIENT_ID, { kind: 'app-backend', agentId: null })).toThrow(
      'An app-backend endpoint client has no API key.',
    );
  });

  it('throws on a client kind it does not know', () => {
    // A row value outside the enum, as a newer schema could hold: only reachable through a cast.
    const kind = 'webhook' as unknown as EndpointClientKind;
    expect(() => endpointScopeForClient(CLIENT_ID, { kind, agentId: null })).toThrow(
      'unhandled endpoint client kind webhook',
    );
  });
});
