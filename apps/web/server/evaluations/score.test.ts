import { describe, expect, it } from 'vitest';

import { ORDER_STATUS_FRAMES } from './fixtures';
import { parseJudgeVerdict } from './judge';
import { checkCase, finalAnswer, score, toolCalls } from './score';

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
    expect(checkCase({ tool: 'lookup', toolInput }, '', calls)).toEqual(failures);
  });

  it.each([
    [{ id: 'c' }],
    [{ filter: { tags: ['x'] } }],
    [{ id: 'a', filter: { limit: 6 } }],
    [{ missing: null }],
  ])('names the arguments no call had: %j', (toolInput) => {
    expect(checkCase({ tool: 'lookup', toolInput }, '', calls)).toEqual([
      `toolInput: no call of lookup had ${JSON.stringify(toolInput)}`,
    ]);
  });

  it('reports a missing tool rather than missing arguments', () => {
    expect(checkCase({ tool: 'other', toolInput: { id: 'a' } }, '', calls)).toEqual([
      'tool: other was not called',
    ]);
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
    expect(checkCase(expectation, answer, tools)).toEqual(failures);
  });

  it('reports every failing check of the demo case at once', () => {
    expect(checkCase({ tool: 'orders_getOrder', contains: ['shipped'] }, answer, tools)).toEqual(
      [],
    );
    expect(checkCase({ tool: 'orders_getOrder', contains: ['shipped'] }, '', [])).toEqual([
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

describe('parseJudgeVerdict (issue #618)', () => {
  it.each([
    ['{"pass": true, "reason": "Polite."}', { kind: 'verdict', pass: true, reason: 'Polite.' }],
    [
      '{"pass": false, "reason": "Promised a refund."}',
      { kind: 'verdict', pass: false, reason: 'Promised a refund.' },
    ],
    [
      'Here is my verdict:\n```json\n{"pass": true, "reason": "Uses {braces} fine.", "score": 1}\n```',
      { kind: 'verdict', pass: true, reason: 'Uses {braces} fine.' },
    ],
    ['I think it passes.', { kind: 'invalid' }],
    ['{"pass": "yes", "reason": "x"}', { kind: 'invalid' }],
    ['{"pass": true', { kind: 'invalid' }],
    ['{"note": 1} {"pass": true, "reason": "ok"}', { kind: 'invalid' }],
  ])('%j', (text, verdict) => {
    expect(parseJudgeVerdict(text)).toEqual(verdict);
  });

  it('cuts a long reason', () => {
    const verdict = parseJudgeVerdict(JSON.stringify({ pass: true, reason: 'x'.repeat(900) }));
    expect(verdict.kind === 'verdict' && verdict.reason.length).toBe(500);
  });
});
