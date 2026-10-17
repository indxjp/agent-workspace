import assert from 'node:assert/strict';
import test from 'node:test';

import { renderSummary } from './summary.mjs';

const lane = (outcome) => ({ identity: { title: 'uid 1000', outcome }, later: { title: 'A4', outcome: 'pending' } });

test('a table with one column per lane, and pending and n/a are clean', () => {
  const { markdown, clean } = renderSummary({ docker: lane('pass'), kind: { ...lane('pass'), later: { title: 'A4', outcome: 'n/a' } } });
  assert.match(markdown, /^\| check \| docker \| kind \|$/mu);
  assert.match(markdown, /\| uid 1000 \(`identity`\) \| pass \| pass \|/u);
  assert.equal(clean, true);
});

test('a failed check, an inconclusive one and a missing lane are never clean', () => {
  assert.equal(renderSummary({ docker: lane('pass'), kind: lane('fail') }).clean, false);
  assert.equal(renderSummary({ docker: lane('inconclusive') }).clean, false);
  const missing = renderSummary({ docker: lane('pass'), kind: undefined });
  assert.equal(missing.clean, false);
  assert.match(missing.markdown, /\| uid 1000 \(`identity`\) \| pass \| missing \|/u);
});

test('a check absent from one lane reads as missing, not as a pass', () => {
  const { markdown, clean } = renderSummary({ docker: lane('pass'), kind: { identity: lane('pass').identity } });
  assert.match(markdown, /\(`later`\) \| pending \| missing \|/u);
  assert.equal(clean, false);
});
