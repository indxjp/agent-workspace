/**
 * DJ-80-11-EVALUATIONS-618 · `POST /api/agents/:id/evaluations` — issue #618 (80-11): run a
 * version's evaluation cases on the server and store the score.
 *
 * Spec §34's "Examples:" list does not print the route, so it carries a `mandate` under
 * [ADR-0026](../../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * decision 2.
 *
 * The `because` is one quoted string, not a concatenated one: `tests/inventory-support.ts`'s
 * `declarationArrayToJson` reads a declaration file as plain data and refuses any expression.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'POST',
    path: '/api/agents/:id/evaluations',
    owner: 'DJ-80-11-EVALUATIONS-618',
    landed: true,
    mandate: {
      section: '17',
      because:
        'spec §17 makes the agent definition what a Builder authors and ADR-0101 numbers its versions, and issue #618 asks for a score of a version that the server computed, so the server runs the cases and stores the score against that version for a promotion gate to trust.',
    },
  },
  {
    method: 'GET',
    path: '/api/agents/:id/evaluation-runs',
    owner: 'DJ-80-11-EVALUATIONS-618',
    landed: true,
    mandate: {
      section: '17',
      because:
        'issue #799 asks `aw eval run --baseline <id>` to diff a run against an earlier evaluation and the CLI to follow a run it started, so a stored run is readable by id (`?evaluation=`) by the callers who may read that agent.',
    },
  },
  {
    method: 'POST',
    path: '/api/agents/:id/evaluation-runs',
    owner: 'DJ-80-11-EVALUATIONS-618',
    landed: true,
    mandate: {
      section: '17',
      because:
        'issue #799 raises an evaluation from 20 cases to 200, which cannot run inside one HTTP request, so the server stores the run and the client advances it in steps until every case has a result.',
    },
  },
  {
    method: 'POST',
    path: '/api/agents/:id/evaluation-advance',
    owner: 'DJ-80-11-EVALUATIONS-618',
    landed: true,
    mandate: {
      section: '17',
      because:
        'issue #799 raises an evaluation from 20 cases to 200, which cannot run inside one HTTP request, so each advance runs the next cases of a stored run and answers its progress.',
    },
  },
];
