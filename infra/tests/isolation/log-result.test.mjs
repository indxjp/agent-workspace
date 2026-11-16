import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { pickResult } from './log-result.mjs';

const nonce = '9876543210-2-probe-0123456789abcdef';
const line = (payload) => `AW_ISOLATION_RESULT ${JSON.stringify(payload)}`;
const fresh = { mode: 'probe', results: { 'egress-internet': { outcome: 'fail' } }, nonce };
const stale = { mode: 'probe', results: { 'egress-internet': { outcome: 'pass' } }, nonce: '9876543210-1-probe-fedcba9876543210' };

test('only the line with the expected nonce is read, even after a newer stale line', () => {
  // Newest first, as `--order=desc` prints them: a stale pass ingested before the fresh fail.
  const text = [line(stale), line(fresh), line({ ...fresh, mode: 'token' })].join('\n');
  assert.deepEqual(pickResult(text, { mode: 'probe', nonce }), fresh);
});

test('a stale line alone, or a line without a nonce, is no result', () => {
  assert.equal(pickResult(line(stale), { mode: 'probe', nonce }), undefined);
  const { nonce: _omitted, ...withoutNonce } = fresh;
  assert.equal(pickResult(line(withoutNonce), { mode: 'probe', nonce }), undefined);
  assert.equal(pickResult(line({ ...fresh, nonce: '' }), { mode: 'probe', nonce }), undefined);
});

test('the mode must match too, and junk lines are skipped', () => {
  const text = ['', 'AW_ISOLATION_RESULT {not json', 'other output', line({ ...fresh, mode: 'create' }), line([1])].join('\n');
  assert.equal(pickResult(text, { mode: 'probe', nonce }), undefined);
});

test('a repeated identical line is one result; two different lines with one nonce are an error', () => {
  assert.deepEqual(pickResult([line(fresh), line(fresh)].join('\n'), { mode: 'probe', nonce }), fresh);
  const twin = { ...fresh, results: {} };
  assert.throws(() => pickResult([line(fresh), line(twin)].join('\n'), { mode: 'probe', nonce }), /same nonce/u);
});

test('a missing or malformed expected nonce, or an unknown mode, is an error', () => {
  for (const bad of ['', 'short', 'has space in it 0123456789', '-leading-dash-0123456789']) {
    assert.throws(() => pickResult(line({ ...fresh, nonce: bad }), { mode: 'probe', nonce: bad }), /nonce/u);
  }
  assert.throws(() => pickResult(line(fresh), { mode: 'other', nonce }), /mode/u);
});

test('the command prints the payload, exits 1 without a match and 2 on a bad nonce', () => {
  const script = fileURLToPath(new URL('./log-result.mjs', import.meta.url));
  const run = (input, args) => spawnSync(process.execPath, [script, ...args], { input, encoding: 'utf8' });
  const hit = run([line(stale), line(fresh)].join('\n'), ['probe', nonce]);
  assert.equal(hit.status, 0);
  assert.deepEqual(JSON.parse(hit.stdout), fresh);
  const miss = run(line(stale), ['probe', nonce]);
  assert.equal(miss.status, 1);
  assert.equal(miss.stdout, '');
  assert.equal(run(line(fresh), ['probe', '']).status, 2);
});

test('the proxy and tool modes are known modes', () => {
  for (const mode of ['proxy-restricted', 'proxy-open', 'tool-open', 'tool-call', 'tool-close']) {
    const payload = { mode, results: {}, nonce };
    assert.deepEqual(pickResult(line(payload), { mode, nonce }), payload);
  }
});

test('a tool result line of another mode or another nonce is not accepted', () => {
  const payload = { mode: 'tool-call', results: {}, nonce };
  assert.equal(pickResult(line(payload), { mode: 'tool-open', nonce }), undefined);
  assert.equal(pickResult(line({ ...payload, nonce: 'other-nonce-0123456789' }), { mode: 'tool-call', nonce }), undefined);
});
