/**
 * AP-U4-2C-AGENT-TEAM-RUNS-1517 · `POST /api/agent-teams/:id/runs` and
 * `POST /api/runs/:id/members/mcp` — issue #1517, ADR-0104 (accepted for `handoff` mode), spec 04
 * §5.18.
 *
 * Spec §34's "Examples:" list does not print these routes, so each carries a `mandate` under
 * [ADR-0026](../../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * decision 2, citing the record that decided them. The team run is decided as the `run` verb on
 * the lead agent; the member endpoint takes the lead run's own run token and is excluded from the
 * published API (`API_ROUTE_EXCLUSIONS`) because only the lead run's engine calls it. Each
 * `because` is an inline quoted string: `declarationArrayToJson` refuses `+` and constants.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'POST',
    path: '/api/agent-teams/:id/runs',
    owner: 'AP-U4-2C-AGENT-TEAM-RUNS-1517',
    landed: true,
    mandate: {
      section: '21',
      because:
        'ADR-0104, accepted for handoff mode, runs an agent team as a run of its lead, and its acceptance decision 10 authorises it as the run verb on the lead agent under spec §21, so a person runs a team exactly when they may run its lead.',
    },
  },
  {
    method: 'POST',
    path: '/api/runs/:id/members/mcp',
    owner: 'AP-U4-2C-AGENT-TEAM-RUNS-1517',
    landed: true,
    mandate: {
      section: '21',
      because:
        "ADR-0104 acceptance decision 4 serves a lead run's member tools from the control plane, the only place a run can start, authenticated by the lead run's own token; each member call is a run start the person behind the lead run must be allowed under spec §21.",
    },
  },
];
