/**
 * BLD-5B-BUILDER-EXTERNAL-1846 · `POST /mcp/builder` and its protected-resource metadata — issue
 * #1846 slice 5b, Builder design §04.
 *
 * The read-only door for an outside MCP client. It accepts an OAuth token of the `builder` client
 * kind and nothing else. Spec §34 prints neither route, so each carries a section 17 mandate.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'POST',
    path: '/mcp/builder',
    owner: 'BLD-5B-BUILDER-EXTERNAL-1846',
    landed: true,
    mandate: {
      section: '17',
      because:
        'The Builder creates and edits agents (section 17); a member can let an outside MCP client such as Claude Code read the catalogue, the examples and the draft checks as themselves, and this one route is where that client arrives with its OAuth token.',
    },
  },
  {
    method: 'GET',
    path: '/.well-known/oauth-protected-resource/mcp/builder',
    owner: 'BLD-5B-BUILDER-EXTERNAL-1846',
    landed: true,
    mandate: {
      section: '17',
      because:
        'RFC 9728 protected-resource metadata for the Builder door, so an outside MCP client can find the authorization server that issues its builder-scoped access token.',
    },
  },
];
