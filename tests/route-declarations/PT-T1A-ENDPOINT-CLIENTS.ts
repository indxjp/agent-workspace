/**
 * PT-T1A-ENDPOINT-CLIENTS · `/api/endpoint-clients` — issue #949, ADR-0134 part 1.
 *
 * Spec §34's "Examples:" list does not print these routes, so each carries a `mandate` under
 * [ADR-0026](../../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * decision 2. Each `because` is one quoted string: `declarationArrayToJson` refuses `+`.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'GET',
    path: '/api/endpoint-clients',
    owner: 'PT-T1A-ENDPOINT-CLIENTS',
    landed: true,
    mandate: {
      section: '22',
      because:
        'spec §22 has the workspace provide credentials for programmatic access, and ADR-0134 binds an endpoint-scoped API key to one endpoint client so an external platform reaches one MCP project or one A2A agent and nothing else.',
    },
  },
  {
    method: 'POST',
    path: '/api/endpoint-clients',
    owner: 'PT-T1A-ENDPOINT-CLIENTS',
    landed: true,
    mandate: {
      section: '22',
      because:
        'spec §22 has the workspace provide credentials for programmatic access, and ADR-0134 binds an endpoint-scoped API key to one endpoint client so an external platform reaches one MCP project or one A2A agent and nothing else.',
    },
  },
  {
    method: 'GET',
    path: '/api/endpoint-clients/:id',
    owner: 'PT-T1A-ENDPOINT-CLIENTS',
    landed: true,
    mandate: {
      section: '22',
      because:
        'spec §22 has the workspace provide credentials for programmatic access, and ADR-0134 binds an endpoint-scoped API key to one endpoint client so an external platform reaches one MCP project or one A2A agent and nothing else.',
    },
  },
  {
    method: 'PATCH',
    path: '/api/endpoint-clients/:id',
    owner: 'PT-T1A-ENDPOINT-CLIENTS',
    landed: true,
    mandate: {
      section: '22',
      because:
        'spec §22 has the workspace provide credentials for programmatic access, and ADR-0134 binds an endpoint-scoped API key to one endpoint client so an external platform reaches one MCP project or one A2A agent and nothing else.',
    },
  },
  {
    method: 'DELETE',
    path: '/api/endpoint-clients/:id',
    owner: 'PT-T1A-ENDPOINT-CLIENTS',
    landed: true,
    mandate: {
      section: '22',
      because:
        'spec §22 has the workspace provide credentials for programmatic access, and ADR-0134 binds an endpoint-scoped API key to one endpoint client so an external platform reaches one MCP project or one A2A agent and nothing else.',
    },
  },
  {
    method: 'POST',
    path: '/api/endpoint-clients/:id/keys',
    owner: 'PT-T1A-ENDPOINT-CLIENTS',
    landed: true,
    mandate: {
      section: '22',
      because:
        'spec §22 has the workspace provide credentials for programmatic access, and ADR-0134 binds an endpoint-scoped API key to one endpoint client so an external platform reaches one MCP project or one A2A agent and nothing else.',
    },
  },
];
