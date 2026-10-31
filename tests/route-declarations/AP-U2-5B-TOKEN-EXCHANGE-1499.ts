/**
 * AP-U2-5B-TOKEN-EXCHANGE-1499 · `POST /api/auth/token-exchange` — issue #1499, ADR-0161.
 *
 * An app backend exchanges the signed-in person's ID token for a short-lived access token of its
 * `app-backend` endpoint client. Spec §34 prints the route (ADR-0161 D13), so it carries no
 * mandate.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'POST',
    path: '/api/auth/token-exchange',
    owner: 'AP-U2-5B-TOKEN-EXCHANGE-1499',
    landed: true,
  },
];
