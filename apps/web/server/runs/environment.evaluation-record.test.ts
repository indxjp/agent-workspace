import type { StoredAgentVersionEvaluation } from '@agent-workspace/core/db';
import { describe, expectTypeOf, it } from 'vitest';

import type { RunApiEnvironment } from './environment';

type EvaluationRuns = NonNullable<RunApiEnvironment['evaluationRuns']>;
type Found = NonNullable<Awaited<ReturnType<EvaluationRuns['find']>>>;
type Claimed = NonNullable<Awaited<ReturnType<EvaluationRuns['claim']>>>;

// Part 09 step 6: the run API names its own evaluation record, not the PostgreSQL row type. The two
// must stay the same shape both ways, so the adapter needs no mapping and no field is lost.
describe('the evaluation record the run API reads', () => {
  it('is the stored evaluation row, both ways, for find and claim', () => {
    expectTypeOf<Found>().toEqualTypeOf<StoredAgentVersionEvaluation>();
    expectTypeOf<Claimed>().toEqualTypeOf<StoredAgentVersionEvaluation>();
  });
});
