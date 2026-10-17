/**
 * DJ-S1-05-AGENT-VERSIONS-443 · `GET`/`POST /api/agents/:id/versions` — issue #443 (developer
 * journey S1-05), ADR-0101.
 *
 * Spec §34's "Examples:" list does not print either route, so both carry a `mandate` under
 * [ADR-0026](../../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * decision 2. §17 makes the agent definition what a Builder authors, and ADR-0101 makes the platform
 * own that definition's numbered versions.
 *
 * The `because` on each mandate is one quoted string, not a concatenated one:
 * `tests/inventory-support.ts`'s `declarationArrayToJson` reads a declaration file as plain data
 * and refuses any expression, `+` included.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'GET',
    path: '/api/agents/:id/versions',
    owner: 'DJ-S1-05-AGENT-VERSIONS-443',
    landed: true,
    mandate: {
      section: '17',
      because:
        'spec §17 makes the agent definition what a Builder authors, and ADR-0101 makes each saved definition an immutable numbered version, so the history and the environment pointers must be readable as one listing.',
    },
  },
  {
    method: 'POST',
    path: '/api/agents/:id/versions',
    owner: 'DJ-S1-05-AGENT-VERSIONS-443',
    landed: true,
    mandate: {
      section: '17',
      because:
        'spec §17 makes the agent definition what a Builder authors, and ADR-0101 makes saving that definition a new numbered version, checked first with a dry run that answers exactly the problems the save would.',
    },
  },
];
