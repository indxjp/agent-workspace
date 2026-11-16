// Generated from tests/apps/benchmark.ts by `APPS_WRITE=1 pnpm vitest run --project tests tests/apps`.
// Do not edit by hand: tests/apps/store-line-counts.test.ts fails when it differs from the benchmark.

import type { LineCount } from './define.ts';

/** Handwritten lines against budget, keyed by the `examples/<id>` directory. */
export const LINE_COUNTS: Readonly<Record<string, LineCount>> = {
  'team-chat': { handwritten: 85, budget: 150 },
  wiki: { handwritten: 59, budget: 100 },
  crm: { handwritten: 141, budget: 200 },
  'service-desk': { handwritten: 246, budget: 250 },
};
