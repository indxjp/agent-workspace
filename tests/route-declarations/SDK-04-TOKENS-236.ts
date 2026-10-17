/**
 * SDK-04-TOKENS-236 · `POST /api/tokens` (S-1) — issue #236.
 *
 * Spec §34's "Examples:" list does not print it, so it carries a `mandate` under
 * [ADR-0026](../../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * decision 2. §22 is the section: it is the platform's existing mandate to "provide workspace [credentials]
 * for programmatic access" and to "show the raw secret only once … store only a secure hash", and
 * this route is that same mandate applied to a short-lived, scoped bearer instead of a long-lived
 * workspace-wide one.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'POST',
    path: '/api/tokens',
    owner: 'SDK-04-TOKENS-236',
    landed: true,
    mandate: {
      section: '22',
      because:
        'spec §22 mandates "provide workspace [credentials] for programmatic access", "show the raw secret only once" and "store only a secure hash"; this route is that same mandate for a short-lived, run- or session-scoped bearer rather than a long-lived workspace-wide key.',
    },
  },
];
