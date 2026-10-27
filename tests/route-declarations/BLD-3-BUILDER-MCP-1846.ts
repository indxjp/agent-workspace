/**
 * BLD-3-BUILDER-MCP-1846 · `POST /api/builder/mcp` — issue #1846 slice 2, Builder design §04.
 *
 * The `aw-control` MCP door. A running agent reaches it through the gateway with its run token; the
 * route accepts that token as a `run-caller` and refuses session cookies and API keys. Spec §34
 * prints no such route, so it carries a section 17 mandate; it is excluded from the published API
 * (`API_ROUTE_EXCLUSIONS`) because only the gateway calls it.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'POST',
    path: '/api/builder/mcp',
    owner: 'BLD-3-BUILDER-MCP-1846',
    landed: true,
    mandate: {
      section: '17',
      because:
        'The Builder creates and edits agents (section 17) for the person who started its run; a run token reaches the control plane only through this one route, so the gateway keeps its approval, usage and revocation checks on the hop.',
    },
  },
];
