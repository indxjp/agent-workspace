/**
 * W9-RUNS-135 · `GET /api/runs` — a durable, workspace-scoped run list.
 *
 * §34 prints `GET /api/runs/:id` and `GET /api/runs/:id/events` (declared by `W1-CP-04.ts`) but
 * never the bare collection — this route is issue #135's addition, so it carries the ADR-0026
 * decision 2 `mandate` rather than a bare declaration.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'GET',
    path: '/api/runs',
    owner: 'W9-RUNS-135',
    landed: true,
    mandate: {
      section: '35',
      because:
        'spec §35 names a "Runs" list UI ("Completed 23s $0.08 / Completed 8s $0.01 / Failed 4s -") and the exact fields to record for it (run/session/agent/model/provider/status/duration/tokens/cost/tool calls/errors); issue #135 adds the workspace-scoped, filterable, cursor-paginated endpoint that serves that list durably. See docs/adr/W9-RUNS-135-durable-run-list.md.',
    },
  },
];
