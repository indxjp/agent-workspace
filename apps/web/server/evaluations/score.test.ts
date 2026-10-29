import { canonicalCall } from '@indx-workspace/contracts/agents';
import { describe, expect, it } from 'vitest';

import { ORDER_STATUS_FRAMES } from './fixtures';
import { checkCase, finalAnswer, pausedCall, score, toolCalls } from './score';

const answer = finalAnswer(ORDER_STATUS_FRAMES);
const tools = toolCalls(ORDER_STATUS_FRAMES);

describe('finalAnswer and toolCalls (issue #618)', () => {
  it('reads the last assistant text and every tool call', () => {
    expect(answer).toBe('Order 1042 has shipped.');
    expect(tools).toEqual([{ name: 'orders_getOrder', input: { orderNumber: '1042' } }]);
  });

  it('reads an empty answer from a run that said nothing', () => {
    expect(finalAnswer([])).toBe('');
    expect(toolCalls([])).toEqual([]);
  });
});

describe('pausedCall (issue #1569)', () => {
  it('reads the name and the input of the call a run paused on', () => {
    const input = { file_path: 'outputs/plan.json', content: '{}' };
    expect(pausedCall({ toolName: 'Write', canonicalCall: canonicalCall('Write', input) })).toEqual(
      [{ name: 'Write', input }],
    );
  });

  it('keeps the name when the call text is not a canonical call, and is empty without a pause', () => {
    expect(pausedCall({ toolName: 'Write', canonicalCall: 'not json' })).toEqual([
      { name: 'Write', input: undefined },
    ]);
    expect(pausedCall({ toolName: 'Write', canonicalCall: '[1]' })).toEqual([
      { name: 'Write', input: undefined },
    ]);
    expect(pausedCall(null)).toEqual([]);
    expect(pausedCall(undefined)).toEqual([]);
  });
});

describe('checkCase toolInput (issue #799)', () => {
  const calls = [
    { name: 'lookup', input: { id: 'a', filter: { tags: ['x', 'y'], limit: 5 } } },
    { name: 'lookup', input: { id: 'b' } },
  ];
  it.each([
    [{ id: 'b' }, []],
    [{ id: 'a', filter: { limit: 5 } }, []],
    [{ filter: { tags: ['x', 'y'] } }, []],
    [{}, []],
  ])('matches a call that contains %j', (toolInput, failures) => {
    expect(checkCase({ tool: 'lookup', toolInput }, '', calls, null)).toEqual(failures);
  });

  it.each([
    [{ id: 'c' }],
    [{ filter: { tags: ['x'] } }],
    [{ id: 'a', filter: { limit: 6 } }],
    [{ missing: null }],
  ])('names the arguments no call had: %j', (toolInput) => {
    expect(checkCase({ tool: 'lookup', toolInput }, '', calls, null)).toEqual([
      `toolInput: no call of lookup had ${JSON.stringify(toolInput)}`,
    ]);
  });

  it('reports a missing tool rather than missing arguments', () => {
    expect(checkCase({ tool: 'other', toolInput: { id: 'a' } }, '', calls, null)).toEqual([
      'tool: other was not called',
    ]);
  });
});

describe('checkCase output (issue #1289)', () => {
  const structured = { width: 140, height: 90, holes: [{ x: 1 }, { x: 2 }], note: 'extra' };
  const check = (output: Record<string, unknown>, actual: unknown = structured) =>
    checkCase({ output }, '', [], actual);

  it.each([[{ width: 140, height: 90 }], [{ holes: [{ x: 1 }, { x: 2 }] }], [{}]])(
    'passes when the structured output contains %j',
    (output) => {
      expect(check(output)).toEqual([]);
    },
  );

  it.each([
    [{ width: 141 }],
    [{ depth: 1 }],
    [{ holes: [{ x: 2 }, { x: 1 }] }],
    [{ holes: [{ x: 1 }] }],
  ])('names the output the structured output did not have: %j', (output) => {
    expect(check(output)).toEqual([
      `output: the structured output did not have ${JSON.stringify(output)}`,
    ]);
  });

  it('fails when the run has no structured output', () => {
    expect(check({ width: 140 }, null)).toEqual([
      'output: the structured output did not have {"width":140}',
    ]);
  });

  it('checks nothing when no output is expected', () => {
    expect(checkCase({ contains: ['shipped'] }, answer, tools, structured)).toEqual([]);
  });
});

describe('checkCase (issue #618)', () => {
  it.each([
    [{ contains: ['shipped'] }, []],
    [{ contains: ['Shipped'] }, ['contains: "Shipped" is not in the answer']],
    [{ notContains: ['refund'] }, []],
    [{ notContains: ['shipped'] }, ['notContains: "shipped" is in the answer']],
    [{ tool: 'orders_getOrder' }, []],
    [{ tool: 'orders_refund' }, ['tool: orders_refund was not called']],
    [{ judge: 'polite' }, []],
  ])('%j → %j', (expectation, failures) => {
    expect(checkCase(expectation, answer, tools, null)).toEqual(failures);
  });

  it('reports every failing check of the demo case at once', () => {
    expect(
      checkCase({ tool: 'orders_getOrder', contains: ['shipped'] }, answer, tools, null),
    ).toEqual([]);
    expect(checkCase({ tool: 'orders_getOrder', contains: ['shipped'] }, '', [], null)).toEqual([
      'contains: "shipped" is not in the answer',
      'tool: orders_getOrder was not called',
    ]);
  });
});

describe('score (issue #618)', () => {
  it('is passed over total', () => {
    const results = Array.from({ length: 10 }, (_, index) => ({ passed: index !== 3 }));
    expect(score(results)).toEqual({ score: 0.9, passed: 9, total: 10 });
  });

  it('rounds to 4 decimals, as the row stores it', () => {
    const results = [{ passed: true }, { passed: false }, { passed: false }];
    expect(score(results)).toEqual({ score: 0.3333, passed: 1, total: 3 });
  });
});
