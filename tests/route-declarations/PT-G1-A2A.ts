/**
 * PT-G1-A2A · `/api/a2a/agents/:agentName` — issue #955, ADR-0135.
 *
 * Spec §34 prints both routes, so neither carries a `mandate`
 * ([ADR-0026](../../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * decision 2).
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'POST',
    path: '/api/a2a/agents/:agentName',
    owner: 'PT-G1-A2A',
    landed: true,
  },
  {
    method: 'GET',
    path: '/api/a2a/agents/:agentName/.well-known/agent-card.json',
    owner: 'PT-G1-A2A',
    landed: true,
  },
];
