import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIMIT, countChangedLines, evaluate, findJustification } from './check-pr-size.mjs';

/** @param {...[number | string, number | string, string]} rows */
const stat = (...rows) => rows.map(([a, d, p]) => `${a}\t${d}\t${p}\0`).join('');

test('counts added plus deleted, skips generated paths and binaries', () => {
  const n = stat([10, 5, 'a.ts'], [9000, 1, 'pnpm-lock.yaml'], ['-', '-', 'x.png']);
  assert.equal(
    countChangedLines(n, (p) => p === 'pnpm-lock.yaml'),
    15,
  );
});

test('paths containing tabs are kept whole', () => {
  assert.equal(
    countChangedLines(stat([1, 1, 'a\tb.ts']), () => false),
    2,
  );
});

test('at the limit passes, above it needs a real justification', () => {
  assert.equal(evaluate(LIMIT, '').ok, true);
  assert.equal(evaluate(LIMIT + 1, '').ok, false);
  assert.equal(evaluate(LIMIT + 1, 'Large PR justification: <why>').ok, false);
  assert.equal(evaluate(LIMIT + 1, 'Large PR justification:   \n').ok, false);
  assert.equal(evaluate(LIMIT + 1, 'x\nLarge PR justification: one mechanical rename\n').ok, true);
});

test('justification must start the line', () => {
  assert.equal(findJustification('see Large PR justification: nope nope nope'), null);
});
