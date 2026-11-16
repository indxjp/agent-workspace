// The Try tab's words and rules (spec "How Try it works"): what the sign-up form submits, which
// cap stopped the demo and in which words, and what the sign-in page does with its link.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  chatFallback,
  fallbackReasonOf,
  fallbackReasonText,
  gateSubmission,
  runStopText,
  signInStep,
} from '../app/agents/[slug]/try/messages.ts';
import { afterSignInPath, parseLinkFragment } from '../app/sign-in/fragment.ts';

const ok = { email: 'a@example.com', consent: true, challenge: 'tok', slug: 'crm-sales' };
const TOKEN = 'a'.repeat(43);

test('the sign-up form sends nothing without an address or a tick', () => {
  for (const lang of ['ja', 'en'] as const) {
    assert.ok('error' in gateSubmission({ ...ok, email: '' }, lang));
    assert.ok('error' in gateSubmission({ ...ok, consent: false }, lang));
  }
});

test('the sign-up form sends exactly the email, the consent, the challenge and the entry', () => {
  assert.deepEqual(gateSubmission(ok, 'en'), {
    body: { email: 'a@example.com', consent: true, challenge: 'tok', entry: 'crm-sales' },
  });
});

test('a start refusal and a run stop are told apart, in their own words', () => {
  assert.deepEqual(fallbackReasonOf({ code: 'demo_person_runs_reached' }), {
    reason: 'count',
    scope: 'start',
  });
  assert.deepEqual(fallbackReasonOf({ stopReason: 'max_turns' }), {
    reason: 'count',
    scope: 'run',
  });
  assert.equal(fallbackReasonOf({ stopReason: 'end_turn' }), null);
  assert.notEqual(runStopText('count', 'en'), fallbackReasonText('count', 'en'));
  assert.notEqual(runStopText('cost', 'en'), fallbackReasonText('cost', 'en'));
});

test('a run stop falls back only once the platform says no runs are left', () => {
  const allowance = { runsPerDay: 20, runsLeft: 3, expiresAt: '2026-11-17T03:00:00.000Z' };
  assert.equal(chatFallback(null, true, allowance), null);
  assert.equal(chatFallback(null, true, { ...allowance, runsLeft: 0 }), 'count');
  assert.equal(chatFallback('cost', false, allowance), 'cost');
});

test('the sign-in link is read from the fragment, and the way back is the entry Try tab', () => {
  assert.ok('failed' in signInStep('', 'en'));
  const step = signInStep(`#token=${TOKEN}&email=a%40example.com&entry=crm-sales`, 'en');
  assert.ok('request' in step);
  assert.equal(parseLinkFragment('#token=short'), null);
  assert.equal(afterSignInPath('crm-sales'), '/agents/crm-sales#try');
  assert.equal(afterSignInPath(undefined), '/');
});
