/** The Install & customize tab's logic and the refusal messages (the claims of /platform are in claims.test.ts). */
import { STORE_ENQUIRY_SETUP_MAX_LENGTH } from '@indx-workspace/contracts/email-link';

import { describe, expect, it } from 'vitest';

import {
  choicesOf,
  defaultSetup,
  enquiryHref,
  parseSetup,
  previewOf,
  setupSummary,
  setupToEnquiry,
} from '../../examples/store/app/customize.ts';
import { demoHoursText, refusalMessage, retentionText } from '../../examples/store/app/messages.ts';
import { entryView, FEATURED, type LiveEntry } from '../../examples/store/catalog/index.ts';

const entry = FEATURED;

describe('the customize preview', () => {
  it('offers every control the entry lists, and the entry’s own systems as choices', () => {
    const setup = defaultSetup(entry, 'en');
    expect(Object.keys(setup).sort()).toEqual([...entryView(entry).customize].sort());
    expect(choicesOf(entry, 'connection')?.map((choice) => choice.value)).toEqual([
      ...entryView(entry).connects,
    ]);
    expect(choicesOf(entry, 'companyName')).toBeNull();
  });

  it('changes the reply and the facts when the visitor changes the setup', () => {
    const base = defaultSetup(entry, 'en');
    const before = previewOf(entry, base, 'en');
    const after = previewOf(
      entry,
      { ...base, companyName: 'Acme KK', tone: 'brief', language: 'ja' },
      'en',
    );
    expect(before.reply).not.toBe(after.reply);
    expect(after.reply).toContain('Acme KK');
    expect(after.facts.find((fact) => fact.control === 'companyName')?.value).toBe('Acme KK');
  });

  it('leaves out a control the entry does not offer', () => {
    const narrow = { ...entry, customize: ['companyName'] } as LiveEntry;
    expect(previewOf(narrow, { companyName: 'A', tone: 'brief' }, 'en').facts).toHaveLength(1);
    expect(setupToEnquiry(narrow, { companyName: 'A', tone: 'brief' })).toEqual({
      companyName: 'A',
    });
  });

  it('carries entry and setup to the enquiry form and reads them back, dropping the rest', () => {
    const setup = { companyName: 'Acme KK', tone: 'brief' };
    const href = enquiryHref(entry, setup);
    const query = new URL(href, 'http://x').searchParams;
    expect(href.startsWith('/contact?')).toBe(true);
    expect(query.get('entry')).toBe(entry.slug);
    expect(parseSetup(entry, query.get('setup') ?? undefined)).toEqual(setup);
    const offered = entryView(entry).customize;
    expect(offered).not.toContain('evil');
    expect(parseSetup(entry, '{"companyName":"A","evil":"x","tone":3}')).toBeUndefined();
    expect(parseSetup(entry, '{"companyName":"A","evil":"x"}')).toEqual({ companyName: 'A' });
    const tooLong = JSON.stringify({ companyName: 'x'.repeat(STORE_ENQUIRY_SETUP_MAX_LENGTH + 1) });
    expect(parseSetup(entry, tooLong)).toBeUndefined();
    expect(parseSetup(entry, 'not json')).toBeUndefined();
    expect(parseSetup(entry, '[]')).toBeUndefined();
    expect(parseSetup(entry, undefined)).toBeUndefined();
    expect(setupSummary(entry, setup, 'en')).toEqual(['Company name: Acme KK', 'Tone: Brief']);
  });

  it('bounds a long value', () => {
    expect(setupToEnquiry(entry, { companyName: 'x'.repeat(500) })['companyName']).toHaveLength(
      STORE_ENQUIRY_SETUP_MAX_LENGTH,
    );
  });
});

describe('the refusal messages', () => {
  const refusal = (status: number, code: string, retryAfterSeconds: number | null = null) => ({
    status,
    code,
    retryAfterSeconds,
  });

  it('says "not available yet" for a 503 and for a platform that cannot be reached', () => {
    for (const lang of ['ja', 'en'] as const) {
      const unavailable = refusalMessage(refusal(503, 'store_lead_unavailable'), lang);
      expect(refusalMessage(refusal(0, 'platform_unreachable'), lang)).toBe(
        refusalMessage(refusal(503, 'email_link_unavailable'), lang),
      );
      expect(unavailable.length).toBeGreaterThan(0);
    }
    expect(refusalMessage(refusal(503, 'store_lead_unavailable'), 'en')).toContain(
      'not available yet',
    );
  });

  it('gives each lead refusal its own words in both languages and never echoes the code', () => {
    const codes = ['invalid_body', 'store_lead_challenge_failed', 'store_lead_rate_limited'];
    const english = codes.map((code) => refusalMessage(refusal(400, code), 'en'));
    expect(new Set(english).size).toBe(codes.length);
    for (const code of codes) {
      expect(refusalMessage(refusal(400, code), 'ja')).not.toMatch(/[a-z]_[a-z]/u);
    }
    expect(refusalMessage(refusal(429, 'store_lead_rate_limited', 30), 'en')).toContain('30');
    expect(refusalMessage(refusal(418, 'something_else'), 'en')).toContain('try again');
  });
});

describe('the privacy facts', () => {
  it('says the period is to be set while it is null, and states it once it is configured', () => {
    expect(retentionText({ leadRetentionDays: null, demoWorkspaceHours: 24 }, 'en')).toContain(
      'to be set',
    );
    expect(retentionText({ leadRetentionDays: null, demoWorkspaceHours: 24 }, 'ja')).toContain(
      '未定',
    );
    expect(retentionText({ leadRetentionDays: 90, demoWorkspaceHours: 24 }, 'en')).toContain(
      '90 days',
    );
    expect(retentionText(null, 'en')).toContain('not available');
    expect(demoHoursText({ leadRetentionDays: null, demoWorkspaceHours: 24 }, 'en')).toBe(
      '24 hours',
    );
  });
});
