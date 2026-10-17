import { describe, expect, it } from 'vitest';

import {
  AdvanceEvaluationRunRequestSchema,
  CreateEvaluationRequestSchema,
  CreateEvaluationRunRequestSchema,
  EVALUATION_CASE_LIMIT,
  EVALUATION_RUN_CASE_LIMIT,
  EVALUATION_TOOL_INPUT_MAX_LENGTH,
  EvalCaseFileSchema,
  EvaluationResourceSchema,
  EvaluationRunResourceSchema,
} from './evaluations.js';

/** The issue's demo `evals/support.yaml`, as the YAML reader hands it over. */
const DEMO = {
  cases: [
    {
      name: 'order status uses the tool',
      input: 'Where is order 1042?',
      expect: { tool: 'orders_getOrder', contains: ['shipped'] },
    },
    {
      name: 'no refund promises',
      input: 'I want my money back now',
      expect: { judge: 'Stays polite and does not promise a refund' },
    },
  ],
};

function issues(value: unknown): readonly string[] {
  const parsed = EvalCaseFileSchema.safeParse(value);
  if (parsed.success) throw new Error('expected the case file to be refused');
  return parsed.error.issues.map(
    (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
  );
}

const one = (expect: unknown, name = 'a') => ({ name, input: 'hi', expect });

describe('EvalCaseFileSchema (issue #618)', () => {
  it('parses the demo file unchanged and frozen', () => {
    const parsed = EvalCaseFileSchema.parse(DEMO);
    expect(parsed).toEqual(DEMO);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('refuses an unknown key at every level', () => {
    expect(issues({ ...DEMO, extra: 1 })).toEqual([expect.stringMatching(/^: /)]);
    expect(issues({ cases: [{ ...one({ tool: 't' }), weight: 2 }] })[0]).toMatch(/^cases\.0: /);
    expect(issues({ cases: [one({ tool: 't', regex: 'x' })] })[0]).toMatch(/^cases\.0\.expect: /);
  });

  it('refuses an empty expect, a blank input and an empty contains list', () => {
    expect(issues({ cases: [one({})] })).toEqual([
      expect.stringContaining('cases.0.expect: expect must name at least one'),
    ]);
    expect(issues({ cases: [{ name: 'a', input: '  ', expect: { tool: 't' } }] })).toEqual([
      'cases.0.input: must not be blank',
    ]);
    expect(issues({ cases: [one({ contains: [] })] })[0]).toMatch(/^cases\.0\.expect\.contains: /);
  });

  it('refuses duplicate case names', () => {
    expect(issues({ cases: [one({ tool: 't' }), one({ tool: 'u' })] })).toEqual([
      'cases.1.name: duplicate case name "a"',
    ]);
  });

  it('refuses an empty case list', () => {
    expect(issues({ cases: [] })[0]).toMatch(/^cases: /);
  });

  it('keeps the run a case was made from, and refuses one that is not a UUID (issue #620)', () => {
    const fromRun = '11111111-1111-4111-8111-111111111111';
    const made = { ...one({ judge: 'Must not repeat: no.' }), fromRun };
    expect(EvalCaseFileSchema.parse({ cases: [made] })).toEqual({ cases: [made] });
    expect(issues({ cases: [{ ...made, fromRun: 'run_1' }] })[0]).toMatch(/^cases\.0\.fromRun: /);
  });
});

describe('CreateEvaluationRequestSchema (issue #618)', () => {
  it('takes a positive version number with the cases', () => {
    expect(CreateEvaluationRequestSchema.parse({ version: 7, ...DEMO }).version).toBe(7);
    expect(CreateEvaluationRequestSchema.safeParse({ version: 0, ...DEMO }).success).toBe(false);
    expect(CreateEvaluationRequestSchema.safeParse(DEMO).success).toBe(false);
  });
});

describe('EvaluationResourceSchema (issue #618)', () => {
  it('parses a stored evaluation and refuses a score over 1', () => {
    const resource = {
      id: '00000000-0000-4000-8000-000000000001',
      agentId: '00000000-0000-4000-8000-000000000002',
      version: 7,
      score: 0.5,
      passed: 1,
      total: 2,
      results: [
        { name: 'a', passed: true, runId: '00000000-0000-4000-8000-000000000003', failures: [] },
        { name: 'b', passed: false, runId: null, failures: ['deadline_exceeded'] },
      ],
      createdAt: '2026-10-04T00:00:00.000Z',
    };
    expect(EvaluationResourceSchema.parse(resource)).toEqual(resource);
    expect(EvaluationResourceSchema.safeParse({ ...resource, score: 1.5 }).success).toBe(false);
  });
});

describe('evaluation runs and tool arguments (issue #799)', () => {
  const cases = (count: number) =>
    Array.from({ length: count }, (_, index) => one({ tool: 't' }, `case ${String(index)}`));

  it('takes 200 cases in a run and a case file, and refuses 201', () => {
    expect(
      CreateEvaluationRunRequestSchema.safeParse({
        version: 1,
        cases: cases(EVALUATION_RUN_CASE_LIMIT),
      }).success,
    ).toBe(true);
    expect(EvalCaseFileSchema.safeParse({ cases: cases(EVALUATION_RUN_CASE_LIMIT) }).success).toBe(
      true,
    );
    expect(
      CreateEvaluationRunRequestSchema.safeParse({
        version: 1,
        cases: cases(EVALUATION_RUN_CASE_LIMIT + 1),
      }).success,
    ).toBe(false);
    expect(issues({ cases: cases(EVALUATION_RUN_CASE_LIMIT + 1) })[0]).toMatch(/^cases: /);
  });

  it(`keeps the synchronous request at its ${String(EVALUATION_CASE_LIMIT)} cases`, () => {
    const request = (count: number) => ({ version: 1, cases: cases(count) });
    expect(CreateEvaluationRequestSchema.safeParse(request(EVALUATION_CASE_LIMIT)).success).toBe(
      true,
    );
    expect(
      CreateEvaluationRequestSchema.safeParse(request(EVALUATION_CASE_LIMIT + 1)).success,
    ).toBe(false);
  });

  it('takes an advance request that names a run by UUID and nothing else', () => {
    const evaluationId = '55555555-5555-4555-8555-555555555555';
    expect(AdvanceEvaluationRunRequestSchema.safeParse({ evaluationId }).success).toBe(true);
    expect(AdvanceEvaluationRunRequestSchema.safeParse({ evaluationId: 'nope' }).success).toBe(
      false,
    );
    expect(AdvanceEvaluationRunRequestSchema.safeParse({ evaluationId, extra: 1 }).success).toBe(
      false,
    );
  });

  it('refuses a run request with an unknown key', () => {
    expect(
      CreateEvaluationRunRequestSchema.safeParse({ version: 1, cases: cases(1), extra: true })
        .success,
    ).toBe(false);
  });

  it('parses a toolInput beside its tool', () => {
    const expectation = { tool: 'orders_getOrder', toolInput: { orderNumber: '1042', deep: [1] } };
    expect(EvalCaseFileSchema.parse({ cases: [one(expectation)] }).cases[0]?.expect).toEqual(
      expectation,
    );
  });

  it('refuses a toolInput without a tool, an array and an oversize one', () => {
    expect(issues({ cases: [one({ toolInput: { a: 1 } })] })).toEqual([
      'cases.0.expect.toolInput: toolInput needs tool: the tool whose call it matches',
    ]);
    expect(issues({ cases: [one({ tool: 't', toolInput: [1] })] })[0]).toMatch(
      /^cases\.0\.expect\.toolInput: /,
    );
    const oversize = { text: 'x'.repeat(EVALUATION_TOOL_INPUT_MAX_LENGTH) };
    expect(issues({ cases: [one({ tool: 't', toolInput: oversize })] })[0]).toMatch(
      /^cases\.0\.expect\.toolInput: must be at most/,
    );
  });

  it('parses a running run with its progress and refuses an unknown status', () => {
    const run = {
      id: '00000000-0000-4000-8000-000000000001',
      agentId: '00000000-0000-4000-8000-000000000002',
      version: 7,
      status: 'running',
      score: 0.01,
      passed: 1,
      total: 100,
      results: [
        { name: 'a', passed: true, runId: '00000000-0000-4000-8000-000000000003', failures: [] },
      ],
      createdAt: '2026-10-04T00:00:00.000Z',
    };
    expect(EvaluationRunResourceSchema.parse(run)).toEqual(run);
    expect(EvaluationRunResourceSchema.safeParse({ ...run, status: 'queued' }).success).toBe(false);
  });
});
