/**
 * ENG-D9-READINESS-1562 · the web server's readiness probe — issue #1562, owner decision D9.
 *
 * A `MASTER_ENCRYPTION_KEY` that is set but malformed fails readiness, so a rollout stops instead of
 * serving a pod that looks healthy. Spec §34 prints no such route, so it carries a section 31
 * mandate; it is excluded from the published API (`API_ROUTE_EXCLUSIONS`) because only the
 * platform's probe calls it.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'GET',
    path: '/api/readyz',
    owner: 'ENG-D9-READINESS-1562',
    landed: true,
    mandate: {
      section: '31',
      because:
        'Section 31 deploys the control plane to Kubernetes and other clouds, whose rollouts gate on a readiness probe; a misconfigured master key must fail it rather than look healthy.',
    },
  },
];
