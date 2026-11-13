import { describe, expectTypeOf, it } from 'vitest';

import type {
  RunApiEnvironment,
  RunEvaluationEnvironment,
  RunFeedbackEnvironment,
  RunReadEnvironment,
  RunStartEnvironment,
} from './environment';

// Part 09 step 7 characterization: splitting the run API into named slices keeps exactly these
// members, each with its own optionality; only the names a caller asks for change.
describe('the run API environment', () => {
  it('has exactly its 23 members', () => {
    expectTypeOf<keyof RunApiEnvironment>().toEqualTypeOf<
      | 'authenticate'
      | 'findAgent'
      | 'openSession'
      | 'discardSession'
      | 'findAgentVersion'
      | 'preflight'
      | 'spendLimitFor'
      | 'ceilingFor'
      | 'dailyCostCap'
      | 'describeRunTarget'
      | 'ownsRun'
      | 'store'
      | 'ids'
      | 'revokeRunTokens'
      | 'interruptRun'
      | 'recordRunFeedback'
      | 'listAgentFeedback'
      | 'admitVisitorWrite'
      | 'judgeEvaluationCase'
      | 'recordEvaluation'
      | 'evaluationRuns'
      | 'launch'
      | 'logger'
    >();
  });

  it('keeps the same members required', () => {
    type Required<T> = { [K in keyof T]-?: undefined extends T[K] ? never : K }[keyof T];
    expectTypeOf<Required<RunApiEnvironment>>().toEqualTypeOf<
      'authenticate' | 'findAgent' | 'openSession' | 'ownsRun' | 'store' | 'launch'
    >();
  });
});

describe('the run API slices', () => {
  it('cover every member once', () => {
    expectTypeOf<
      keyof RunReadEnvironment &
        (keyof RunStartEnvironment | keyof RunFeedbackEnvironment | keyof RunEvaluationEnvironment)
    >().toEqualTypeOf<never>();
    expectTypeOf<
      keyof RunStartEnvironment & (keyof RunFeedbackEnvironment | keyof RunEvaluationEnvironment)
    >().toEqualTypeOf<never>();
    expectTypeOf<
      keyof RunFeedbackEnvironment & keyof RunEvaluationEnvironment
    >().toEqualTypeOf<never>();
    expectTypeOf<
      | keyof RunReadEnvironment
      | keyof RunStartEnvironment
      | keyof RunFeedbackEnvironment
      | keyof RunEvaluationEnvironment
    >().toEqualTypeOf<keyof RunApiEnvironment>();
  });
});
