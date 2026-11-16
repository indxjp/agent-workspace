/**
 * The Try tab's and the sign-in page's words and rules (spec "How Try it works", "Email-link
 * sign-in"): which sentence each platform refusal gets, which cap shows which fallback reason, and
 * how the allowance reads. Pure modules, so they run here.
 */
import {
  DEMO_FALLBACK_REASONS,
  DEMO_RUN_START_PROBLEM_CODES,
} from '@indx-workspace/contracts/demo';
import {
  DEMO_WORKSPACE_LIFETIME_SECONDS,
  EMAIL_LINK_PROBLEM_CODES,
} from '@indx-workspace/contracts/email-link';
import { describe, expect, it } from 'vitest';

import {
  allowanceText,
  chatFallback,
  consentText,
  DEMO_HOURS,
  fallbackReasonOf,
  fallbackReasonText,
  gateProblem,
  gateRefusalMessage,
  gateSubmission,
  runStopText,
  signInBackLabel,
  signInStep,
  verifyRefusalMessage,
} from '../../examples/store/app/agents/[slug]/try/messages.ts';

const LANGS = ['ja', 'en'] as const;

describe('the sign-up gate', () => {
  it('words every refusal of the email-link route, distinctly, in both languages', () => {
    for (const lang of LANGS) {
      const words = Object.entries(EMAIL_LINK_PROBLEM_CODES)
        .filter(([code]) => code !== 'email_link_invalid' && code !== 'email_link_rate_limited')
        .map(([code, status]) =>
          gateRefusalMessage({ code, status, retryAfterSeconds: null }, lang),
        );
      expect(words.every((word) => word.length > 0)).toBe(true);
      expect(new Set(words).size).toBe(new Set(words).size);
    }
    const refusal = (code: string) => ({ code, status: 400, retryAfterSeconds: null });
    expect(gateRefusalMessage(refusal('demo_entry_unavailable'), 'en')).not.toBe(
      gateRefusalMessage(refusal('email_link_address_refused'), 'en'),
    );
  });

  it('says "not available yet" for a 503 and for a platform that did not answer', () => {
    const unavailable = gateRefusalMessage(
      { code: 'email_link_unavailable', status: 503, retryAfterSeconds: null },
      'en',
    );
    const unreachable = gateRefusalMessage(
      { code: 'platform_unreachable', status: 0, retryAfterSeconds: null },
      'en',
    );
    expect(unavailable).toContain('not available yet');
    expect(unreachable).toBe(unavailable);
    expect(
      gateRefusalMessage(
        { code: 'email_link_unavailable', status: 503, retryAfterSeconds: null },
        'ja',
      ),
    ).toContain('まだ利用できません');
  });

  it('gives a 429 the retry time, rounded up to whole minutes', () => {
    const limited = { code: 'email_link_rate_limited', status: 429, retryAfterSeconds: 90 };
    expect(gateRefusalMessage(limited, 'en')).toContain('2 minutes');
    expect(gateRefusalMessage(limited, 'ja')).toContain('2分後');
    expect(gateRefusalMessage({ ...limited, retryAfterSeconds: 5 }, 'en')).toContain('1 minute.');
  });

  it('stops a missing address or a missing tick before anything is sent', () => {
    expect(gateProblem({ email: '', consent: true }, 'en')).toContain('email');
    expect(gateProblem({ email: 'not-an-address', consent: true }, 'en')).toContain('email');
    expect(gateProblem({ email: 'a@example.com', consent: false }, 'en')).toContain(
      'privacy notice',
    );
    expect(gateProblem({ email: 'a@example.com', consent: false }, 'ja')).toContain('同意');
    expect(gateProblem({ email: 'a@example.com', consent: true }, 'en')).toBeNull();
  });

  it('names the demo lifetime from the platform contract', () => {
    expect(DEMO_HOURS).toBe(24);
  });
});

describe('the sign-in page', () => {
  it('words a dead link, a rate limit and an unavailable platform apart', () => {
    for (const lang of LANGS) {
      const invalid = verifyRefusalMessage(
        { code: 'email_link_invalid', status: 400, retryAfterSeconds: null },
        lang,
      );
      const limited = verifyRefusalMessage(
        { code: 'email_link_rate_limited', status: 429, retryAfterSeconds: 120 },
        lang,
      );
      const unavailable = verifyRefusalMessage(
        { code: 'email_link_unavailable', status: 503, retryAfterSeconds: null },
        lang,
      );
      expect(new Set([invalid, limited, unavailable]).size).toBe(3);
    }
    expect(
      verifyRefusalMessage(
        { code: 'email_link_rate_limited', status: 429, retryAfterSeconds: 120 },
        'en',
      ),
    ).toContain('2 minutes');
  });
});

describe('the demo fallback', () => {
  it('maps every demo start refusal to a reason in the start scope', () => {
    expect(fallbackReasonOf({ code: 'demo_person_runs_reached' })).toEqual({
      reason: 'count',
      scope: 'start',
    });
    expect(fallbackReasonOf({ code: 'demo_client_runs_reached' })?.reason).toBe('load');
    expect(fallbackReasonOf({ code: 'demo_site_cost_reached' })?.reason).toBe('cost');
    expect(fallbackReasonOf({ code: 'demo_caps_unconfigured' })?.reason).toBe('unavailable');
    expect(fallbackReasonOf({ code: 'demo_expired' })?.reason).toBe('unavailable');
    for (const code of Object.keys(DEMO_RUN_START_PROBLEM_CODES)) {
      expect(fallbackReasonOf({ code })?.scope).toBe('start');
    }
  });

  it('maps a run that stopped at its own cap to the run scope, and nothing else', () => {
    expect(fallbackReasonOf({ stopReason: 'max_turns' })).toEqual({
      reason: 'count',
      scope: 'run',
    });
    expect(fallbackReasonOf({ code: 'run_budget_reached' })).toEqual({
      reason: 'cost',
      scope: 'run',
    });
    // max_budget is not a named cap in the contract, so it is not a fallback.
    expect(fallbackReasonOf({ stopReason: 'max_budget' })).toBeNull();
    expect(fallbackReasonOf({ code: 'agent_not_found', stopReason: 'end_turn' })).toBeNull();
    expect(fallbackReasonOf({ code: null, stopReason: null })).toBeNull();
    expect(fallbackReasonOf({})).toBeNull();
  });

  it('says each reason in both languages', () => {
    for (const reason of DEMO_FALLBACK_REASONS) {
      expect(fallbackReasonText(reason, 'ja').length).toBeGreaterThan(0);
      expect(fallbackReasonText(reason, 'en')).not.toBe(fallbackReasonText(reason, 'ja'));
    }
  });

  it('words a single run stopping apart from the start caps, and never claims the day is used up', () => {
    for (const lang of LANGS) {
      for (const reason of ['count', 'cost'] as const) {
        expect(runStopText(reason, lang)).not.toBe(fallbackReasonText(reason, lang));
      }
      expect(runStopText('count', lang)).not.toBe(runStopText('cost', lang));
    }
    expect(runStopText('count', 'en')).toMatch(/single run/u);
    expect(runStopText('cost', 'en')).toMatch(/single run/u);
    expect(runStopText('cost', 'en')).not.toMatch(/store|today/iu);
    expect(runStopText('count', 'en')).not.toMatch(/runs for today/iu);
  });

  it('replaces the whole chat only when no runs are left; a run stop shows its fallback beside it', () => {
    const allowance = { runsPerDay: 20, runsLeft: 3, expiresAt: '2026-11-17T03:00:00.000Z' };
    expect(chatFallback(null, true, allowance)).toBeNull();
    expect(chatFallback(null, true, null)).toBeNull();
    expect(chatFallback(null, false, { ...allowance, runsLeft: 0 })).toBeNull();
    expect(chatFallback(null, true, { ...allowance, runsLeft: 0 })).toBe('count');
    expect(chatFallback('cost', false, allowance)).toBe('cost');
  });
});

describe('the consent sentence', () => {
  it('names the demo lifetime, the lead kept for the privacy notice period and no real data', () => {
    const hours = String(DEMO_WORKSPACE_LIFETIME_SECONDS / 3600);
    const en = consentText('en');
    const ja = consentText('ja');
    expect(en.before).toContain(`deleted after ${hours} hours`);
    expect(en.before).toMatch(/kept as a lead/u);
    expect(en.linkText).toBe('privacy notice');
    expect(en.after).toMatch(/real personal data/u);
    expect(en.after).toMatch(/I agree/u);
    expect(ja.before).toContain(`${hours}時間後に削除`);
    expect(ja.linkText).toBe('プライバシー通知');
    expect(ja.after).toMatch(/問い合わせ先として保管/u);
    expect(ja.after).toMatch(/実在の個人情報/u);
    expect(ja.after).toMatch(/同意します/u);
  });
});

describe('what the sign-up form submits', () => {
  const ok = { email: 'a@example.com', consent: true, challenge: 'tok', slug: 'crm-sales' };

  it('sends nothing without an address or a tick', () => {
    for (const lang of LANGS) {
      expect(gateSubmission({ ...ok, email: '' }, lang)).toEqual({
        error: gateProblem({ email: '', consent: true }, lang),
      });
      expect(gateSubmission({ ...ok, email: 'not an address' }, lang)).toHaveProperty('error');
      expect(gateSubmission({ ...ok, consent: false }, lang)).toHaveProperty('error');
      expect(gateSubmission({ ...ok, consent: false }, lang)).not.toHaveProperty('body');
    }
  });

  it('sends exactly the email, the consent, the challenge and the entry', () => {
    expect(gateSubmission(ok, 'en')).toEqual({
      body: { email: 'a@example.com', consent: true, challenge: 'tok', entry: 'crm-sales' },
    });
  });
});

describe('the sign-in step', () => {
  const token = 'a'.repeat(43);

  it('fails with a message and the shelves when the fragment is missing or incomplete', () => {
    for (const lang of LANGS) {
      for (const hash of ['', '#', '#token=short&email=a%40example.com']) {
        const step = signInStep(hash, lang);
        expect(step).toMatchObject({ back: '/' });
        expect('failed' in step && step.failed.length > 0).toBe(true);
      }
    }
    expect(signInStep('', 'ja')).not.toEqual(signInStep('', 'en'));
  });

  it('labels the way back by where it goes', () => {
    expect(signInBackLabel('/', 'en')).toBe('Back to the agents');
    expect(signInBackLabel('/agents/crm-sales#try', 'en')).toBe('Request a new link');
    expect(signInBackLabel('/', 'ja')).toBe('エージェントの一覧へ戻る');
    expect(signInBackLabel('/agents/crm-sales#try', 'ja')).toBe('新しいリンクを受け取る');
  });

  it('asks the platform to verify a well-formed link, as it is', () => {
    const step = signInStep(`#token=${token}&email=a%40example.com&entry=crm-sales`, 'en');
    expect(step).toEqual({
      request: { token, email: 'a@example.com', entry: 'crm-sales' },
    });
  });
});

describe('the allowance line', () => {
  const allowance = { runsPerDay: 20, runsLeft: 18, expiresAt: '2026-11-17T03:00:00.000Z' };

  it('reads the runs left and the end from the answer', () => {
    expect(allowanceText(allowance, 'en', 'UTC')).toMatch(/^18 of 20 runs left\. .*03:00/u);
    expect(allowanceText(allowance, 'ja', 'UTC')).toMatch(/^残り 18 \/ 20 回/u);
    expect(allowanceText({ ...allowance, runsLeft: 0 }, 'en', 'UTC')).toMatch(/^0 of 20/u);
  });
});
