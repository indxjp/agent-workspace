/**
 * PT-T1B-TOOL-ENDPOINT · `/mcp/projects/:name` — issue #967, ADR-0134 part 2.
 *
 * Spec §34 prints this route, so it carries no `mandate` (ADR-0026 decision 2).
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'POST',
    path: '/mcp/projects/:name',
    owner: 'PT-T1B-TOOL-ENDPOINT',
    landed: true,
  },
];
