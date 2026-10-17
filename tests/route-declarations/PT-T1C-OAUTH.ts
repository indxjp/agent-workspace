/**
 * PT-T1C-OAUTH · `/oauth/*`, `/.well-known/oauth-*` and the client-secret rotation — issue #971,
 * ADR-0134 part 3.
 *
 * Spec §34 prints the `/oauth/*` routes, the authorization-server metadata and the mcp-project
 * protected-resource metadata, so they carry no `mandate` (ADR-0026 decision 2). It prints neither
 * the client-secret rotation nor the A2A protected-resource metadata (§34 names no `a2a` resource,
 * as for the A2A routes themselves), so those two carry one under
 * [ADR-0026](../../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * decision 2. Each `because` is one quoted string: `declarationArrayToJson` refuses `+`.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'POST',
    path: '/api/endpoint-clients/:id/secret',
    owner: 'PT-T1C-OAUTH',
    landed: true,
    mandate: {
      section: '22',
      because:
        'spec §22 has the workspace provide credentials for programmatic access, and ADR-0134 part 3 gives a confidential endpoint client an OAuth client secret that a member rotates and is shown exactly once.',
    },
  },
  {
    method: 'GET',
    path: '/.well-known/oauth-authorization-server',
    owner: 'PT-T1C-OAUTH',
    landed: true,
  },
  {
    method: 'GET',
    path: '/.well-known/oauth-protected-resource/mcp/projects/:name',
    owner: 'PT-T1C-OAUTH',
    landed: true,
  },
  {
    method: 'GET',
    path: '/.well-known/oauth-protected-resource/api/a2a/agents/:agentName',
    owner: 'PT-T1C-OAUTH',
    landed: true,
    mandate: {
      section: '22',
      because:
        'spec §22 has the workspace provide credentials for programmatic access, and ADR-0134 part 3 publishes RFC 9728 protected-resource metadata for an agent A2A endpoint so an external platform can find the authorization server that issues its endpoint-scoped access token.',
    },
  },
  {
    method: 'GET',
    path: '/oauth/authorize',
    owner: 'PT-T1C-OAUTH',
    landed: true,
  },
  {
    method: 'POST',
    path: '/oauth/authorize',
    owner: 'PT-T1C-OAUTH',
    landed: true,
  },
  {
    method: 'POST',
    path: '/oauth/token',
    owner: 'PT-T1C-OAUTH',
    landed: true,
  },
  {
    method: 'POST',
    path: '/oauth/revoke',
    owner: 'PT-T1C-OAUTH',
    landed: true,
  },
];
