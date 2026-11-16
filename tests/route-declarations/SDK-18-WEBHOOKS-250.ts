/**
 * SDK-18-WEBHOOKS-250 · `/api/webhooks` — issue #250 (N-3), ADR-SDK-18-N3-250.
 *
 * Spec §34's "Examples:" list does not print these routes, so each carries a `mandate` under
 * [ADR-0026](../../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * decision 2, citing the record that decided them. Each `because` is an inline quoted string:
 * `declarationArrayToJson` refuses `+` and constants.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'GET',
    path: '/api/webhooks',
    owner: 'SDK-18-WEBHOOKS-250',
    landed: true,
    mandate: {
      section: '21',
      because:
        'ADR-SDK-18-N3-250 lets a workspace register endpoints that receive signed run-outcome events, and its D6 gives the webhooks resource to Owner and Admin under spec §21, as configuration that decides where workspace run data is sent.',
    },
  },
  {
    method: 'POST',
    path: '/api/webhooks',
    owner: 'SDK-18-WEBHOOKS-250',
    landed: true,
    mandate: {
      section: '21',
      because:
        'ADR-SDK-18-N3-250 lets a workspace register endpoints that receive signed run-outcome events, and its D6 gives the webhooks resource to Owner and Admin under spec §21, as configuration that decides where workspace run data is sent.',
    },
  },
  {
    method: 'DELETE',
    path: '/api/webhooks/:id',
    owner: 'SDK-18-WEBHOOKS-250',
    landed: true,
    mandate: {
      section: '21',
      because:
        'ADR-SDK-18-N3-250 lets a workspace register endpoints that receive signed run-outcome events, and its D6 gives the webhooks resource to Owner and Admin under spec §21, as configuration that decides where workspace run data is sent.',
    },
  },
];
