/**
 * AP-U4-2B-AGENT-TEAMS-1516 · `/api/agent-teams/**` — issue #1516, ADR-0104 (accepted for
 * `handoff` mode), spec 04 §5.18.
 *
 * Spec §34's "Examples:" list does not print these routes, so each carries a `mandate` under
 * [ADR-0026](../../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * decision 2, citing the record that decided them. They are decided as the `agents` resource
 * (ADR-0104 acceptance decision 10). Each `because` is an inline quoted string:
 * `declarationArrayToJson` refuses `+` and constants.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'GET',
    path: '/api/agent-teams',
    owner: 'AP-U4-2B-AGENT-TEAMS-1516',
    landed: true,
    mandate: {
      section: '21',
      because:
        'ADR-0104, accepted for handoff mode, makes an agent team a versioned published resource, and its acceptance decision 10 authorises the agent-teams routes as the agents resource of spec §21: reading a team is reading an agent.',
    },
  },
  {
    method: 'POST',
    path: '/api/agent-teams',
    owner: 'AP-U4-2B-AGENT-TEAMS-1516',
    landed: true,
    mandate: {
      section: '21',
      because:
        'ADR-0104, accepted for handoff mode, makes an agent team a versioned published resource, and its acceptance decision 10 authorises creating one as the same write as creating an agent under spec §21, Builder and above.',
    },
  },
  {
    method: 'GET',
    path: '/api/agent-teams/:id',
    owner: 'AP-U4-2B-AGENT-TEAMS-1516',
    landed: true,
    mandate: {
      section: '21',
      because:
        'ADR-0104, accepted for handoff mode, makes an agent team a versioned published resource, and its acceptance decision 10 authorises the agent-teams routes as the agents resource of spec §21: reading a team is reading an agent.',
    },
  },
  {
    method: 'DELETE',
    path: '/api/agent-teams/:id',
    owner: 'AP-U4-2B-AGENT-TEAMS-1516',
    landed: true,
    mandate: {
      section: '21',
      because:
        'ADR-0104, accepted for handoff mode, makes an agent team a versioned published resource, and its acceptance decision 10 authorises deleting one as the same write as on an agent under spec §21, a Builder on its own teams.',
    },
  },
  {
    method: 'POST',
    path: '/api/agent-teams/:id/versions',
    owner: 'AP-U4-2B-AGENT-TEAMS-1516',
    landed: true,
    mandate: {
      section: '21',
      because:
        'ADR-0104 acceptance decision 11 makes team versions immutable and numbered per team, and decision 10 authorises saving one as the same write as saving an agent version under spec §21, a Builder on its own teams.',
    },
  },
  {
    method: 'GET',
    path: '/api/agent-teams/:id/versions',
    owner: 'AP-U4-2B-AGENT-TEAMS-1516',
    landed: true,
    mandate: {
      section: '21',
      because:
        'ADR-0104 acceptance decision 11 makes team versions immutable and numbered per team, and decision 10 authorises reading them as reading an agent under spec §21.',
    },
  },
];
