/**
 * ST-P6-DEMO-TEMPLATES · `PUT /api/demo/templates/:entry`, `GET /api/demo/templates`,
 * `PUT /api/demo/verification/:workspaceId` — the deployment's template seeding, the nightly sample
 * check and the real-model verification workspace fill of the Agent Store (phase P6).
 *
 * Spec §34's "Examples:" list prints none of them, so each carries a `mandate` under
 * [ADR-0026](../../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * decision 2. Each `because` is one quoted string: `declarationArrayToJson` refuses `+`.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'PUT',
    path: '/api/demo/templates/:entry',
    owner: 'ST-P6-DEMO-TEMPLATES',
    landed: true,
    mandate: {
      section: '21',
      because:
        "spec §21 defines the guest role and its demo, whose agent and sample data a visitor's copy takes from a template the deployment itself fills, so the deploy's operator step seeds each entry's template.",
    },
  },
  {
    method: 'GET',
    path: '/api/demo/templates',
    owner: 'ST-P6-DEMO-TEMPLATES',
    landed: true,
    mandate: {
      section: '21',
      because:
        "spec §21 defines the guest role and its demo, and the deployment's nightly sample check reads what each template would give a visitor's copy, so a broken template is found before a visitor meets it.",
    },
  },
  {
    method: 'PUT',
    path: '/api/demo/verification/:workspaceId',
    owner: 'ST-P6-DEMO-TEMPLATES',
    landed: true,
    mandate: {
      section: '21',
      because:
        "spec §21 defines the guest role and its demo, and the real-model verification runs each entry in a workspace the operator fills with every template exactly as a visitor's copy is made, so it proves what a visitor gets.",
    },
  },
];
