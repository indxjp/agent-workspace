import { createClient, type AgentWorkspaceClient } from '@indx-workspace/sdk';

/**
 * The one way browser code reaches `/api/**` (F-07, ADR-0052): the SDK on the page's own origin,
 * authenticated by the session cookie. The SDK states the contracts version, encodes path
 * segments, validates every response against the contract and decodes problems into typed errors,
 * so a screen never hand-writes any of that.
 */
export function browserClient(): AgentWorkspaceClient {
  return createClient({ baseUrl: window.location.origin, auth: { kind: 'session' } });
}
