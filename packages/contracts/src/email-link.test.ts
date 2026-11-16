import { describe, expect, it } from 'vitest';

import {
  DEMO_WORKSPACE_LIFETIME_SECONDS,
  EMAIL_LINK_PROBLEM_CODES,
  EMAIL_LINK_TTL_SECONDS,
  EmailLinkIssuedResponseSchema,
  EmailLinkRequestSchema,
  EmailLinkVerifiedResponseSchema,
  EmailLinkVerifyRequestSchema,
  STORE_LEAD_PROBLEM_CODES,
  StoreLeadReceivedResponseSchema,
  StoreLeadRequestSchema,
} from './email-link.js';

const TOKEN = 'a'.repeat(43);
const CHALLENGE = 'challenge-answer';

describe('the email-link limits', () => {
  it('pins a fifteen-minute link and a twenty-four-hour demo workspace', () => {
    expect(EMAIL_LINK_TTL_SECONDS).toBe(900);
    expect(DEMO_WORKSPACE_LIFETIME_SECONDS).toBe(86_400);
  });

  it('pins each refusal to its status', () => {
    expect(EMAIL_LINK_PROBLEM_CODES).toEqual({
      invalid_body: 400,
      email_link_invalid: 400,
      email_link_challenge_failed: 403,
      demo_entry_unavailable: 404,
      email_link_address_refused: 422,
      email_link_rate_limited: 429,
      email_link_unavailable: 503,
    });
  });
});

describe('EmailLinkRequestSchema', () => {
  it('trims and lower-cases the address, and carries the consent, the challenge and the entry', () => {
    expect(
      EmailLinkRequestSchema.parse({
        email: '  Visitor@Example.COM ',
        consent: true,
        challenge: CHALLENGE,
      }),
    ).toEqual({ email: 'visitor@example.com', consent: true, challenge: CHALLENGE });
    expect(
      EmailLinkRequestSchema.parse({
        email: 'v@example.com',
        consent: true,
        challenge: CHALLENGE,
        entry: 'ringi-review',
      }),
    ).toEqual({
      email: 'v@example.com',
      consent: true,
      challenge: CHALLENGE,
      entry: 'ringi-review',
    });
  });

  it("refuses a request without the visitor's consent", () => {
    for (const consent of [undefined, false, 'true', 1]) {
      const body = { email: 'visitor@example.com', consent, challenge: CHALLENGE };
      expect(EmailLinkRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('refuses a non-address, an over-long address, a missing or over-long challenge, a bad entry and an extra field', () => {
    const base = { consent: true } as const;
    for (const body of [
      { ...base, email: 'no-at-sign', challenge: CHALLENGE },
      { ...base, email: 'a b@example.com', challenge: CHALLENGE },
      { ...base, email: `${'a'.repeat(320)}@example.com`, challenge: CHALLENGE },
      { ...base, email: 'visitor@example.com', challenge: CHALLENGE, role: 'owner' },
      { ...base, email: 'visitor@example.com' },
      { ...base, email: 'visitor@example.com', challenge: '' },
      { ...base, email: 'visitor@example.com', challenge: 'x'.repeat(4097) },
      { ...base, email: 'visitor@example.com', challenge: CHALLENGE, entry: 'Not A Slug' },
      {},
    ]) {
      expect(EmailLinkRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('EmailLinkVerifyRequestSchema', () => {
  it('takes the address and a 43-character base64url secret, and nothing else', () => {
    expect(
      EmailLinkVerifyRequestSchema.safeParse({ email: 'v@example.com', token: TOKEN }).success,
    ).toBe(true);
    expect(
      EmailLinkVerifyRequestSchema.safeParse({
        email: 'v@example.com',
        token: TOKEN,
        entry: 'ringi-review',
      }).success,
    ).toBe(true);
    expect(
      EmailLinkVerifyRequestSchema.safeParse({ email: 'v@example.com', token: TOKEN, entry: '' })
        .success,
    ).toBe(false);
    for (const token of ['', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}=`]) {
      expect(
        EmailLinkVerifyRequestSchema.safeParse({ email: 'v@example.com', token }).success,
        token,
      ).toBe(false);
    }
  });
});

describe('the responses', () => {
  it('answer an issue with one body whatever the address', () => {
    expect(EmailLinkIssuedResponseSchema.parse({ status: 'sent' })).toEqual({ status: 'sent' });
    expect(EmailLinkIssuedResponseSchema.safeParse({ status: 'sent', known: true }).success).toBe(
      false,
    );
  });

  it('answer a verify with the guest role and nothing wider', () => {
    const body = {
      workspaceId: '00000000-0000-4000-8000-000000000001',
      workspaceSlug: 'demo-1',
      role: 'guest',
      created: true,
    };
    expect(EmailLinkVerifiedResponseSchema.safeParse(body).success).toBe(true);
    expect(EmailLinkVerifiedResponseSchema.safeParse({ ...body, role: 'viewer' }).success).toBe(
      false,
    );
  });
});

describe('the store lead request', () => {
  const visitor = { email: '  Visitor@Example.COM ', consent: true, challenge: 'answer' } as const;

  it('takes an enquiry with an optional entry and Customize setup', () => {
    expect(
      StoreLeadRequestSchema.parse({
        ...visitor,
        kind: 'enquiry',
        message: ' We have 40 sales staff. ',
        entry: 'crm-sales',
        setup: { companyName: 'Kitano Seiki', approvalRule: '500000' },
      }),
    ).toEqual({
      kind: 'enquiry',
      email: 'visitor@example.com',
      consent: true,
      challenge: 'answer',
      message: 'We have 40 sales staff.',
      entry: 'crm-sales',
      setup: { companyName: 'Kitano Seiki', approvalRule: '500000' },
    });
  });

  it('takes a launch notice for one entry', () => {
    expect(
      StoreLeadRequestSchema.parse({ ...visitor, kind: 'launch_notice', entry: 'nda' }),
    ).toEqual({
      kind: 'launch_notice',
      email: 'visitor@example.com',
      consent: true,
      challenge: 'answer',
      entry: 'nda',
    });
  });

  it('refuses a lead without consent, a challenge, a message or an entry, and an extra field', () => {
    for (const body of [
      { ...visitor, consent: false, kind: 'enquiry', message: 'hello' },
      { email: visitor.email, challenge: 'answer', kind: 'enquiry', message: 'hello' },
      { ...visitor, challenge: '', kind: 'enquiry', message: 'hello' },
      { ...visitor, kind: 'enquiry', message: '   ' },
      { ...visitor, kind: 'enquiry', message: 'x'.repeat(2001) },
      { ...visitor, kind: 'launch_notice' },
      { ...visitor, kind: 'launch_notice', entry: 'Not A Slug' },
      { ...visitor, kind: 'enquiry', message: 'hello', role: 'owner' },
      { ...visitor, kind: 'enquiry', message: 'hello', setup: { 'not a name': 'x' } },
      { ...visitor, kind: 'enquiry', message: 'hello', setup: { companyName: 'x'.repeat(201) } },
      {
        ...visitor,
        kind: 'enquiry',
        message: 'hello',
        setup: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`c${'x'.repeat(i)}`, 'v'])),
      },
      { ...visitor, kind: 'subscribe', entry: 'nda' },
    ]) {
      expect(StoreLeadRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('answers the same body for any address, and pins each refusal to its status', () => {
    expect(StoreLeadReceivedResponseSchema.parse({ status: 'received' })).toEqual({
      status: 'received',
    });
    expect(STORE_LEAD_PROBLEM_CODES).toEqual({
      invalid_body: 400,
      store_lead_challenge_failed: 403,
      store_lead_rate_limited: 429,
      store_lead_unavailable: 503,
    });
  });
});
